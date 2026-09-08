import mqtt from 'mqtt';
import type { Driver, DriverContext } from '../driver';

/**
 * MQTT 南向采集驱动（订阅型）：
 * 桥接以 MQTT 发布遥测的传感器/子网关——位号地址即订阅主题，payload 支持
 * JSON（按点分路径取字段）或原始值（数字/布尔/字符串）。
 * 多位号可共用一个主题，各自以不同 jsonPath 取字段。
 */
export class MqttSubscriberDriver implements Driver {
  private client?: mqtt.MqttClient;
  private reconnecting = false;
  private subscribedOnce = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    const p = this.ctx.channel.params as Record<string, unknown>;
    const brokerUrl = String(p.brokerUrl ?? 'mqtt://127.0.0.1:1883');
    // 地址语法「主题#字段路径」：订阅仅取主题段
    const topics = [...new Set(this.ctx.tags.map((t) => (t.address.indexOf('#') >= 0 ? t.address.slice(0, t.address.indexOf('#')) : t.address)))];

    this.client = mqtt.connect(brokerUrl, {
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      username: p.username ? String(p.username) : undefined,
      password: p.password ? String(p.password) : undefined,
    });

    this.client.on('connect', () => {
      const qos = (Math.min(1, Math.max(0, Number(p.qos ?? 0))) as 0 | 1);
      this.client?.subscribe(topics, { qos }, (err) => {
        if (err) this.ctx.setStatus('error', `subscribe: ${err.message}`);
        else {
          this.subscribedOnce = true;
          this.ctx.setStatus('online', `已订阅 ${topics.length} 个主题`);
        }
      });
    });

    this.client.on('message', (topic, payload) => this.onMessage(topic, payload));

    this.client.on('reconnect', () => {
      if (!this.reconnecting) {
        this.reconnecting = true;
        this.ctx.setStatus('connecting', '重连 Broker…');
      }
    });
    this.client.on('close', () => {
      this.reconnecting = false;
      // 初始连接期的 close（如 CONNACK 前瞬断）不直接判死，交给 reconnect 流程
      if (this.subscribedOnce) this.ctx.setStatus('offline', '连接已断开');
    });
    this.client.on('error', (err) => {
      this.ctx.setStatus('error', `连接失败: ${err.message}`);
    });
  }

  /**
   * 按 payloadMode 解析并广播给所有匹配主题的位号。
   * 位号地址支持「主题#字段路径」语法：# 后为 JSON 点分路径（空 = 整个 payload 按标量解析），
   * 未带 # 则用通道级 jsonPath 缺省 —— 使多位号可共用主题各取字段。
   */
  private onMessage(topic: string, payload: Buffer): void {
    const text = payload.toString('utf-8');
    const p = this.ctx.channel.params as Record<string, unknown>;
    const channelDefault = String(p.jsonPath ?? 'value');
    const isRaw = String(p.payloadMode ?? 'json') === 'raw';

    const extractScalar = (): number | string | boolean => {
      const raw = text.trim();
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    };

    const extractJson = (jsonPath: string): number | string | boolean | undefined => {
      if (jsonPath === '') return extractScalar(); // 空路径 = payload 本身是标量
      try {
        let cur: unknown = JSON.parse(text);
        for (const seg of jsonPath.split('.').filter(Boolean)) {
          if (cur === null || typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[seg];
        }
        if (cur === undefined || cur === null) return undefined;
        if (typeof cur === 'number' || typeof cur === 'boolean' || typeof cur === 'string') return cur;
        return JSON.stringify(cur);
      } catch {
        return undefined;
      }
    };

    for (const tag of this.ctx.tags) {
      const hash = tag.address.indexOf('#');
      const addrTopic = hash >= 0 ? tag.address.slice(0, hash) : tag.address;
      if (addrTopic !== topic) continue;
      const path = hash >= 0 ? tag.address.slice(hash + 1) : channelDefault;
      const v = isRaw && hash < 0 ? extractScalar() : extractJson(path);
      if (v === undefined) continue;
      this.ctx.publish(tag.id, v);
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.client?.end(false, {}, () => resolve());
      if (!this.client) resolve();
    });
    this.client = undefined;
  }
}
