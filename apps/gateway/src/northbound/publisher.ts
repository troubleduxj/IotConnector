import mqtt from 'mqtt';
import {
  encodePayload, spbTopic, tagToMetric, SPARKPLUG_DATATYPE,
  type MessageType,
} from './sparkplug';

/**
 * 北向 Sparkplug B 发布器 + Reliable Outbox（PRD FR-M9-03 / 决策 D7）。
 * - 主题：spBv1.0/<groupId>/<NBIRTH|DBIRTH|NDATA|DDATA|NDEATH>/<edgeNodeId>[/<deviceId>]
 * - NDEATH 经 MQTT Will（qos 1）注册；REBIRTH 通过订阅 STATE 主题响应。
 * - Reliable Outbox：断线期间 DDATA/BIRTH 入持久队列（JSONL），恢复后按序补传；
 *   队列上限 10k，超限丢最旧并计数。
 * - 简化说明：全部消息使用完整 metric 名（alias 优化未启用）； births/data qos 0，
 *   NDEATH will qos 1 —— 符合规范常见实践。
 */

export interface NorthboundConfig {
  enabled: boolean;
  url: string; // mqtt://host:1883
  username?: string;
  password?: string;
  groupId: string;
  edgeNodeId: string;
  dataFlushMs: number;
}

export interface NorthboundStatus {
  connected: boolean;
  bdSeq: number;
  seq: number;
  queued: number;
  dropped: number;
  published: number;
  lastPublishAt?: number;
  lastError?: string;
}

interface OutboxEntry {
  topic: string;
  payloadB64: string;
  qos: 0 | 1;
}

export class NorthboundPublisher {
  private client?: mqtt.MqttClient;
  private bdSeq = 0;
  private seq = 0;
  private connected = false;
  private dropped = 0;
  private published = 0;
  private lastPublishAt?: number;
  private lastError?: string;
  private outbox: OutboxEntry[] = [];
  private dataBuffer = new Map<string, Map<string, { value: number | string | boolean; ts: number }>>();
  private flushTimer?: NodeJS.Timeout;
  private flushing = false;

  constructor(
    private getConfig: () => NorthboundConfig,
    private file: { statePath: string; outboxPath: string; read: (p: string) => string; write: (p: string, data: unknown) => void },
    private channelsProvider: () => Array<{ id: string; name: string; enabled: boolean; params: Record<string, unknown> }>,
    private tagsProvider: () => Array<{ id: string; name: string; dataType: string; channelId: string }>,
  ) {}

  get status(): NorthboundStatus {
    return {
      connected: this.connected,
      bdSeq: this.bdSeq,
      seq: this.seq,
      queued: this.outbox.length,
      dropped: this.dropped,
      published: this.published,
      lastPublishAt: this.lastPublishAt,
      lastError: this.lastError,
    };
  }

  // ===== 持久化 =====

  loadPersisted(): void {
    try {
      const state = JSON.parse(this.file.read(this.file.statePath)) as {
        bdSeq?: number; seq?: number; queue?: OutboxEntry[]; dropped?: number;
      };
      this.bdSeq = state.bdSeq ?? 0;
      this.seq = state.seq ?? 0;
      this.outbox = state.queue ?? [];
      this.dropped = state.dropped ?? 0;
      if (this.outbox.length) console.log(`[northbound] restored outbox: ${this.outbox.length} queued`);
    } catch { /* 首次运行无文件 */ }
  }

  private persist(): void {
    this.file.write(this.file.statePath, {
      bdSeq: this.bdSeq, seq: this.seq, queue: this.outbox, dropped: this.dropped,
    });
  }

  // ===== 生命周期 =====

