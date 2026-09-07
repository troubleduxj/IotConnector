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
  if (frame.length < 27) return `FINS/TCP ${frame.length}B`;
  const mrc = frame[20];
  const src = frame[21];
  const sid = frame[19];
  const area = frame[22];
  const name = FINS_AREA_NAMES[area] ?? `0x${area.toString(16)}`;
  const word = frame.readUInt16BE(23);
  if (mrc === 0x01 && src === 0x01) {
    return `FINS 读字 ${name}${word}×${frame.readUInt16BE(25)} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x02 && area === 0x30) {
    return `FINS 读位 ${name}${word}.${String(frame[25]).padStart(2, '0')} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x02) {
    return `FINS 写字 ${name}${word}×${frame.readUInt16BE(25)} SID=${sid}`;
  }
  if (mrc === 0x01 && src === 0x03) {
    return `FINS 写位 ${name}${word}.${String(frame[25]).padStart(2, '0')} SID=${sid}`;
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
    const addr = parseFinsAddress(tag.address);
    if (addr.isBit) {
      await this.transceive(this.buildWriteBit(addr, Boolean(rawValue)));
      return;
    }
    await this.transceive(this.buildWriteWords(addr, this.encodeWords(tag, Number(rawValue))));
  }

  // ===== 帧 =====

  private finsWrap(fins: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.write('FINS', 0, 'ascii');
    head.writeUInt32BE(2 + fins.length, 4);
    return Buffer.concat([head, Buffer.from([0x02, 0x00]), fins]);
  }

  private dstHeader(): Buffer {
    // ICF(请求 0x80) RSV GCT DA DNA DA1 DA2 SNA SA1 SA2 SID
    return Buffer.from([0x80, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00]); // SID 由 transceive 填 @19
  }

  private addrBytes(addr: FinsAddress): Buffer {
    const b = Buffer.alloc(addr.isBit ? 3 : 2);
    b.writeUInt16BE(addr.word, 0);
    if (addr.isBit) b[2] = addr.bit ?? 0;
    return b;
  }

  private buildReadWords(addr: FinsAddress, words: number): Buffer {
    const fins = Buffer.concat([
      this.dstHeader(),
      Buffer.from([0x01, 0x01, addr.area]),
      this.addrBytes(addr),
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(words, 0); return b; })(),
    ]);
    return this.finsWrap(fins);
  }

  private buildReadBit(addr: FinsAddress): Buffer {
    const fins = Buffer.concat([
      this.dstHeader(),
      Buffer.from([0x01, 0x02, 0x30]),
      this.addrBytes(addr),
      Buffer.from([0x01]),
    ]);
    return this.finsWrap(fins);
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

  // ===== 收发（响应：TCP 头(8) + ICF..SID(10) + MRC/SRC(2) + endcode(2) + data(自 24)）=====

  private transceive(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('not connected'));
      this.pending?.reject(new Error('overridden'));
      clearTimeout(this.pending?.timer);
      this.sid = (this.sid + 1) & 0xff;
      frame[19] = this.sid & 0xff; // SID @19（TCP 10B 头之后第 9 字节）
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
      // 帧级捕获（重组后的完整帧才能解码）：TCP err@9、SID@19、endcode@22、数据@24
      const tcpErr = frame[9];
      const end = frame.length >= 24 ? frame.readUInt16BE(22) : -1;
      pushFrame(
        this.ctx.channel.id,
        'RX',
        frame,
        tcpErr !== 0
          ? `FINS/TCP 错误 0x${tcpErr.toString(16)}`
          : end === 0
            ? `FINS 响应 SID=${frame[19]} OK · ${Math.max(0, frame.length - 24)}B 数据`
            : `FINS 响应 SID=${frame[19]} end=0x${(end & 0xffff).toString(16).padStart(4, '0')}`,
      );
      if (frame[9] !== 0x00) {
        this.pending?.reject(new Error(`FINS/TCP err 0x${frame[9].toString(16)}`));
        this.pending = undefined;
        continue;
      }
      // fins 帧：0 ICF 1 RSV 2 GCT 3 DNA 4 DA1 5 DA2 6 SNA 7 SA1 8 SA2 9 SID 10 MRC 11 SRC 12..13 endcode → 数据自 14
      const endCode = frame.readUInt16BE(22); // endcode 在 fins 头 10B + MRC/SRC 2B 之后
      clearTimeout(this.pending?.timer);
      const pending = this.pending;
      this.pending = undefined;
      if (endCode !== 0) pending?.reject(new Error(`FINS end code 0x${endCode.toString(16)}`));
      else pending?.resolve(frame.subarray(24)); // 数据自 24 起（endcode 在 22..23）
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
    } finally {
      this.busy = false;
    }
  }

}
