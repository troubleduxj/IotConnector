import type { AlarmEvent, AlarmRule, Quality, Tag } from '@iotconnector/shared';

/**
 * 告警引擎（PRD FR-M10-01 最小集）：限值告警（越上限/越下限）+ 回差消抖。
 * 状态机：Inactive → Active（越限）→ Cleared（回落到阈值 ± 回差内）。
 * 评估输入为工程值（引擎标度变换之后）。
 */
export class AlarmEngine {
  private rules: AlarmRule[] = [];
  private active = new Map<string, AlarmEvent>(); // ruleId → event
  private history: AlarmEvent[] = [];
  private seq = 0;

  /** 告警事件回调（WS 广播用） */
  onEvent?: (event: AlarmEvent) => void;

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
      } else {
        shouldActivate = !isActive && value < rule.threshold;
        shouldClear = isActive && value > rule.threshold + hyst;
      }

      if (shouldActivate) {
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
          message: rule.message ?? `${tag.name} ${rule.kind === 'high' ? '>' : '<'} ${rule.threshold}`,
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

  private pushHistory(event: AlarmEvent): void {
    this.history.unshift(event);
    if (this.history.length > AlarmEngine.MAX_HISTORY) this.history.length = AlarmEngine.MAX_HISTORY;
  }
}