  start(): void {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.url) return;
    // flush 定时器与连接解耦：断线期间也要把 DDATA 入 Reliable Outbox
    this.flushTimer ??= setInterval(() => this.flushData(), Math.max(500, cfg.dataFlushMs));
    this.connect();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.client?.end(true);
    this.client = undefined;
    this.connected = false;
  }

  /** 配置变更：URL 变化或启停 → 重连；位号/通道变化 → DBIRTH 刷新 */
  applyConfig(): void {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.stop();
      return;
    }
    if (this.client?.connected) {
      void this.publishBirths(); // 通道/位号变更 → 重新广播 BIRTH
    } else {
      this.start();
    }
  }

  private connect(): void {
    const cfg = this.getConfig();
    this.bdSeq += 1;
    const deathTopic = spbTopic(cfg.groupId, 'NDEATH', cfg.edgeNodeId);
    const deathPayload = encodePayload({
      timestamp: Date.now(),
      metrics: [{ name: 'bdSeq', timestamp: Date.now(), datatype: 9, value: this.bdSeq }],
      seq: (this.seq + 1) % 4294967296,
    });
    this.client = mqtt.connect(cfg.url, {
      clientId: `${cfg.edgeNodeId}_${process.pid}`,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      clean: true,
      reconnectPeriod: 5000,
      will: {
        topic: deathTopic,
        payload: Buffer.from(deathPayload),
        qos: 1,
        retain: false,
      },
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.lastError = undefined;
      // 订阅 Host STATE（REBIRTH 命令）
      this.client?.subscribe('spBv1.0/STATE/+');
      void this.publishBirths();
      this.flushOutbox();
      this.flushTimer ??= setInterval(() => this.flushData(), Math.max(500, this.getConfig().dataFlushMs));
    });

    this.client.on('close', () => {
      this.connected = false;
      this.lastError = 'MQTT 断开（Outbox 缓存中）';
    });

    this.client.on('error', (e) => {
      this.lastError = String(e.message ?? e);
    });

    this.client.on('message', (topic, payload) => {
      if (topic.startsWith('spBv1.0/STATE/')) {
        try {
          const body = JSON.parse(payload.toString('utf-8'));
          if (String(body.cmd ?? '').toUpperCase() === 'REBIRTH') {
            console.log('[northbound] REBIRTH received');
            void this.publishBirths();
          }
        } catch { /* 非 JSON STATE 忽略 */ }
      }
    });
  }

  // ===== BIRTH =====

  private async publishBirths(): Promise<void> {
    const cfg = this.getConfig();
    if (!this.client?.connected) return;
    try {
      // NBIRTH：bdSeq + Node Control/Rebirth
      this.seq = (this.seq + 1) % 4294967296;
      const nbirth = encodePayload({
        timestamp: Date.now(),
        metrics: [
          { name: 'Node Control/Rebirth', timestamp: Date.now(), datatype: SPARKPLUG_DATATYPE.BOOLEAN, value: false },
          { name: 'bdSeq', timestamp: Date.now(), datatype: 9, value: this.bdSeq },
        ],
        seq: this.seq,
      });
      await this.publishWithOutbox(spbTopic(cfg.groupId, 'NBIRTH', cfg.edgeNodeId), nbirth, 0);

      // 每启用通道一条 DBIRTH（该通道全部启用位号）
      for (const channel of this.channelsProvider().filter((c) => c.enabled)) {
        const metrics = this.tagsProvider()
          .filter((t) => t.channelId === channel.id)
          .map((t) => tagToMetric(t, 0, Date.now()));
        if (!metrics.length) continue;
        this.seq = (this.seq + 1) % 4294967296;
        const dbirth = encodePayload({ timestamp: Date.now(), metrics, seq: this.seq });
        await this.publishWithOutbox(spbTopic(cfg.groupId, 'DBIRTH', cfg.edgeNodeId, channel.name), dbirth, 0);
      }
      this.persist();
    } catch (e) {
      this.lastError = String(e);
    }
  }

  // ===== DDATA =====

  /** 引擎批次入口：按通道聚合位号最新值（由 flush 节奏合并发布） */
  enqueueChannelData(channelId: string, updates: Array<{ id: string; value: number | string | boolean; ts: number }>): void {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    const channel = this.channelsProvider().find((c) => c.id === channelId);
    if (!channel?.enabled) return;
    const bucket = this.dataBuffer.get(channelId) ?? new Map();
    for (const u of updates) bucket.set(u.id, { value: u.value, ts: u.ts });
    this.dataBuffer.set(channelId, bucket);
  }

  private flushData(): void {
    if (this.dataBuffer.size === 0) return;
    const cfg = this.getConfig();
    for (const [channelId, bucket] of this.dataBuffer) {
      if (bucket.size === 0) continue;
      this.seq = (this.seq + 1) % 4294967296;
      const metrics = [...bucket.entries()].map(([tagId, v]) => {
        const tag = this.tagsProvider().find((t) => t.id === tagId);
        return tagToMetric(
          { id: tagId, name: tag?.name ?? tagId, dataType: tag?.dataType ?? 'Float' },
          v.value, v.ts,
        );
      });
      const ddata = encodePayload({ timestamp: Date.now(), metrics, seq: this.seq });
      // 断线时 publishWithOutbox 自动入 Reliable Outbox（按序补传）
      void this.publishWithOutbox(spbTopic(cfg.groupId, 'DDATA', cfg.edgeNodeId, this.channelName(channelId)), ddata, 0);
      bucket.clear();
    }
  }

  private channelName(channelId: string): string {
    return this.channelsProvider().find((c) => c.id === channelId)?.name ?? channelId;
  }
  // ===== 发布 + Reliable Outbox =====

  private async publishWithOutbox(topic: string, payload: Uint8Array, qos: 0 | 1): Promise<void> {
    if (this.client?.connected) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.client!.publish(topic, Buffer.from(payload), { qos }, (err) => (err ? reject(err) : resolve()));
        });
        this.published += 1;
        this.lastPublishAt = Date.now();
        return;
      } catch (e) {
        this.lastError = String(e);
      }
    }
    // 断线 → Outbox
    this.outbox.push({ topic, payloadB64: Buffer.from(payload).toString('base64'), qos });
    if (this.outbox.length > 10_000) {
      this.outbox.splice(0, this.outbox.length - 10_000);
      this.dropped += 1;
    }
    this.persist();
  }

  private flushOutbox(): void {
    if (this.flushing || !this.client?.connected || !this.outbox.length) return;
    this.flushing = true;
    const drain = (): void => {
      if (!this.client?.connected) { this.flushing = false; return; }
      const entry = this.outbox.shift();
      if (!entry) { this.flushing = false; this.persist(); return; }
      this.client.publish(entry.topic, Buffer.from(entry.payloadB64, 'base64'), { qos: entry.qos }, (err) => {
        if (err) {
          this.outbox.unshift(entry); // 放回队首，保持顺序
          this.flushing = false;
          return;
        }
        this.published += 1;
        this.persist();
        drain();
      });
    };
    drain();
  }
}
