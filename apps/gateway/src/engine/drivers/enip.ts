import net from 'node:net';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import { pushFrame } from '../../diagnostics';

const RECONNECT_MS = 6000;

/** CIP 数据类型码（0xC1 BOOL / 0xC3 INT / 0xC4 DINT / 0xCA REAL） */
const CIP_TYPE: Record<string, number> = { Bool: 0xc1, Int16: 0xc3, UInt16: 0xc3, Int32: 0xc4, Float: 0xca };

// ===== ENIP 封装（标准 24 字节头）=====

function encap(cmd: number, session: number, body: Buffer): Buffer {
  const h = Buffer.alloc(24);
  h.writeUInt16LE(cmd, 0);
  h.writeUInt16LE(body.length, 2);
  h.writeUInt32LE(session, 4);
  h.writeUInt32LE(0, 8); // status
  // sender context 12..19 保持 0，options 20..23 保持 0
  return Buffer.concat([h, body]);
}

// ===== CIP =====

/** 符号名 IOI：0x91 + len + ANSI + 奇数补零 */
function ioiSymbolic(name: string): Buffer {
  const bytes = Buffer.from(name, 'ascii');
  const pad = bytes.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x91, bytes.length]), bytes, pad]);
}

function cipValueBytes(dataType: string, value: number | string | boolean): Buffer {
  const v = Buffer.alloc(dataType === 'Float' ? 4 : dataType === 'Bool' ? 1 : 2);
  if (dataType === 'Float') v.writeFloatLE(Number(value));
  else if (dataType === 'Bool') v[0] = value ? 1 : 0;
  else v.writeInt16LE(Number(value));
  return v;
}

// ===== 报文诊断解码 =====

const ENIP_CMDS: Record<number, string> = {
  0x0065: 'RegisterSession',
  0x0066: 'UnRegisterSession',
  0x006e: 'SendUnitData',
  0x006f: 'SendRRData',
};

/** SendRRData 数据项 → Unconnected Send 解包 → 服务码 + IOI 符号名 */
function describeEnipCip(payload: Buffer | undefined): string {
  if (!payload) return '';
  let embedded = payload;
  let service = payload[0];
  if (service === 0x4c && payload.length >= 3) {
    const msgLen = payload.readUInt16LE(1);
    embedded = payload.subarray(3, 3 + msgLen);
    service = embedded[0];
  }
  const pathSize = embedded[1] ?? 0;
  const ioi = embedded.subarray(2, 2 + pathSize * 2);
  const tag = ioi[0] === 0x91 && ioi.length >= 2 ? ioi.toString('ascii', 2, 2 + ioi[1]) : '';
  if (service === 0x4e) return `读 ${tag}`;
  if (service === 0x4d) return `写 ${tag}`;
  return `service=0x${service.toString(16)} ${tag}`;
}

/** TX 帧解码：Encapsulation 命令 +（SendRRData 时）CIP 服务/位号 */
function describeEnipRequest(frame: Buffer): string {
  const cmd = frame.readUInt16LE(0);
  const name = ENIP_CMDS[cmd] ?? `0x${cmd.toString(16)}`;
  if (cmd !== 0x006f || frame.length < 38) return `ENIP ${name}`;
  const itemCount = frame.readUInt16LE(30);
  let p = 32;
  let payload: Buffer | undefined;
  for (let i = 0; i < itemCount && p + 4 <= frame.length; i += 1) {
    const type = frame.readUInt16LE(p);
    const len = frame.readUInt16LE(p + 2);
    if (type === 0xb1) payload = frame.subarray(p + 4, p + 4 + len);
    p += 4 + len;
  }
  const cip = describeEnipCip(payload);
  return cip ? `ENIP SendRRData ${cip}` : `ENIP SendRRData ${frame.length}B`;
}

/** RX 帧解码：Encapsulation 命令 + status */
function describeEnipResponse(frame: Buffer): string {
  const cmd = frame.readUInt16LE(0);
  const name = ENIP_CMDS[cmd] ?? `0x${cmd.toString(16)}`;
  const status = frame.readUInt32LE(8);
  return `ENIP 响应 ${name} status=0x${status.toString(16).padStart(8, '0')} (${frame.length}B)`;
}

/**
 * EtherNet/IP（CIP）驱动 —— 自研裸实现：
 * Register Session + SendRRData（Unconnected Send 包装 Symbolic Read/Write Tag）。
 * 简化说明：IOI 仅含符号段（单 tag 名，无数组/成员）；路由路径固定 背板1/槽0。
 * 接入真实 ControlLogix/Emulator 时若路径不同，仅需调整 buildUnconnected 中 route 段。
 */
export class EnipDriver implements Driver {
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private session = 0;
  private rx = Buffer.alloc(0);
  private pending?: { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

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
      const sock = this.socket;
      sock.on('error', () => { if (this.socket === sock) this.handleDisconnect('socket error'); });
      sock.on('close', () => { if (this.socket === sock) this.handleDisconnect('socket closed'); });
      // Register Session
      const body = Buffer.alloc(4);
      body.writeUInt16LE(1, 0); // version
      const resp = await this.transceive(encap(0x0065, 0, body));
      this.session = resp.readUInt32LE(4);
      this.ctx.setStatus('online', `CIP session ${this.session}`);
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
    this.session = 0;
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    // Write Tag Service (0x4D)：pathSize + IOI + type + value
    const ioi = ioiSymbolic(tag.address);
    const embedded = Buffer.concat([
      Buffer.from([0x4d, ioi.length / 2]),
      ioi,
      Buffer.from([CIP_TYPE[tag.dataType] & 0xff, 0x00]),
      cipValueBytes(tag.dataType, rawValue),
    ]);
    await this.transceive(this.buildUnconnected(embedded));
  }

