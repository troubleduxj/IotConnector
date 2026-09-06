import PLC from 'st-ethernet-ip';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';

const RECONNECT_MS = 8000;

/**
 * EtherNet/IP（CIP）驱动（st-ethernet-ip 库，ControlLogix/CompactLogix/Emulator）。
 * 地址：控制器作用域符号名（如 MyTag）；支持基本类型读写。
 * 接入真实 PLC 或 L5X Emulator 后启用通道即可。
 */
export class EnipDriver implements Driver {
  private plc?: PLC;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private connected = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');
    const plc = new PLC();
    this.plc = plc;
    try {
      await withTimeout(plc.connect(this.ctx.channel.host, Number(this.ctx.channel.params.slot ?? 0)), 6000, 'CIP 连接');
    } catch (e) {
      if (this.stopped) return;
      this.ctx.setStatus('offline', `connect failed: ${String((e as Error).message ?? e)}`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    this.connected = true;
    this.ctx.setStatus('online', 'CIP session established');
    this.timer = setInterval(() => void this.poll(), Math.max(200, this.ctx.channel.pollIntervalMs));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const plc = this.plc;
    this.plc = undefined;
    if (plc) {
      try { await plc.destroy(); } catch { /* ignore */ }
    }
    this.connected = false;
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    if (!this.plc || !this.connected) throw new Error('EtherNet/IP not connected');
    await withTimeout(this.plc.write(tag.address, rawValue), 4000, 'CIP write');
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => { if (!this.stopped) void this.start(); }, RECONNECT_MS);
  }

  private async poll(): Promise<void> {
    if (!this.plc || !this.connected) return;
    try {
      for (const tag of this.ctx.tags) {
        const result = await withTimeout(this.plc.read(tag.address), 4000, `read ${tag.address}`);
        const value = (result as { value?: unknown } | null)?.value;
        if (value === undefined || value === null) continue;
        if (tag.dataType === 'Bool') this.ctx.publish(tag.id, Boolean(value));
        else if (tag.dataType === 'String') this.ctx.publish(tag.id, String(value));
        else this.ctx.publish(tag.id, Number(value));
      }
      this.ctx.setStatus('online', 'CIP reads OK');
    } catch (e) {
      this.ctx.setStatus('offline', `poll failed: ${String((e as Error).message ?? e)}`);
      this.connected = false;
      this.scheduleReconnect();
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}


