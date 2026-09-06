import FinsClient from 'omron-fins';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';

const RECONNECT_MS = 5000;

/**
 * Omron FINS 驱动（omron-fins 库，TCP/UDP 9600）。
 * 地址：D100 → DM 字读取；Float 由连续两字（高字在前）合成。
 * 接入真实 CJ2/CS1 或 FINS 网关后启用通道即可。
 */
export class FinsDriver implements Driver {
  private client?: FinsClient;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private connected = false;
  private stopped = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');
    const conn = new FinsClient(Number(this.ctx.channel.port || 9600), this.ctx.channel.host);
    this.client = conn;
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          conn.connect((err: Error | null) => (err ? reject(err) : resolve()));
        }),
        6000,
        'FINS 连接',
      );
    } catch (e) {
      if (this.stopped) return;
      this.ctx.setStatus('offline', `connect failed: ${String((e as Error).message ?? e)}`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    this.connected = true;
    this.ctx.setStatus('online', 'FINS connected');
    this.timer = setInterval(() => void this.poll(), Math.max(200, this.ctx.channel.pollIntervalMs));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const conn = this.client;
    this.client = undefined;
    this.connected = false;
    if (conn) {
      await new Promise<void>((resolve) => {
        try {
          conn.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    if (!this.client || !this.connected) throw new Error('FINS not connected');
    const m = tag.address.match(/^(D|W)(\d{1,5})$/i);
    if (!m) throw new Error(`unsupported FINS address: ${tag.address}`);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        this.client!.write(String(tag.address), rawValue, (err: Error | null) =>
          err ? reject(err) : resolve(),
        );
      }),
      4000,
      'FINS write',
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => { if (!this.stopped) void this.start(); }, RECONNECT_MS);
  }

  private async poll(): Promise<void> {
    if (this.busy || !this.client || !this.connected) return;
    this.busy = true;
    const numeric = this.ctx.tags.filter((t) => t.dataType !== 'Bool' && t.dataType !== 'String');
    const bools = this.ctx.tags.filter((t) => t.dataType === 'Bool');
    try {
      for (const tag of numeric) {
        const m = tag.address.match(/^(D|W)(\d{1,5})$/i);
        if (!m) continue;
        const words = tag.dataType === 'Float' || tag.dataType === 'Double' || tag.dataType === 'Int32' ? 2 : 1;
        const values = await withTimeout(
          new Promise<number[]>((resolve, reject) => {
            this.client!.memoryRead(String(tag.address), words, (err: Error | null, res: unknown) => {
              if (err) reject(err);
              else {
                // omron-fins 各版本返回结构不同，做宽松提取
                const r = res as { value?: number; values?: number[]; response?: { value?: number; values?: number[] } };
                const arr = r.values ?? r.response?.values;
                if (Array.isArray(arr)) resolve(arr as number[]);
                else if (typeof r.value === 'number') resolve([r.value]);
                else resolve([]);
              }
            });
          }),
          4000,
          'FINS memoryRead',
        );
        let value: number;
        if (words === 2) {
          const hi = values[0] ?? 0;
          const lo = values[1] ?? 0;
          value = tag.dataType === 'Int32' || tag.dataType === 'Double'
            ? (hi << 16) | lo
            : (() => { const b = Buffer.alloc(4); b.writeUInt16BE(hi & 0xffff, 0); b.writeUInt16BE(lo & 0xffff, 2); return b.readFloatBE(0); })();
        } else {
          value = values[0] ?? 0;
        }
        this.ctx.publish(tag.id, value);
      }
      for (const tag of bools) {
        const values = await withTimeout(
          new Promise<number[]>((resolve, reject) => {
            this.client!.memoryRead(String(tag.address), 1, (err: Error | null, res: unknown) => {
              if (err) reject(err);
              else {
                const r = res as { value?: number; values?: number[]; response?: { value?: number; values?: number[] } };
                const arr = r.values ?? r.response?.values;
                if (Array.isArray(arr)) resolve(arr as number[]);
                else if (typeof r.value === 'number') resolve([r.value]);
                else resolve([]);
              }
            });
          }),
          4000,
          'FINS memoryRead(bit)',
        );
        this.ctx.publish(tag.id, (values[0] ?? 0) === 1);
      }
      this.ctx.setStatus('online', 'FINS polling');
    } catch (e) {
      this.ctx.setStatus('offline', `poll failed: ${String((e as Error).message ?? e)}`);
      this.connected = false;
      this.scheduleReconnect();
    } finally {
      this.busy = false;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

