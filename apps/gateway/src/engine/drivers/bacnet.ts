import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';

/**
 * BACnet/IP 驱动（楼宇自控：HVAC/冷机/照明/电力表）—— raw dgram 实现。
 * 位号地址 = 对象类型:实例（AI:1 / AO:2 / AV:3 / BI:1 / BO:4 / BV:5），读 PresentValue(85)。
 *
 * 说明：bacstack beta 的 transport 发送目标端口恒等于本地绑定端口（BACnet 标准同 47808），
 * 同机模拟器/多设备演示必然端口冲突；故本驱动以任意本地端口 + 显式目标 host:port 的 raw
 * dgram 收发，编解码复用 bacstack 内部模块（apdu/npdu/bvlc/services/asn1）。
 */
const require = createRequire(import.meta.url);
const baEnum = require('bacstack/lib/enum');
const baNpdu = require('bacstack/lib/npdu');
const baApdu = require('bacstack/lib/apdu');
const baBvlc = require('bacstack/lib/bvlc');
const baServices = require('bacstack/lib/services');

const OBJECT_TYPES: Record<string, number> = {
  AI: 0, AO: 1, AV: 2, BI: 3, BO: 4, BV: 5, MSI: 13,
};
const DEFAULT_HOP_COUNT = 0xff;
const P_PRESENT_VALUE = 85;