  // ===== Unconnected Send 包装 =====

  private buildUnconnected(embedded: Buffer): Buffer {
    const route = Buffer.from([0x01, 0x00, 0x20, 0x02, 0x24, 0x01]); // 背板 1，槽 0（Message Router 0xF5/1）
    const rr = Buffer.concat([
      Buffer.from([0x4c]), // Unconnected Send
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(embedded.length, 0); return b; })(),
      embedded,
      route,
      (embedded.length + route.length) % 2 ? Buffer.from([0x00]) : Buffer.alloc(0),
    ]);
    const body = Buffer.alloc(6);
    body.writeUInt32LE(0, 0); // interface handle
    body.writeUInt16LE(0, 4); // timeout
    const items = Buffer.from([0x02, 0x00]);
    const addrItem = Buffer.from([0xa1, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const dataItem = Buffer.concat([Buffer.from([0xb1, 0x00]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(rr.length, 0); return b; })(), rr]);
    const out = Buffer.concat([body, items, addrItem, dataItem]);
    return encap(0x006f, this.session, out);
  }

  // ===== 收发 =====

  private transceive(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('not connected'));
      this.pending?.reject(new Error('overridden'));
      clearTimeout(this.pending?.timer);
      pushFrame(this.ctx.channel.id, 'TX', frame, describeEnipRequest(frame));
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('响应超时'));
      }, 4000);
      this.pending = { resolve, reject, timer };
      this.socket.write(frame);
    });
  }

  private onData(chunk: Buffer): void {
    this.rx = Buffer.concat([this.rx, chunk]);
    while (this.rx.length >= 24) {
      const len = this.rx.readUInt16LE(2);
      const total = 24 + len;
      if (this.rx.length < total) return;
      const frame = Buffer.from(this.rx.subarray(0, total));
      this.rx = this.rx.subarray(total);
      // 帧级捕获（重组后的完整帧才能解码）
      pushFrame(this.ctx.channel.id, 'RX', frame, describeEnipResponse(frame));
      const status = frame.readUInt32LE(8);
      clearTimeout(this.pending?.timer);
      const pending = this.pending;
      this.pending = undefined;
      if (status !== 0) pending?.reject(new Error(`ENIP status 0x${status.toString(16)}`));
      else pending?.resolve(frame);
    }
  }

  // ===== 轮询 =====

  /** 运行期断线：清理 socket/定时器并走重连（对端重启、网络闪断等） */
  private handleDisconnect(reason: string): void {
    if (this.stopped || !this.socket) return;
    this.ctx.setStatus('offline', reason);
    this.socket.destroy();
    this.socket = undefined;
    this.session = 0;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.scheduleReconnect();
  }

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
        // Read Tag Service (0x4E) + IOI
        // Read Tag Service (0x4E)：pathSize（IOI 字数）+ IOI
        const ioi = ioiSymbolic(tag.address);
        const embedded = Buffer.concat([Buffer.from([0x4e, ioi.length / 2]), ioi]);
        const resp = await this.transceive(this.buildUnconnected(embedded));
        // 解析 SendRRData：24 头 + [iface 4][timeout 2][itemCount 2][addrItem 8][dataItem(type 2 + len 2 + rr)]
        const p0 = 24;
        const itemCount = resp.readUInt16LE(p0 + 6);
        let p = p0 + 8;
        // addr item
        const addrType = resp.readUInt16LE(p); p += 2;
        const addrLen = resp.readUInt16LE(p); p += 2 + addrLen;
        void addrType;
        // data item
        const dataType = resp.readUInt16LE(p); p += 2;
        const dataLen = resp.readUInt16LE(p); p += 2;
        if (itemCount !== 2 || dataType !== 0xb1) throw new Error('响应结构异常');
        // rr：Unconnected Send 响应（0xCC）= [0xCC][genStatus][embLen u16][embedded]；
        // 直连响应则为 [0xCE][status][type u16][value…]
        let rr = p;
        const wrapService = resp[rr];
        if (wrapService === 0xcc) rr += 4; // 跳过 0xCC + genStatus + embLen
        const service = resp[rr];
        const cipStatus = resp[rr + 1];
        const valType = resp.readUInt16LE(rr + 2);
        if (cipStatus !== 0 || (wrapService !== 0xcc && service !== 0xce)) {
          throw new Error(`CIP 读失败 service=0x${service?.toString(16)} status=0x${cipStatus?.toString(16)}`);
        }
        const valOff = rr + 4;
        const raw = resp.subarray(valOff, valOff + (valType === 0xca ? 4 : valType === 0xc1 ? 1 : 2));
        if (tag.dataType === 'Bool') this.ctx.publish(tag.id, raw[0] === 0x01);
        else if (tag.dataType === 'Float') this.ctx.publish(tag.id, Number(raw.readFloatLE(0).toFixed(4)));
        else this.ctx.publish(tag.id, raw.readInt16LE(0));
      }
      this.ctx.setStatus('online', `OK ${Date.now() - t0}ms`);
    } catch (e) {
      const msg = `poll failed: ${String((e as Error).message ?? e)}`;
      if (!this.socket || this.socket.destroyed) this.handleDisconnect(msg);
      else this.ctx.setStatus('offline', msg);
    } finally {
      this.busy = false;
    }
  }
}
