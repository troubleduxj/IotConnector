import type { Quality } from '@iotconnector/shared';

/**
 * 设备影子（PRD FR-M9-04 / TASKS #22）：
 * 边缘侧维护每个位号的最新状态快照（reported，真实上报值）
 * 与期望值（desired，写管道下发的目标值），desired ≠ reported 时为 pending。
 * 快照以 retain 消息发布到 MQTT（订阅即得最新状态，等价"查询"）。
 * 状态持久化到 data/shadow.json（重启恢复）。
 */

export interface ShadowReported {
  value: number | string | boolean;
  quality: Quality;
  ts: number;
}

export interface ShadowDesired {
  value: number | string | boolean;
  ts: number;
  by: string;
}

export interface TagShadow {
  tagId: string;
  name: string;
  channel: string;
  reported?: ShadowReported;
  desired?: ShadowDesired;
  /** pending = 期望值与上报值不一致（待确认收敛）；reported = 已一致或尚无期望值 */
  state: 'reported' | 'pending';
}

interface ShadowFile {
  version: 1;
  reported: Array<{ tagId: string } & ShadowReported>;
  desired: Array<{ tagId: string } & ShadowDesired>;
}

export class DeviceShadow {
  private reported = new Map<string, ShadowReported>();
  private desired = new Map<string, ShadowDesired>();
  private persistTimer?: NodeJS.Timeout;
  /** 影子有变化时回调（index.ts 节流后发布 MQTT retain 快照） */
  onChange?: () => void;

  constructor(
    private file: { path: string; read: (p: string) => string; write: (p: string, data: unknown) => void },
  ) {}

  loadPersisted(): void {
    try {
      const data = JSON.parse(this.file.read(this.file.path)) as ShadowFile;
      if (data.version !== 1) return;
      for (const r of data.reported ?? []) this.reported.set(r.tagId, { value: r.value, quality: r.quality, ts: r.ts });
      for (const d of data.desired ?? []) this.desired.set(d.tagId, { value: d.value, ts: d.ts, by: d.by });
    } catch { /* 首次运行无文件 */ }
  }

  /** 节流持久化：采集高频触发，合并到 5s 窗口落盘 */
  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 5000);
  }

  private persistNow(): void {
    const data: ShadowFile = {
      version: 1,
      reported: [...this.reported].map(([tagId, r]) => ({ tagId, ...r })),
      desired: [...this.desired].map(([tagId, d]) => ({ tagId, ...d })),
    };
    try {
      this.file.write(this.file.path, data);
    } catch { /* 持久化失败不阻塞采集 */ }
  }

  /** 采集上报（engine.onBatch） */
  setReported(tagId: string, value: number | string | boolean, quality: Quality, ts: number): void {
    this.reported.set(tagId, { value, quality, ts });
    this.persist();
    this.onChange?.();
  }

  /** 写管道下发成功（手动写/配方/脚本）；写操作低频，立即落盘 */
  setDesired(tagId: string, value: number | string | boolean, by: string): void {
    this.desired.set(tagId, { value, ts: Date.now(), by });
    this.persistNow();
    this.onChange?.();
  }

  /** 位号删除/通道删除时修剪 */
  clearTag(tagId: string): void {
    this.reported.delete(tagId);
    this.desired.delete(tagId);
    this.persistNow();
  }

  /** 进程退出前强制落盘 */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.persistNow();
  }

  snapshot(meta: (tagId: string) => { name: string; channel: string } | undefined): TagShadow[] {
    const ids = new Set([...this.reported.keys(), ...this.desired.keys()]);
    const out: TagShadow[] = [];
    for (const id of ids) {
      const m = meta(id);
      if (!m) continue; // 位号已删除的残留影子不展示
      const reported = this.reported.get(id);
      const desired = this.desired.get(id);
      const pending = desired !== undefined && (reported === undefined || reported.value !== desired.value);
      out.push({ tagId: id, name: m.name, channel: m.channel, reported, desired, state: pending ? 'pending' : 'reported' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  pendingCount(meta: (tagId: string) => { name: string; channel: string } | undefined): number {
    return this.snapshot(meta).filter((s) => s.state === 'pending').length;
  }
}