export class BacnetDriver implements Driver {
  private sock?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private bindings: Array<{ tag: Tag; objectType: number; instance: number }> = [];
  private invokeCounter = 1;
  /** 等待中的请求：invokeId → resolve */
  private pending = new Map<number, (err: Error | null, value?: number | string | boolean) => void>();
  /** 本地绑定的端口（写响应目标 = 请求源，无需记录） */
  private port = 0;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    for (const tag of this.ctx.tags) {
      const m = tag.address.match(/^(AI|AO|AV|BI|BO|BV|MSI):(\d+)$/i);
      if (!m) {
        this.ctx.setStatus('error', `地址非法: ${tag.address}`);
        return;
      }
      this.bindings.push({ tag, objectType: OBJECT_TYPES[m[1].toUpperCase()], instance: Number(m[2]) });
    }
    if (this.bindings.length === 0) return;

    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg: Buffer) => this.onResponse(msg));
    this.sock.on('error', () => undefined); // UDP 错误不致命
    await new Promise<void>((resolve) => this.sock!.bind(0, '0.0.0.0', () => resolve()));

    await this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(200, this.ctx.channel.pollIntervalMs));
  }

  private nextInvokeId(): number {
    const id = this.invokeCounter++;
    if (id >= 256) this.invokeCounter = 1;
    return id;
  }

  private onResponse(msg: Buffer): void {
    if (msg.length < 5 || msg[0] !== 0x81) return;
    // APDU 起点：BVLC 头(4) + NPDU 不定长 → 定位 Confirmed-Response(0x30)
    let off = 4;
    const npduLen = this.npduLength(msg, off);
    off += npduLen;
    if (msg[off] !== 0x30 && msg[off] !== 0x20) return; // confirmed-response / simple-ack
    const invokeId = msg[off + 1];
    const cb = this.pending.get(invokeId);
    if (!cb) return;
    this.pending.delete(invokeId);
    cb(null);
    if (msg[off] === 0x30) void this.dispatchResponse(msg.subarray(off), invokeId);
  }

  private dispatchResponse(apdu: Buffer, invokeId: number): void {
    // 已由 onResponse 置空 pending 后按类型分发；此处仅解析数值
    const service = apdu[3];
    const body = apdu.subarray(4);
    try {
      if (service === 14) { // ReadPropertyMultiple-Ack (service choice 0x0e)
        const result = baServices.readPropertyMultiple.decodeAcknowledge(body, 0, body.length);
        if (!result) return;
        for (const res of result.values) {
          const b = this.bindings.find((x) => x.objectType === res.objectId.type && x.instance === res.objectId.instance);
          if (!b) continue;
          const values = res.values ?? [];
          const first = values[0]?.value?.[0];
          if (first && first.value !== undefined && first.type !== 'BacnetError') {
            let v = this.coerce(first.type, first.value);
            if (b.tag.dataType === 'Bool') v = v === 1 || v === true || v === '1' || v === 'true';
            this.ctx.publish(b.tag.id, v);
          }
        }
        this.ctx.setStatus('online', `OK ${this.bindings.length} 对象`);
      } else if (service === 12) { // ReadProperty-Ack（连接测试探针）
        const result = baServices.readProperty.decodeAcknowledge(body, 0, body.length);
        const first = result?.values?.[0];
        if (first && first.value && first.value.type !== 'BacnetError') {
          // 无需发布（测试器场景），直接忽略
        }
      }
    } catch {
      /* 解码异常忽略 */
    }
  }

  private npduLength(msg: Buffer, start: number): number {
    // NPDU: 控制字节；含 DNET/DADR（长度 2+2+n）或 SNET 时需展开
    let off = start;
    // NPDU always begins with protocol version 0x01, followed by control.
    // Older local fixtures omitted the version, so retain compatibility with
    // a direct control byte as well.
    if (msg[off] === 0x01) off++;
    const ctrl = msg[off++];
    if (ctrl & 0x20) { // 含目的地址：DNET(2) + DLEN(1) + DADR
      off += 3;
      off += msg[off - 1]; // DLEN 字节在 off-1
    }
    if (ctrl & 0x10) { // 含源地址：SNET(2) + SLEN(1) + SADR
      off += 2;
      const slen = msg[off];
      off += 1 + slen;
    }
    if (ctrl & 0x08) off += 1; // 跳数
    return off - start;
  }

  private async poll(): Promise<void> {
    if (!this.sock || this.busy || this.bindings.length === 0) return;
    this.busy = true;
    try {
      const props = this.bindings.map((b) => ({
        objectId: { type: b.objectType, instance: b.instance },
        properties: [{ id: P_PRESENT_VALUE }],
      }));
      const invokeId = this.nextInvokeId();
      const buf = this.encodeRpmRequest(props, invokeId);
      console.log(`[bacnet] tx ${buf.length}B: ${buf.toString('hex')}`);
      const p = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ERR_TIMEOUT')), Math.max(1000, this.ctx.channel.pollIntervalMs) + 1000);
        this.pending.set(invokeId, () => { clearTimeout(timer); resolve(); });
        this.sock!.send(buf, this.ctx.channel.port, this.ctx.channel.host, (e) => { if (e) reject(e); });
      });
      await p;
      this.ctx.setStatus('online', 'RPM OK');
    } catch (e) {
      this.ctx.setStatus('offline', `readPropertyMultiple: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private encodeRpmRequest(props: Array<{ objectId: { type: number; instance: number }; properties: Array<{ id: number }> }>, invokeId: number): Buffer {
    // Confirmed-Request: PDU type | max-segments/max-APDU | invokeId | service.
    // 0x02 means segmented response accepted; this request itself is not segmented.
    const bodyBuf = { buffer: Buffer.alloc(2048), offset: 0 };
    baServices.readPropertyMultiple.encode(bodyBuf, props);
    const body = bodyBuf.buffer.subarray(0, bodyBuf.offset);
    const apdu = Buffer.concat([Buffer.from([0x02, 0x00, invokeId, 14]), body]);
    const total = apdu.length + 2;
    const out = Buffer.concat([Buffer.from([0x81, 0x0a, (total >> 8) & 0xff, total & 0xff, 0x01, 0x00]), apdu]);
    return out;
  }

  private coerce(type: number, value: unknown): number | string | boolean {
    return coerceBacnetValue(type, value);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sock?.close();
    this.sock = undefined;
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    const binding = this.bindings.find((item) => item.tag.id === tag.id);
    if (!binding || !this.sock) throw new Error(`BACnet tag not bound: ${tag.id}`);
    const invokeId = this.nextInvokeId();
    const type = tag.dataType === 'Bool'
      ? baEnum.ApplicationTags.BOOLEAN
      : tag.dataType === 'String'
        ? baEnum.ApplicationTags.CHARACTER_STRING
        : baEnum.ApplicationTags.REAL;
    const bodyBuf = { buffer: Buffer.alloc(256), offset: 0 };
    baServices.writeProperty.encode(bodyBuf, binding.objectType, binding.instance, P_PRESENT_VALUE,
      baEnum.ASN1_ARRAY_ALL, baEnum.ASN1_NO_PRIORITY, [{ type, value: rawValue }]);
    // Standard non-segmented confirmed request with segmented response accepted.
    const apdu = Buffer.concat([Buffer.from([0x02, 0x00, invokeId, 15]), bodyBuf.buffer.subarray(0, bodyBuf.offset)]);
    const total = apdu.length + 2;
    const packet = Buffer.concat([Buffer.from([0x81, 0x0a, (total >> 8) & 0xff, total & 0xff, 0x01, 0x00]), apdu]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(invokeId);
        reject(new Error('ERR_TIMEOUT'));
      }, 3000);
      this.pending.set(invokeId, (err) => {
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      });
      this.sock!.send(packet, this.ctx.channel.port, this.ctx.channel.host, (err) => {
        if (err) {
          this.pending.delete(invokeId);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }
}

/** BACnet 应用标签值 → 网关值（导出供单测） */
export function coerceBacnetValue(type: number, value: unknown): number | string | boolean {
  if (type === baEnum.ApplicationTags.BOOLEAN) return Boolean(value);
  if (type === baEnum.ApplicationTags.REAL || type === baEnum.ApplicationTags.DOUBLE
    || type === baEnum.ApplicationTags.UNSIGNED_INTEGER || type === baEnum.ApplicationTags.SIGNED_INTEGER) {
    const n = Number(value);
    return Number.isNaN(n) ? String(value) : n;
  }
  if (type === baEnum.ApplicationTags.CHARACTER_STRING) return String(value);
  return String(value);
}
