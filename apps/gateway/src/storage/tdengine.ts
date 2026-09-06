import type { StorageStatus, Tag, TagValueUpdate } from '@iotconnector/shared';

export interface TDengineConfig {
  /** taosAdapter REST 地址，如 http://127.0.0.1:6041；未配置则禁用写入管道 */
  url?: string;
  user: string;
  password: string;
  database: string;
  superTable: string;
}

function esc(s: string): string {
  return s.replace(/[",\s]/g, '_');
}

/**
 * TDengine schemaless 写入管道（InfluxDB Line Protocol，毫秒精度）。
 * 行格式：`${superTable},channel=..,tag_name=..,data_type=.. value=<number> <ts_ms>`
 * 首次写入时 TDengine 自动建库/建超级表/建子表（STable 架构，PRD FR-M4-03）。
 */
export class TDengineWriter {
  private queue: string[] = [];
  private state: StorageStatus['state'];
  private written = 0;
  private error?: string;
  private flushTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private flushing = false;

  private static readonly MAX_QUEUE = 100_000;
  private static readonly AUTH = (cfg: TDengineConfig) => ({
    Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64')}`,
  });

  constructor(private cfg: TDengineConfig) {
    this.state = cfg.url ? 'offline' : 'disabled';
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
    void this.ping();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
  }

  enqueue(update: TagValueUpdate, tag: Tag): void {
    if (!this.cfg.url || typeof update.value !== 'number') return;
    const line = `${esc(this.cfg.superTable)},channel=${esc(tag.channelId)},tag_name=${esc(tag.name)},data_type=${tag.dataType} value=${update.value} ${update.ts}`;
    this.queue.push(line);
    if (this.queue.length > TDengineWriter.MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - TDengineWriter.MAX_QUEUE);
      this.error = 'queue overflow, dropped oldest points';
    }
  }

  private async ping(): Promise<void> {
    if (!this.cfg.url) return;
    try {
      const res = await fetch(`${this.cfg.url}/rest/ping`, {
        headers: TDengineWriter.AUTH(this.cfg),
        signal: AbortSignal.timeout(3000),
      });
      this.state = res.ok ? 'online' : 'offline';
      if (!res.ok) this.error = `ping HTTP ${res.status}`;
    } catch (e) {
      this.state = 'offline';
      this.error = String(e);
    }
  }

  private async flush(): Promise<void> {
    if (!this.cfg.url || this.flushing || !this.queue.length) return;
    this.flushing = true;
    const body = this.queue.join('\n');
    try {
      const res = await fetch(
        `${this.cfg.url}/rest/schemaless?db=${encodeURIComponent(this.cfg.database)}&precision=ms`,
        {
          method: 'POST',
          headers: { ...TDengineWriter.AUTH(this.cfg), 'content-type': 'text/plain' },
          body,
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      this.written += this.queue.length;
      this.queue = [];
      this.state = 'online';
      this.error = undefined;
    } catch (e) {
      this.state = 'offline';
      this.error = String(e);
    } finally {
      this.flushing = false;
    }
  }
}
