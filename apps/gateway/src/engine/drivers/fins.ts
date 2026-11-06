import net from 'node:net';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import { pushFrame } from '../../diagnostics';

const RECONNECT_MS = 5000;

/** FINS 存储区代码（字读/写）：DM=0x82 W=0xB1 CIO=0xB0 H=0xB2；CIO 位=0x30 */
interface FinsAddress {
  area: number;
  word: number;
  bit?: number;
  isBit: boolean;
}

const FINS_AREA_NAMES: Record<number, string> = { 0x82: 'D', 0xb1: 'W', 0xb0: 'CIO', 0xb2: 'H', 0x30: 'CIO' };

/**
 * TX 帧解码：TCP 头 8B('FINS'+len) + 2B + FINS 帧（ICF@10..SID@19、MRC@20、SRC@21、area@22）。
 * 驱动约定：01 01=读字；01 02=写字（area=0x30 时为读位）；01 03=写位。
 */
function describeFinsRequest(frame: Buffer): string {
  if (frame.length < 33) return `FINS/TCP ${frame.length}B`;
  const mrc = frame[26];
  const src = frame[27];
  const sid = frame[25];
  const area = frame[28];
  const name = FINS_AREA_NAMES[area] ?? `0x${area.toString(16)}`;
  const word = frame.readUInt16BE(29);
  if (mrc === 0x01 && src === 0x01) {
    return `FINS 读字 ${name}${word}×${frame.readUInt16BE(31)} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x02 && area === 0x30) {
    return `FINS 读位 ${name}${word}.${String(frame[31]).padStart(2, '0')} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x02) {
    return `FINS 写字 ${name}${word}×${frame.readUInt16BE(31)} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x03) {
    return `FINS 写位 ${name}${word}.${String(frame[31]).padStart(2, '0')} SID=${sid}`;
  }
  return `FINS MRC/SRC=0x${mrc.toString(16)}/0x${src.toString(16)} SID=${sid}`;
}

/** 解析 FINS 地址：D100（DM 字）、W10（W 区字）、CIO5.00（CIO 位） */
export function parseFinsAddress(address: string): FinsAddress {
  const bit = address.trim().match(/^CIO(\d{1,4})\.(\d{1,2})$/i);
  if (bit) return { area: 0x30, word: parseInt(bit[1], 10), bit: parseInt(bit[2], 10), isBit: true };
  const word = address.trim().match(/^(D|W|CIO|H)(\d{1,5})$/i);
  if (!word) throw new Error(`不支持的 FINS 地址: ${address}（示例 D100 / W10 / CIO5.00）`);
  const key = word[1].toUpperCase();
  const area = key === 'D' ? 0x82 : key === 'W' ? 0xb1 : key === 'H' ? 0xb2 : 0xb0;
  return { area, word: parseInt(word[2], 10), isBit: false };
}

// ===== 帧构造（模块级：驱动与连接测试探针共用）=====

function finsWrap(fins: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write('FINS', 0, 'ascii');
  head.writeUInt32BE(8 + fins.length, 4);
  const tcp = Buffer.alloc(8);
  tcp.writeUInt32BE(0x00000002, 0);
  return Buffer.concat([head, tcp, fins]);
}

function finsDstHeader(): Buffer {
  // ICF(请求 0x80) RSV GCT DA DNA DA1 DA2 SNA SA1 SA2 SID
  return Buffer.from([0x80, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00]); // SID 由发送方填 @25
}

function finsAddrBytes(addr: FinsAddress): Buffer {
  const b = Buffer.alloc(addr.isBit ? 3 : 2);
  b.writeUInt16BE(addr.word, 0);
  if (addr.isBit) b[2] = addr.bit ?? 0;
  return b;
}

function finsReadWordsFrame(addr: FinsAddress, words: number): Buffer {
  const fins = Buffer.concat([
    finsDstHeader(),
    Buffer.from([0x01, 0x01, addr.area]),
    finsAddrBytes(addr),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(words, 0); return b; })(),
  ]);
  return finsWrap(fins);
}

function finsReadBitFrame(addr: FinsAddress): Buffer {
  const fins = Buffer.concat([
    finsDstHeader(),
    Buffer.from([0x01, 0x02, 0x30]),
    finsAddrBytes(addr),
    Buffer.from([0x01]),
  ]);
  return finsWrap(fins);
}

/**
 * Omron FINS 驱动（自研 FINS/TCP 原生实现，与 melsec 同套路，帧：'FINS'+len+cmd+err+FINS帧）。
 * 支持：DM/W/CIO 字读（Int16/UInt16/Int32/Float，Float 为两字 BE 合成）+ CIO 位读（Bool）
 * + 字写/位写。SID 自增；end code 0x0000 视为成功。
 */
export class FinsDriver implements Driver {
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private rx = Buffer.alloc(0);
  private pending?: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private sid = 0;

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
      this.socket.on('error', () => { /* 统一走 poll 失败路径 */ });
      this.ctx.setStatus('online', 'FINS/TCP connected');
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
    while (this.busy) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    this.busy = true;
    try {
      const addr = parseFinsAddress(tag.address);
      if (addr.isBit) {
        await this.transceive(this.buildWriteBit(addr, Boolean(rawValue)));
        return;
      }
      await this.transceive(this.buildWriteWords(addr, this.encodeWords(tag, Number(rawValue))));
    } finally {
      this.busy = false;
    }
  }

  // ===== 帧（委托模块级构造，与连接测试探针共用）=====

  private finsWrap(fins: Buffer): Buffer {
    return finsWrap(fins);
  }

  private dstHeader(): Buffer {
    return finsDstHeader();
  }

  private addrBytes(addr: FinsAddress): Buffer {
    return finsAddrBytes(addr);
  }

  private buildReadWords(addr: FinsAddress, words: number): Buffer {
    return finsReadWordsFrame(addr, words);
  }

  private buildReadBit(addr: FinsAddress): Buffer {
    return finsReadBitFrame(addr);
  }

  private buildWriteWords(addr: FinsAddress, words: number[], ): Buffer {
    const data = Buffer.alloc(words.length * 2);
    words.forEach((w, i) => data.writeUInt16BE(w & 0xffff, i * 2));
    const fins = Buffer.concat([
      this.dstHeader(),
      Buffer.from([0x01, 0x02, addr.area]),
      this.addrBytes(addr),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(words.length, 0); return b; })(),
      data,
    ]);
    return this.finsWrap(fins);
  }

  private buildWriteBit(addr: FinsAddress, on: boolean, ): Buffer {
    const fins = Buffer.concat([
      this.dstHeader(),
      Buffer.from([0x01, 0x03, 0x30]),
      this.addrBytes(addr),
      Buffer.from([0x00, 0x01]),
      Buffer.from([on ? 0x01 : 0x00]),
    ]);
    return this.finsWrap(fins);
  }

  private encodeWords(tag: Tag, value: number): number[] {
    const b = Buffer.alloc(4);
    if (tag.dataType === 'Float') b.writeFloatBE(value);
    else if (tag.dataType === 'Int32') b.writeInt32BE(value);
    else b.writeInt16BE(value);
    return tag.dataType === 'Float' || tag.dataType === 'Int32'
      ? [b.readUInt16BE(0), b.readUInt16BE(2)]
      : [b.readUInt16BE(0)];
  }

  // ===== 收发（标准 FINS/TCP：TCP 头(8) + Command/Error(8) + FINS 帧）=====

  private transceive(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('not connected'));
      this.pending?.reject(new Error('overridden'));
      clearTimeout(this.pending?.timer);
      this.sid = (this.sid + 1) & 0xff;
      frame[25] = this.sid & 0xff; // SID @25（TCP 8B 头 + Command/Error 8B 后）
      pushFrame(this.ctx.channel.id, 'TX', frame, describeFinsRequest(frame)); // SID 填充后再捕获，保证 hex/注解与线上一致
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('响应超时'));
      }, 3000);
      this.pending = { resolve, reject, timer };
      this.socket.write(frame);
    });
  }

  private onData(chunk: Buffer): void {
    this.rx = Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= 8) {
      if (this.rx.toString('ascii', 0, 4) !== 'FINS') {
        this.rx = this.rx.subarray(1);
        continue;
      }
      const tcpLen = this.rx.readUInt32BE(4);
      const total = 8 + tcpLen;
      if (this.rx.length < total) return;
      const frame = Buffer.from(this.rx.subarray(0, total));
      this.rx = this.rx.subarray(total);
      // Standard response: Command@8, ErrorCode@12, FINS SID@25,
      // end code@28 and data@30. Reject truncated responses before reading
      // fields so a malformed/short peer frame cannot crash the gateway.
      if (frame.length < 30) {
        this.pending?.reject(new Error(`FINS response too short: ${frame.length}B`));
        this.pending = undefined;
        continue;
      }
      const tcpErr = frame.readUInt32BE(12);
      const end = frame.readUInt16BE(28);
      pushFrame(
        this.ctx.channel.id,
        'RX',
        frame,
        tcpErr !== 0
          ? `FINS/TCP 错误 0x${tcpErr.toString(16)}`
          : end === 0
            ? `FINS 响应 SID=${frame[25]} OK · ${Math.max(0, frame.length - 30)}B 数据`
            : `FINS 响应 SID=${frame[25]} end=0x${(end & 0xffff).toString(16).padStart(4, '0')}`,
      );
      if (tcpErr !== 0) {
        this.pending?.reject(new Error(`FINS/TCP err 0x${tcpErr.toString(16)}`));
        this.pending = undefined;
        continue;
      }
      const endCode = frame.readUInt16BE(28);
      clearTimeout(this.pending?.timer);
      const pending = this.pending;
      this.pending = undefined;
      if (endCode !== 0) pending?.reject(new Error(`FINS end code 0x${endCode.toString(16)}`));
      else pending?.resolve(frame.subarray(30));
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
        const addr = parseFinsAddress(tag.address);
        if (addr.isBit) {
          const raw = await this.transceive(this.buildReadBit(addr));
          this.ctx.publish(tag.id, raw[0] === 0x01);
        } else {
          const words = tag.dataType === 'Float' || tag.dataType === 'Double' || tag.dataType === 'Int32' ? 2 : 1;
          const raw = await this.transceive(this.buildReadWords(addr, words));
          const b = Buffer.from(raw);
          let value: number;
          if (tag.dataType === 'Float') value = b.readFloatBE(0);
          else if (tag.dataType === 'Int32') value = b.readInt32BE(0);
          else if (tag.dataType === 'UInt16') value = b.readUInt16BE(0);
          else value = b.readInt16BE(0);
          this.ctx.publish(tag.id, value);
        }
      }
      this.ctx.setStatus('online', `OK ${Date.now() - t0}ms`);
    } catch (e) {
      this.ctx.setStatus('offline', `poll failed: ${String((e as Error).message ?? e)}`);
      // Recreate the TCP transport after a PLC/simulator restart. Keeping a
      // half-closed socket causes all later polls to remain offline forever.
      this.resetConnection();
      this.scheduleReconnect();
    } finally {
      this.busy = false;
    }
  }

  private resetConnection(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending?.reject(new Error('FINS connection reset'));
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = undefined;
    this.rx = Buffer.alloc(0);
    this.socket?.destroy();
    this.socket = undefined;
  }

}

/**
 * 连接测试探针（FR-M2-04）：临时 TCP 连接执行一次 FINS 读（字或 CIO 位），返回首值。
 * 与驱动同一套帧构造，但不启动轮询、不注册诊断捕获。
 */
export async function probeFins(
  host: string,
  port: number,
  address = 'D0',
): Promise<{ rttMs: number; value: number | boolean }> {
  const addr = parseFinsAddress(address);
  const socket = net.createConnection({ host, port });
  const t0 = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('TCP 连接超时')), 4000);
      socket.once('connect', () => { clearTimeout(t); resolve(); });
      socket.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    let frame = addr.isBit ? finsReadBitFrame(addr) : finsReadWordsFrame(addr, 1);
    frame = Buffer.from(frame); // 副本，避免改到模块级共享帧的 SID 字节
    frame[25] = 0x01; // SID
    const data = await new Promise<Buffer>((resolve, reject) => {
      let rx = Buffer.alloc(0);
      const t = setTimeout(() => reject(new Error('FINS 响应超时')), 4000);
      socket.on('data', (chunk) => {
        rx = Buffer.concat([rx, chunk]);
        while (rx.length >= 8) {
          if (rx.toString('ascii', 0, 4) !== 'FINS') { rx = rx.subarray(1); continue; }
          const total = 8 + rx.readUInt32BE(4);
          if (rx.length < total) return;
          const resp = rx.subarray(0, total);
          clearTimeout(t);
          if (resp.length < 30) return reject(new Error(`FINS response too short: ${resp.length}B`));
          const tcpErr = resp.readUInt32BE(12);
          if (tcpErr !== 0) return reject(new Error(`FINS/TCP err 0x${tcpErr.toString(16)}`));
          const end = resp.readUInt16BE(28);
          if (end !== 0) return reject(new Error(`FINS end code 0x${(end & 0xffff).toString(16)}`));
          resolve(resp.subarray(30));
          return;
        }
      });
      socket.once('error', (e) => { clearTimeout(t); reject(e); });
      socket.write(frame);
    });
    return { rttMs: Date.now() - t0, value: addr.isBit ? data[0] === 0x01 : Buffer.from(data).readInt16BE(0) };
  } finally {
    socket.destroy();
  }
}
