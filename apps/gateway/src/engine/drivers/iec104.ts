import net from 'node:net';
import type { Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import {
  U, TYPE, COT, splitFrames, decodeFrame, encodeIFrame, encodeSFrame, cIc,
} from './iec104-codec';

/**
 * IEC 60870-5-104 驱动（电力远动）：
 * TCP 连接 → STARTDT 激活 → 按周期发送总召唤（C_IC_NA，cot=6）→ 解析
 * M_SP_NA（单点遥信，匹配 Bool 位号）与 M_ME_NC（浮点遥测，匹配数值位号）→ publish。
 * 位号地址 = IOA 数字（如 1 / 1001）。实现零依赖手写编解码（iec104-codec.ts）。
 */
export class Iec104Driver implements Driver {
  private sock?: net.Socket;
  private timer?: NodeJS.Timeout;
  private sendSeq = 0;
  private recvSeq = 0;
  private started = false;
  private buf = Buffer.alloc(0);
  private closing = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    const p = this.ctx.channel.params as Record<string, unknown>;
    this.commonAddr = Math.max(1, Number(p.commonAddress ?? 1));
    this.pollMs = Math.max(1000, this.ctx.channel.pollIntervalMs);
    // 地址合法性由创建通道时的 schema 校验保障（IOA:n）；此处容忍纯数字
    this.attach(new net.Socket());
    this.sock!.connect(this.ctx.channel.port, this.ctx.channel.host);
  }

  private commonAddr = 1;
  private pollMs = 5000;

  private attach(sock: net.Socket): void {
    this.sock = sock;
    sock.setNoDelay(true);
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('connect', () => {
      this.ctx.setStatus('connecting', 'TCP 已连，STARTDT 激活中…');
      sock.write(U.STARTDT_ACT);
      // 连接建立后延迟启动总召唤周期（等握手完成）
      setTimeout(() => {
        if (!this.started) return;
        void this.interrogate();
        this.timer = setInterval(() => void this.interrogate(), this.pollMs);
      }, 800);
    });
    sock.on('close', () => {
      this.started = false;
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.ctx.setStatus('offline', '连接已断开');
    });
    sock.on('error', (e) => this.ctx.setStatus('error', `连接失败: ${e.message}`));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest } = splitFrames(this.buf);
    this.buf = rest;
    for (const frame of frames) {
      const parsed = decodeFrame(frame);
      console.log(`[iec104] rx kind=${parsed.kind} ${parsed.asdu ? `type=${parsed.asdu.typeId} cot=${parsed.asdu.cot} pts=${parsed.asdu.points.length}` : ''} raw=${frame.toString('hex')}`);
      switch (parsed.kind) {
        case 'u-startdt-con': {
          this.started = true;
          this.ctx.setStatus('online', 'STARTDT 已确认');
          break;
        }
        case 'u-testfr-con':
          break;
        case 's':
          break;
        case 'i': {
          if (!parsed.asdu) break;
          // 数据帧响应确认：更新接收序号
          this.recvSeq = Math.max(this.recvSeq, (parsed.sendSeq ?? 0) + 1);
          const { typeId, cot, points } = parsed.asdu;
          if ((typeId === TYPE.M_SP_NA || typeId === TYPE.M_ME_NC) && points.length > 0) {
            for (const pt of points) {
              if (pt.qds & 0x80) continue; // IV 无效
              const tag = this.ctx.tags.find((t) => Number(t.address.replace(/^IOA:?/i, '')) === pt.ioa);
              if (!tag) continue;
              if (typeId === TYPE.M_SP_NA && tag.dataType === 'Bool') {
                this.ctx.publish(tag.id, Boolean(pt.value));
              } else if (typeId === TYPE.M_ME_NC && tag.dataType !== 'Bool') {
                this.ctx.publish(tag.id, Number(pt.value));
              }
            }
            this.ctx.setStatus('online', `收到 ${points.length} 点 (cot=${cot})`);
            // 回 S 帧确认
            if (this.sock) this.sock.write(encodeSFrame(this.recvSeq));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /** 总召唤（C_IC_NA cot=6 qoi=20） */
  private async interrogate(): Promise<void> {
    if (!this.sock || this.closing || !this.started) return;
    const seq = this.sendSeq;
    this.sendSeq = (this.sendSeq + 1) & 0x7fff;
    this.sock.write(encodeIFrame(cIc(COT.ACTIVATION, this.commonAddr), seq, this.recvSeq));
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.sock && this.started) {
      try {
        this.sock.write(U.STOPDT_ACT);
        this.sock.destroySoon();
      } catch {
        /* 忽略 */
      }
    } else {
      this.sock?.destroy();
    }
    this.sock = undefined;
  }
}
