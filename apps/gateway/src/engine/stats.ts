/**
 * 通道级通讯统计（PRD FR-M2-07）：报文收发计数、错误/超时计数、最近通讯时间、
 * 平均周期延迟。由三类真实信号汇聚：
 *  - pushFrame（帧级驱动）：TX/RX 真实线帧计数
 *  - s7/opcua 驱动轮询/订阅循环：按周期补计数（s7 每轮 1 请求/响应；opcua 订阅式只计 RX）
 *  - Engine.setStatus：online 周期的 "OK {ms}ms" 解析出周期延迟；error/offline 计入错误
 */

export interface ChannelCommStats {
  tx: number;
  rx: number;
  err: number;
  lastCommAt?: number;
  avgCycleMs?: number;
}

interface MutableStats extends ChannelCommStats {
  cycleMsSum: number;
  cycleMsCount: number;
}

const stats = new Map<string, MutableStats>();

function entry(channelId: string): MutableStats {
  let e = stats.get(channelId);
  if (!e) {
    e = { tx: 0, rx: 0, err: 0, cycleMsSum: 0, cycleMsCount: 0 };
    stats.set(channelId, e);
  }
  return e;
}

export function bumpTx(channelId: string, n = 1): void {
  entry(channelId).tx += n;
}

export function bumpRx(channelId: string, n = 1): void {
  const e = entry(channelId);
  e.rx += n;
  e.lastCommAt = Date.now();
}

export function bumpErr(channelId: string): void {
  entry(channelId).err += 1;
}

/** 记录一次成功采集周期耗时（驱动上报的 OK {ms}ms） */
export function recordCycle(channelId: string, ms: number): void {
  const e = entry(channelId);
  e.cycleMsSum += ms;
  e.cycleMsCount += 1;
  e.avgCycleMs = Math.round(e.cycleMsSum / e.cycleMsCount);
  e.lastCommAt = Date.now();
}

export function channelCommStats(channelId: string): ChannelCommStats {
  const e = stats.get(channelId);
  if (!e) return { tx: 0, rx: 0, err: 0 };
  const { cycleMsSum: _s, cycleMsCount: _c, ...rest } = e;
  return rest;
}
