import ModbusRTU from 'modbus-serial';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';

const RECONNECT_MS = 5000;

/** '40001' → 0（1-based 4x 区）；'30011' → 10（3x 区） */
export function regOffset(address: string): number | null {
  const m = address.trim().match(/^[34]\d{4}$/);
  if (!m) return null;
  const n = parseInt(address, 10);
  return n - (m[0].startsWith('4') ? 40001 : 30001);
}

function regCount(tag: Tag): number {
  return tag.dataType === 'Float' || tag.dataType === 'Int32' || tag.dataType === 'Double' ? 2 : 1;
}

/** Modbus 线序 buffer → 逻辑 Big-Endian buffer（按 32 位字节序参数） */
function toLogicalBE(wire: Buffer, order: string): Buffer {
  const b = Buffer.from(wire.subarray(0, 4));
  switch (order) {
    case 'CDAB': {
      const hi = b.readUInt16BE(0);
      b.writeUInt16BE(b.readUInt16BE(2), 0);
      b.writeUInt16BE(hi, 2);
      return b;
    }
    case 'BADC':
      b.swap16();
      return b;
    case 'DCBA':
      b.reverse();
      return b;
    default:
      return b; // ABCD
  }
}

function parseValue(wire: Buffer, tag: Tag, byteOrder32: string): number | boolean {
  switch (tag.dataType) {
    case 'Bool':
      return wire.readInt16BE(0) !== 0;
    case 'Int16':
      return wire.readInt16BE(0);
    case 'UInt16':
      return wire.readUInt16BE(0);
    case 'Int32':
      return toLogicalBE(wire, byteOrder32).readInt32BE(0);
    case 'Float':
      return toLogicalBE(wire, byteOrder32).readFloatBE(0);
    case 'Double':
      // PoC 简化：64 位按原始 BE 解析，64 位字节序切换随 Phase 1 完善
      return wire.readDoubleBE(0);
    default:
      return wire.readUInt16BE(0);
  }
}

export class ModbusTcpDriver implements Driver {
  private client = new ModbusRTU();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');
    const { host, port } = this.ctx.channel;
    try {
      await this.client.connectTCP(host, { port });
    } catch (e) {
      this.ctx.setStatus('offline', `TCP connect failed: ${String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.client.setID(Number(this.ctx.channel.params.slaveId ?? 1));
    this.ctx.setStatus('online', 'Modbus TCP connected');
    this.timer = setInterval(() => void this.poll(), Math.max(200, this.ctx.channel.pollIntervalMs));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.client.close(() => {});
    } catch {
      /* ignore */
    }
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    const off = regOffset(tag.address);
    if (off == null) throw new Error(`invalid Modbus address: ${tag.address}`);
    await this.client.writeRegister(off, Number(rawValue));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => {
      if (!this.stopped) void this.start();
    }, RECONNECT_MS);
  }

  /** 简易读计划：按寄存器偏移排序，相邻（间隔 ≤4 且总长 ≤120）合并为一次批量读 */
  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      const items = this.ctx.tags
        .map((tag) => ({ tag, off: regOffset(tag.address) }))
        .filter((x): x is { tag: Tag; off: number } => x.off != null)
        .sort((a, b) => a.off - b.off);

      let i = 0;
      while (i < items.length) {
        let j = i;
        while (
          j + 1 < items.length &&
          items[j + 1].off - items[j].off <= 4 &&
          items[j + 1].off + regCount(items[j + 1].tag) - items[i].off <= 120
        ) {
          j += 1;
        }
        const start = items[i].off;
        const end = items[j].off + regCount(items[j].tag);
        const res = await this.client.readHoldingRegisters(start, end - start);
        for (let k = i; k <= j; k += 1) {
          const { tag, off } = items[k];
          const wire = res.buffer.subarray((off - start) * 2, (off - start) * 2 + regCount(tag) * 2);
          const raw = parseValue(wire, tag, String(this.ctx.channel.params.byteOrder32 ?? 'CDAB'));
          this.ctx.publish(tag.id, raw);
        }
        i = j + 1;
      }
      this.ctx.setStatus('online', `OK ${Date.now() - t0}ms`);
    } catch (e) {
      this.ctx.setStatus('offline', `poll failed: ${String(e)}`);
      try {
        this.client.close(() => {});
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    } finally {
      this.busy = false;
    }
  }
}
