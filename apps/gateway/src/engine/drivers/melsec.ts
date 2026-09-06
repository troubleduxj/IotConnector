import net from 'node:net';
import ModbusRTU from 'modbus-serial';
import type { Quality, Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import { pushFrame } from '../../diagnostics';

const RECONNECT_MS = 5000;

/** MELSEC 软元件代码（MC 3E 二进制） */
const DEVICE_CODES: Record<string, number> = { D: 0xa8, W: 0xb4, R: 0xaf, M: 0x90, X: 0x9c, Y: 0x9d, B: 0xa0, ZR: 0xb0 };

interface McAddress {
  device: string;
  number: number;
  bit?: number;
}

export function parseMcAddress(address: string): McAddress {
  const m = address.trim().match(/^([DWRMBXYZ]{1,2})(\d{1,6})$/i);
  if (!m) throw new Error(`不支持的 MELSEC 地址: ${address}（示例 D100 / M20 / W0）`);
  const device = m[1].toUpperCase();
  if (!(device in DEVICE_CODES)) throw new Error(`未知软元件: ${device}`);
  return { device, number: parseInt(m[2], 10) };
}

/**
 * MELSEC MC 协议（3E 帧 / 二进制）驱动 —— 自研原生实现。
 * 支持：字软元件（D/W/R/ZR）Int16/UInt16/Int32/Float 读写；位软元件（M/B/X/Y）Bool 读写。
 * 注意：位读按“每 2 点 1 字节、首点低 4 位”打包，位写每点 1 字节（ON=0x10）——
 * 与本仓库 melsec-sim 匹配；接真机时请按实际 PLC 型号核对位语义。
 */
export class MelsecDriver implements Driver {
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private rx = Buffer.alloc(0);
  private pending?: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private seq = 0;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');
    try {
      this.socket = net.createConnection({ host: this.ctx.channel.host, port: this.ctx.channel.port });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('连接超时')), 5000);
        this.socket!.once('connect', () => { clearTimeout(t); resolve(); });
        this.socket!.once('error', (e) => { clearTimeout(t); reject(e); });
      });
      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('error', () => { /* 由 poll 的 reject/超时路径统一处理 */ });
      this.ctx.setStatus('online', 'MC 3E connected');
      this.timer = setInterval(() => void this.poll(), Math.max(200, this.ctx.channel.pollIntervalMs));
    } catch (e) {
      if (this.stopped) return;
      this.ctx.setStatus('offline', `connect failed: ${String((e as Error).message ?? e)}`);
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.socket = undefined;
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    const addr = parseMcAddress(tag.address);
    if (tag.dataType === 'Bool') {
      const on = Boolean(rawValue);
      await this.transceive(this.buildWriteBits(addr, [on]));
      return;
    }
    await this.transceive(this.buildWriteWords(addr, this.encodeWords(tag, Number(rawValue))));
  }

  // ===== 帧 =====

  private buildHeader(dataLen: number): Buffer {
    const h = Buffer.alloc(9);
    h[0] = 0x50; h[1] = 0x00; // 副头
    h[2] = 0x00; // 网络号
    h[3] = 0xff; // PC 号
    h[4] = 0x03; h[5] = 0xff; // 请求目标模块 I/O
    h[6] = 0x00; // 请求目标站号
    h.writeUInt16LE(dataLen, 7);
    return h;
  }

  private buildReadWords(addr: McAddress, points: number): Buffer {
    const body = Buffer.alloc(12);
    body.writeUInt16LE(0x0010, 0); // 监视定时器
    body.writeUInt16LE(0x0401, 2); // 批量读（字单位）
    body.writeUInt16LE(0x0000, 4); // 子命令
    body.writeUInt8(DEVICE_CODES[addr.device], 6);
    body.writeUIntLE(addr.number, 7, 3);
    body.writeUInt16LE(points, 10);
    return Buffer.concat([this.buildHeader(body.length), body]);
  }

  private buildReadBits(addr: McAddress, points: number): Buffer {
    const body = Buffer.alloc(12);
    body.writeUInt16LE(0x0010, 0);
    body.writeUInt16LE(0x0401, 2);
    body.writeUInt16LE(0x0001, 4); // 位单位
    body.writeUInt8(DEVICE_CODES[addr.device], 6);
    body.writeUIntLE(addr.number, 7, 3);
    body.writeUInt16LE(points, 10);
    return Buffer.concat([this.buildHeader(body.length), body]);
  }

  private buildWriteWords(addr: McAddress, words: number[]): Buffer {
    const body = Buffer.alloc(12 + words.length * 2);
    body.writeUInt16LE(0x0010, 0);
    body.writeUInt16LE(0x1401, 2); // 批量写（字单位）
    body.writeUInt16LE(0x0000, 4);
    body.writeUInt8(DEVICE_CODES[addr.device], 6);
    body.writeUIntLE(addr.number, 7, 3);
    body.writeUInt16LE(words.length, 10);
    words.forEach((w, i) => body.writeUInt16BE(w, 12 + i * 2));
    return Buffer.concat([this.buildHeader(body.length), body]);
  }

  private buildWriteBits(addr: McAddress, values: boolean[]): Buffer {
    const body = Buffer.alloc(12 + values.length);
    body.writeUInt16LE(0x0010, 0);
    body.writeUInt16LE(0x1401, 2);
    body.writeUInt16LE(0x0001, 4); // 位单位
    body.writeUInt8(DEVICE_CODES[addr.device], 6);
    body.writeUIntLE(addr.number, 7, 3);
    body.writeUInt16LE(values.length, 10);
    values.forEach((v, i) => body.writeUInt8(v ? 0x10 : 0x00, 12 + i));
    return Buffer.concat([this.buildHeader(body.length), body]);
  }

  private encodeWords(tag: Tag, value: number): number[] {
    const b = Buffer.alloc(tag.dataType === 'Float' || tag.dataType === 'Double' ? 4 : 2);
    if (tag.dataType === 'Float') b.writeFloatBE(value);
    else if (tag.dataType === 'Double') b.writeDoubleBE(value);
    else if (tag.dataType === 'Int32') b.writeInt32BE(value);
    else b.writeInt16BE(value);
    return tag.dataType === 'Float' || tag.dataType === 'Double'
      ? [b.readUInt16BE(0), b.readUInt16BE(2)]
      : tag.dataType === 'Int32'
        ? [b.readUInt16BE(0), b.readUInt16BE(2)]
        : [b.readUInt16BE(0)];
  }

  // ===== 收发 =====

  private transceive(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('not connected'));
      this.pending?.reject(new Error('overridden'));
      clearTimeout(this.pending?.timer);
      pushFrame(this.ctx.channel.id, 'TX', frame, `${frame.length}B`);
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('响应超时'));
      }, 3000);
      this.pending = { resolve, reject, timer };
      this.socket.write(frame);
    });
  }

  private onData(chunk: Buffer): void {
    pushFrame(this.ctx.channel.id, 'RX', chunk, `${chunk.length}B`);
    this.rx = Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= 9) {
      const dataLen = this.rx.readUInt16LE(7);
      const total = 9 + dataLen;
      if (this.rx.length < total) return;
      const frame = Buffer.from(this.rx.subarray(0, total));
      this.rx = this.rx.subarray(total);
      if (frame[0] !== 0xd0) continue;
      const endCode = frame.readUInt16LE(9);
      this.pending?.timer && clearTimeout(this.pending.timer);
      const pending = this.pending;
      this.pending = undefined;
      if (endCode !== 0) pending?.reject(new Error(`MC end code 0x${endCode.toString(16)}`));
      else pending?.resolve(frame.subarray(11)); // 数据自 11 起（endcode 在 9..10）
    }
  }

  // ===== 轮询 =====

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => { if (!this.stopped) void this.start(); }, RECONNECT_MS);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      for (const tag of this.ctx.tags) {
        const addr = parseMcAddress(tag.address);
        if (tag.dataType === 'Bool') {
          const raw = await this.readOnce(this.buildReadBits(addr, 1));
          // 位打包：首点在低 4 位
          const bitVal = (raw[0] & 0x01) === 0x01;
          this.ctx.publish(tag.id, bitVal);
        } else {
          const words = tag.dataType === 'Float' || tag.dataType === 'Double' || tag.dataType === 'Int32' ? 2 : 1;
          const raw = await this.readOnce(this.buildReadWords(addr, words));
          const b = Buffer.from(raw);
          let value: number;
          if (tag.dataType === 'Float') value = b.readFloatBE(0);
          else if (tag.dataType === 'Double') value = b.readDoubleBE(0);
          else if (tag.dataType === 'Int32') value = b.readInt32BE(0);
          else if (tag.dataType === 'UInt16') value = b.readUInt16BE(0);
          else value = b.readInt16BE(0);
          this.ctx.publish(tag.id, value);
        }
      }
      this.ctx.setStatus('online', `OK ${Date.now() - t0}ms`);
    } catch (e) {
      this.ctx.setStatus('offline', `poll failed: ${String((e as Error).message ?? e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async readOnce(frame: Buffer): Promise<Buffer> {
    const resp = await this.transceive(frame);
    return resp; // 数据区（已跳过 end code；首字节为数据）
  }
}
