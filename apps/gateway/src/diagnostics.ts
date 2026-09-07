/**
 * 报文诊断（PRD FR-M2-20）：每通道环形帧缓冲（内存，各 200 帧）。
 * 帧来源：驱动层真实 TCP 字节流（Modbus 通过 socket tap 捕获）。
 */
import { bumpRx, bumpTx } from './engine/stats';

export interface CapturedFrame {
  ts: number;
  dir: 'TX' | 'RX';
  hex: string;
  bytes: number;
  note?: string;
}

const BUFFERS = new Map<string, CapturedFrame[]>();
const MAX_FRAMES = 200;

export function pushFrame(channelId: string, dir: 'TX' | 'RX', frame: Buffer, note?: string): void {
  // FR-M2-07：帧级收发计数（同帧也计入通讯统计的 tx/rx 与 lastCommAt）
  if (dir === 'TX') bumpTx(channelId);
  else bumpRx(channelId);
  const buf = BUFFERS.get(channelId) ?? [];
  buf.push({
    ts: Date.now(),
    dir,
    hex: frame.toString('hex').toUpperCase().match(/../g)?.join(' ') ?? '',
    bytes: frame.length,
    note,
  });
  if (buf.length > MAX_FRAMES) buf.splice(0, buf.length - MAX_FRAMES);
  BUFFERS.set(channelId, buf);
}

export function getFrames(channelId: string, limit = 100, dir?: 'TX' | 'RX'): CapturedFrame[] {
  const frames = BUFFERS.get(channelId) ?? [];
  const filtered = dir ? frames.filter((f) => f.dir === dir) : frames;
  return filtered.slice(-limit);
}

export function clearFrames(channelId: string): void {
  BUFFERS.delete(channelId);
}

/** 通道删除时清理缓冲 */
export function dropChannelFrames(channelId: string): void {
  BUFFERS.delete(channelId);
}
