import type { StorageStatus, Tag, TagValueUpdate } from '@iotconnector/shared';

export interface TDengineConfig {
  /** taosAdapter REST 地址，如 http://127.0.0.1:6041；未配置则禁用写入管道 */
  url?: string;
  user: string;
  password: string;
  database: string;
  superTable: string;
}

function escTag(s: string): string {
  return s.replace(/[",\s\\]/g, '_').replace(/'/g, "\\'");
}

/** 位号名 → 合法且稳定的子表名（tb_ + FNV-1a hash 前 10 位） */
function childTableName(tagName: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < tagName.length; i += 1) {
    h ^= tagName.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `tb_${h.toString(16).padStart(8, '0')}`;
}

interface PendingPoint {
  child: string;
  tagName: string;
  channel: string;
  dataType: string;
  value: number;
  ts: number;
}

/**
 * TDengine 写入管道（REST SQL 批量，`INSERT ... USING <STable> TAGS(...)` 自动建子表）。
 * 说明：TDengine 3.3.6+ 的 taosAdapter 已将 schemaless REST 端点（/rest/schemaless）移除
 * （迁往 WebSocket 通道），故 PoC 采用等价的 SQL 方式写入，超级表/子表架构不变（PRD FR-M4-03）。
 * 行：ts TIMESTAMP, value DOUBLE；TAGS: channel, tag_name, data_type。
 */
export class TDengineWriter {
  private queue: PendingPoint[] = [];
  private state: StorageStatus['state'];
  private written = 0;
  private error?: string;
  private flushTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private flushing = false;
  private inited = false;
  /** 各版本 ping 路径不同（3.3.x 为 /-/ping，旧版为 /rest/ping），探测后记忆 */
  private pingPath: '/-/ping' | '/rest/ping' = '/-/ping';

  private static readonly MAX_QUEUE = 100_000;
  private static readonly AUTH = (cfg: TDengineConfig) => ({
    Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
  });

  constructor(private cfg: TDengineConfig) {
    this.state = cfg.url ? 'offline' : 'disabled';
  }

  /** 未配置 TDENGINE_URL 时为 false，存储任务引擎据此跳过建表/写入 */
  get enabled(): boolean {
    return Boolean(this.cfg.url);
  }

  get status(): StorageStatus {
    return {
      engine: 'tdengine',
      state: this.state,
      queued: this.queue.length,
      written: this.written,
      error: this.error,
    };
  }

  start(): void {
    if (!this.cfg.url) return;
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.healthTimer = setInterval(() => void this.ping(), 10_000);
    void this.init().then(() => this.ping());
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  /** 执行 SQL（REST /rest/sql），返回解析后的 JSON */
  async query(sql: string): Promise<{ code: number; data?: unknown[][]; rows?: number; msg?: string; desc?: string }> {
    const res = await fetch(`${this.cfg.url}/rest/sql`, {
      method: 'POST',
      headers: { ...TDengineWriter.AUTH(this.cfg), 'content-type': 'text/plain' },
      body: sql,
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as { code: number; data?: unknown[][]; rows?: number; msg?: string };
  }

  private async init(): Promise<void> {
    try {
      const db = await this.query(`CREATE DATABASE IF NOT EXISTS ${this.cfg.database}`);
      if (db.code !== 0) throw new Error(`create db ${db.code}: ${db.msg ?? ''}`);
      const stb = await this.query(
        `CREATE STABLE IF NOT EXISTS ${this.cfg.database}.${this.cfg.superTable} ` +
          `(ts TIMESTAMP, val DOUBLE) ` +
          `TAGS (channel VARCHAR(64), tag_name VARCHAR(128), data_type VARCHAR(16))`,
      );
      if (stb.code !== 0) throw new Error(`create stable ${stb.code}: ${stb.msg ?? ''}`);
      // 告警事件审计表（PRD FR-M10-01 持久化）
      await this.query(
        `CREATE TABLE IF NOT EXISTS ${this.cfg.database}.alarm_events ` +
          `(ts TIMESTAMP, event_id VARCHAR(64), rule_id VARCHAR(64), tag_id VARCHAR(32), tag_name VARCHAR(128), ` +
          `channel VARCHAR(64), status VARCHAR(8), kind VARCHAR(8), threshold DOUBLE, val DOUBLE, message VARCHAR(200))`,
      );
      this.inited = true;
    } catch (e) {
      this.error = `init: ${String(e)}`;
    }
  }

  private async ping(): Promise<void> {
    if (!this.cfg.url) return;
    for (const path of [this.pingPath, this.pingPath === '/-/ping' ? '/rest/ping' : '/-/ping'] as const) {
      try {
        const res = await fetch(`${this.cfg.url}${path}`, {
          headers: TDengineWriter.AUTH(this.cfg),
          signal: AbortSignal.timeout(3000),
        });
        // 404 = 路径不存在（版本差异），换下一个候选；其余非 200 视为离线
        if (res.status === 404) continue;
        this.pingPath = path;
        this.state = res.ok ? 'online' : 'offline';
        if (!res.ok) this.error = `ping HTTP ${res.status}`;
        return;
      } catch (e) {
        this.state = 'offline';
        this.error = String(e);
        return;
      }
    }
  }

  enqueue(update: TagValueUpdate, tag: Tag): void {
    if (!this.cfg.url || typeof update.value !== 'number') return;
    this.queue.push({
      child: childTableName(tag.name),
      tagName: escTag(tag.name),
      channel: escTag(tag.channelId),
      dataType: tag.dataType,
      value: update.value,
      ts: update.ts,
    });
    if (this.queue.length > TDengineWriter.MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - TDengineWriter.MAX_QUEUE);
      this.error = 'queue overflow, dropped oldest points';
    }
  }

  private async flush(): Promise<void> {
    if (!this.cfg.url || this.flushing || !this.queue.length) return;
    if (!this.inited) {
      await this.init();
      if (!this.inited) return;
    }
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    // 每个子表一条 USING 子句，多行值合并，减少 SQL 体积
    const byChild = new Map<string, PendingPoint[]>();
    for (const p of batch) {
      const list = byChild.get(p.child) ?? [];
      list.push(p);
      byChild.set(p.child, list);
    }
    const parts: string[] = [];
    for (const [child, points] of byChild) {
      const first = points[0];
      const values = points.map((p) => `(${p.ts},${p.value})`).join(' ');
      parts.push(
        `${this.cfg.database}.${child} USING ${this.cfg.database}.${this.cfg.superTable} ` +
          `TAGS('${first.channel}','${first.tagName}','${first.dataType}') VALUES ${values}`,
      );
    }
    try {
      const sql = `INSERT INTO ${parts.join(' ')}`;
      const result = await this.query(sql);
      if (result.code !== 0) {
        const detail = result.desc ?? result.msg ?? 'insert failed';
        console.error(`[tdengine] insert failed ${result.code}: ${detail}; sql[0..300]=${sql.slice(0, 300)}`);
        throw new Error(`SQL ${result.code}: ${detail}`);
      }
      this.written += batch.length;
      this.state = 'online';
      this.error = undefined;
    } catch (e) {
      this.state = 'offline';
      this.error = String(e);
      // 失败的批次放回队首，避免丢数据
      this.queue = [...batch, ...this.queue].slice(0, TDengineWriter.MAX_QUEUE);
    } finally {
      this.flushing = false;
    }
  }
}
