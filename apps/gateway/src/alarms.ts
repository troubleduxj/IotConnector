import type { AlarmEvent, AlarmRule, Quality, Tag } from '@iotconnector/shared';

/**
 * 告警引擎（PRD FR-M10-01）：限值（越上限/越下限）+ 偏差（|值-基准|）+ 变化率（|Δx|/s），
 * 均带回差消抖。状态机：Inactive → Active（越限）→ Cleared（回落到阈值 ± 回差内）。
 * 评估输入为工程值（引擎标度变换之后）。
 */
export class AlarmEngine {
  private rules: AlarmRule[] = [];
  private active = new Map<string, AlarmEvent>(); // ruleId → event
  private history: AlarmEvent[] = [];
  private seq = 0;
  /** roc 规则的上一次采样（ruleId → {value, ts}），用于计算每秒变化率 */
  private rocState = new Map<string, { value: number; ts: number }>();

  /** 告警事件回调（WS 广播用） */
  onEvent?: (event: AlarmEvent) => void;
  /** 事件持久化钩子（JSONL 追加 / TDengine 审计表） */
  onPersist?: (event: AlarmEvent) => void;

  static readonly MAX_HISTORY = 200;

  constructor(rules: AlarmRule[]) {
    this.rules = rules;
  }

  getRules(): AlarmRule[] {
    return [...this.rules];
  }

  setRules(rules: AlarmRule[]): void {
    this.rules = rules;
  }

  upsertRule(rule: AlarmRule): void {
    const i = this.rules.findIndex((r) => r.id === rule.id);
    if (i >= 0) this.rules[i] = rule;
    else this.rules.push(rule);
  }

  removeRule(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    this.rocState.delete(id);
    // 规则删除时，若其告警仍处于激活态则自动清除
    const active = this.active.get(id);
    if (active) {
      const cleared: AlarmEvent = { ...active, state: 'Cleared', ts: Date.now(), value: active.value };
      this.pushHistory(cleared);
      this.onEvent?.(cleared);
      this.active.delete(id);
    }
    return this.rules.length < before;
  }

  getActive(): AlarmEvent[] {
    return [...this.active.values()].sort((a, b) => b.ts - a.ts);
  }

  getHistory(limit = 50): AlarmEvent[] {
    return this.history.slice(0, limit);
  }

  /** 引擎每收到一个数值点调用一次（工程值） */
  evaluate(tag: Tag, value: number, quality: Quality): void {
    if (quality === 'Bad') return; // 坏质量不评估，避免误报
    for (const rule of this.rules) {
      if (!rule.enabled || rule.tagId !== tag.id) continue;
      const isActive = this.active.has(rule.id);
      const hyst = Math.max(0, rule.hysteresis);
      let shouldActivate = false;
      let shouldClear = false;

      if (rule.kind === 'high') {
        shouldActivate = !isActive && value > rule.threshold;
        shouldClear = isActive && value < rule.threshold - hyst;
      } else if (rule.kind === 'low') {
        shouldActivate = !isActive && value < rule.threshold;
        shouldClear = isActive && value > rule.threshold + hyst;
      } else if (rule.kind === 'deviation') {
        const dev = Math.abs(value - (rule.reference ?? 0));
        shouldActivate = !isActive && dev > rule.threshold;
        shouldClear = isActive && dev < rule.threshold - hyst;
      } else {
        // roc：与上次采样求每秒变化率；首个采样只记录基线
        const now = Date.now();
        const last = this.rocState.get(rule.id);
        this.rocState.set(rule.id, { value, ts: now });
        if (last) {
          const dtSec = (now - last.ts) / 1000;
          if (dtSec > 0) {
            const roc = Math.abs(value - last.value) / dtSec;
            shouldActivate = !isActive && roc > rule.threshold;
            shouldClear = isActive && roc < rule.threshold - hyst;
          }
        }
      }

      if (shouldActivate) {
        const defaultMsg = {
          high: `${tag.name} > ${rule.threshold}`,
          low: `${tag.name} < ${rule.threshold}`,
          deviation: `${tag.name} |x-${rule.reference ?? 0}| > ${rule.threshold}`,
          roc: `${tag.name} |Δx|/s > ${rule.threshold}`,
        }[rule.kind];
        const event: AlarmEvent = {
          id: `alm_${Date.now()}_${(this.seq += 1)}`,
          ruleId: rule.id,
          tagId: tag.id,
          tagName: tag.name,
          channel: tag.channelId,
          state: 'Active',
          kind: rule.kind,
          threshold: rule.threshold,
          value,
          ts: Date.now(),
          message: rule.message ?? defaultMsg,
        };
        this.active.set(rule.id, event);
        this.pushHistory(event);
        this.onEvent?.(event);
      } else if (shouldClear) {
        const prev = this.active.get(rule.id)!;
        const cleared: AlarmEvent = { ...prev, state: 'Cleared', value, ts: Date.now() };
        this.active.delete(rule.id);
        this.pushHistory(cleared);
        this.onEvent?.(cleared);
      }
    }
  }

  /** 告警确认（PRD FR-M10-01）：活动/历史事件标记确认人 */
  ack(eventId: string, user: string, note?: string): AlarmEvent | null {
    const apply = (e: AlarmEvent): AlarmEvent => ({ ...e, ack: { user, ts: Date.now(), note } });
    const activeEntry = [...this.active.entries()].find(([, e]) => e.id === eventId);
    if (activeEntry) {
      const updated = apply(activeEntry[1]);
      this.active.set(activeEntry[0], updated);
      this.history = this.history.map((h) => (h.id === eventId ? updated : h));
      this.onEvent?.(updated);
      return updated;
    }
    if (this.history.some((h) => h.id === eventId)) {
      const updated = apply({ ...this.history.find((h) => h.id === eventId)! });
      this.history = this.history.map((h) => (h.id === eventId ? updated : h));
      this.onEvent?.(updated);
      return updated;
    }
    return null;
  }

  private pushHistory(event: AlarmEvent): void {
    this.history.unshift(event);
    if (this.history.length > AlarmEngine.MAX_HISTORY) this.history.length = AlarmEngine.MAX_HISTORY;
    this.onPersist?.(event);
  }

  /** 启动时从持久层恢复历史（文件按时间正序存储，读入后倒序为最新在前） */
  loadHistory(events: AlarmEvent[]): void {
    this.history = [...events].reverse().slice(0, AlarmEngine.MAX_HISTORY);
  }
}
