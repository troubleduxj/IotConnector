import type { Channel, ChannelStatus, ChannelState, Quality, Tag, TagValueUpdate } from '@iotconnector/shared';
import { createDriver, type Driver } from './driver';

interface TagRuntime {
  tag: Tag;
  value: number | string | boolean;
  quality: Quality;
  ts: number;
}

/**
 * 采集引擎：驱动生命周期、标度变换、变化检测、批量推送、存储采样分发。
 * 引擎与 UI 完全解耦（PRD 非功能：UI 重启不影响采集）。
 */
export class Engine {
  private runtimes = new Map<string, TagRuntime>();
  private drivers = new Map<string, Driver>();
  private statuses = new Map<string, ChannelStatus>();
  private changed: TagValueUpdate[] = [];
  private flushTimer?: NodeJS.Timeout;

  onBatch?: (values: TagValueUpdate[]) => void;
  onStatus?: (status: ChannelStatus) => void;
  /** 存储采样钩子（TDengine schemaless 写入等） */
  onSample?: (update: TagValueUpdate, tag: Tag) => void;

  constructor(
    private channels: Channel[],
    private tags: Tag[],
  ) {}

  start(): void {
    const byChannel = new Map<string, Tag[]>();
    for (const tag of this.tags) {
      const list = byChannel.get(tag.channelId) ?? [];
      list.push(tag);
      byChannel.set(tag.channelId, list);
      this.runtimes.set(tag.id, { tag, value: 0, quality: 'Uncertain', ts: 0 });
    }

    for (const channel of this.channels) {
      const channelTags = byChannel.get(channel.id) ?? [];
      const state: ChannelState = channel.enabled ? 'connecting' : 'disabled';
      this.statuses.set(channel.id, { id: channel.id, state });
      if (!channel.enabled) continue;

      const ctx = {
        channel,
        tags: channelTags,
        publish: (tagId: string, raw: number | string | boolean, quality: Quality = 'Good') =>
          this.publish(tagId, raw, quality),
        setStatus: (s: ChannelState, detail?: string) => this.setStatus(channel.id, s, detail),
      };
      const driver = createDriver(channel, ctx);
      this.drivers.set(channel.id, driver);
      void driver.start().catch((e) => this.setStatus(channel.id, 'error', String(e)));
    }

    // 300ms 批量 flush：合并变化值，避免高频小包
    this.flushTimer = setInterval(() => this.flush(), 300);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await Promise.allSettled([...this.drivers.values()].map((d) => d.stop()));
  }

  snapshot(): TagValueUpdate[] {
    return [...this.runtimes.values()]
      .filter((rt) => rt.ts > 0)
      .map((rt) => ({ id: rt.tag.id, value: rt.value, quality: rt.quality, ts: rt.ts }));
  }

  statusesList(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  /** 诊断写入：工程值 → 反标度为原始值 → 驱动下发 → 成功后本地回显 */
  async write(tagId: string, value: number | string | boolean): Promise<{ ok: boolean; error?: string }> {
    const rt = this.runtimes.get(tagId);
    if (!rt) return { ok: false, error: `unknown tag: ${tagId}` };
    const driver = this.drivers.get(rt.tag.channelId);
    if (!driver?.write) return { ok: false, error: 'channel driver does not support write' };
    try {
      const raw =
        typeof value === 'number' ? (value - (rt.tag.offset ?? 0)) / (rt.tag.scale || 1) : value;
      await driver.write(rt.tag, raw);
      this.publish(tagId, value, 'Good');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private publish(tagId: string, raw: number | string | boolean, quality: Quality): void {
    const rt = this.runtimes.get(tagId);
    if (!rt) return;

    let value: number | string | boolean = raw;
    if (typeof raw === 'number') {
      value = Number((raw * (rt.tag.scale || 1) + (rt.tag.offset ?? 0)).toFixed(4));
    }

    const now = Date.now();
    const unchanged = value === rt.value && quality === rt.quality;
    if (unchanged && now - rt.ts < 5000) return; // 心跳：每 5s 强制刷新一次

    rt.value = value;
    rt.quality = quality;
    rt.ts = now;

    const update: TagValueUpdate = { id: tagId, value, quality, ts: now };
    this.changed.push(update);
    this.onSample?.(update, rt.tag);
  }

  private setStatus(channelId: string, state: ChannelState, detail?: string): void {
    const prev = this.statuses.get(channelId);
    const next: ChannelStatus = { id: channelId, state, detail };
    if (state === 'online' && prev?.state === 'online' && prev.detail === detail) return;
    this.statuses.set(channelId, next);
    this.onStatus?.(next);
  }

  private flush(): void {
    if (!this.changed.length) return;
    const batch = this.changed;
    this.changed = [];
    this.onBatch?.(batch);
  }
}
