import NodeS7 from 'nodes7';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import { bumpRx, bumpTx } from '../stats';

const RECONNECT_MS = 5000;

/**
 * 平台地址 → nodes7 地址。
 *   DB301.Real10 → DB301,REAL10      DB301.DInt2 → DB301,DINT2
 *   DB301.DBX20.0 → DB301,X20.0      DB301.DBW4 → DB301,WORD4
 */
export function toNodes7Address(address: string): string {
  const m = address.trim().match(/^DB(\d+)\.(.+)$/i);
  if (!m) throw new Error(`unsupported S7 address (DB area only in PoC): ${address}`);
  const db = m[1];
  const bit = m[2].match(/^DBX(\d+)\.(\d+)$/i);
  if (bit) return `DB${db},X${bit[1]}.${bit[2]}`;
  const t = m[2].match(/^([A-Za-z]+)(\d+)$/);
  if (!t) throw new Error(`unsupported S7 address: ${address}`);
  const typeMap: Record<string, string> = {
    real: 'REAL', dint: 'DINT', int: 'INT', word: 'WORD', dword: 'DWORD',
    dbw: 'WORD', dbd: 'DWORD', dbb: 'BYTE', byte: 'BYTE', char: 'CHAR',
  };
  const type = typeMap[t[1].toLowerCase()];
  if (!type) throw new Error(`unsupported S7 data type in address: ${address}`);
  return `DB${db},${type}${t[2]}`;
}

/**
 * Siemens S7 驱动（nodes7 纯 JS S7comm 实现）。
 * 选型说明：PRD 首选的 node-snap7 依赖原生编译（Windows 需 MSVC，pnpm 默认拦截
 * 构建脚本），nodes7 零原生依赖、天然满足 Linux/Windows 双平台交付（决策记录见 README）。
 * 采集方式：读计划轮询（nodes7 自动按 PDU 合并相邻地址），rack/slot/PDU 由协议参数配置。
 */
export class S7Driver implements Driver {
  private conn?: NodeS7;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private connected = false;
  private addrById = new Map<string, string>();

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');

    for (const tag of this.ctx.tags) {
      try {
        this.addrById.set(tag.id, toNodes7Address(tag.address));
      } catch (e) {
        this.ctx.setStatus('error', String(e));
        return;
      }
    }

    const p = this.ctx.channel.params;
    const rack = Number(p.rack ?? 0);
    const slot = Number(p.slot ?? 1);
    const conn = new NodeS7();
    this.conn = conn;

    const connectResult = await new Promise<{ err?: Error; ok: boolean }>((resolve) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        resolve({ err, ok: !err });
      };
      const timeout = setTimeout(() => finish(new Error('connect timeout (8s)')), 8000);
      conn.initiateConnection(
        { port: this.ctx.channel.port, host: this.ctx.channel.host, rack, slot },
        (err) => {
          clearTimeout(timeout);
          finish(err);
        },
      );
    });
    if (this.stopped) return;

    if (!connectResult.ok) {
      const reason = connectResult.err
        ? connectResult.err.message || String(connectResult.err)
        : 'unknown';
      this.ctx.setStatus('offline', `connect failed: ${reason}`);
      this.scheduleReconnect();
      return;
    }
    this.connected = true;

    conn.setTranslationCB((tagId) => this.addrById.get(tagId));
    conn.addItems(this.ctx.tags.map((t) => t.id));

    this.ctx.setStatus('online', `S7 connected (rack ${rack}, slot ${slot})`);
    this.timer = setInterval(() => void this.poll(), Math.max(300, this.ctx.channel.pollIntervalMs));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const conn = this.conn;
    this.conn = undefined;
    if (conn) {
      await new Promise<void>((resolve) => conn.dropConnection(() => resolve()));
    }
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    if (!this.conn || !this.connected) throw new Error('S7 not connected');
    const value = tag.dataType === 'Bool' ? Boolean(rawValue) : Number(rawValue);
    await new Promise<void>((resolve, reject) => {
      this.conn!.writeItems([tag.id], [value], (err) => {
        err ? reject(new Error(String(err))) : resolve();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) void this.start();
    }, RECONNECT_MS);
  }

  private poll(): void {
    const conn = this.conn;
    if (this.busy || !conn) return;
    this.busy = true;
    const t0 = Date.now();
    // FR-M2-07：一轮 readAllItems = 1 请求/响应（nodes7 库内帧不可见，按周期计数）
    bumpTx(this.ctx.channel.id);
    conn.readAllItems((err, values) => {
      this.busy = false;
      if (this.stopped) return;
      if (err || !values) {
        this.ctx.setStatus('offline', `read failed: ${err?.message ?? 'no values'}`);
        return;
      }
      bumpRx(this.ctx.channel.id);
      for (const tag of this.ctx.tags) {
        const v = values[tag.id];
        if (v === undefined) continue;
        this.ctx.publish(tag.id, v as number | boolean | string);
      }
      this.ctx.setStatus('online', `OK ${Date.now() - t0}ms`);
    });
  }
}
