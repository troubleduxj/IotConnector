import { describe, expect, it } from 'vitest';
import type { Tag } from '@iotconnector/shared';
import { AlarmEngine } from '../src/alarms';

const tag: Tag = { id: 't1', channelId: 'c1', name: 'X.Temperature', address: 'DB1.Real0', dataType: 'Float', unit: '°C', scale: 1, offset: 0 };

function makeEngine(threshold = 36, hysteresis = 0.5): AlarmEngine {
  return new AlarmEngine([
    { id: 'r1', tagId: 't1', kind: 'high', threshold, hysteresis, enabled: true, message: 'temp high' },
  ]);
}

describe('AlarmEngine（限值 + 回差状态机）', () => {
  it('越限触发 Active 事件', () => {
    const engine = makeEngine();
    const events: string[] = [];
    engine.onEvent = (e) => events.push(e.state);
    engine.evaluate(tag, 35); // 未越限
    engine.evaluate(tag, 36.5); // 越限
    expect(events).toEqual(['Active']);
    expect(engine.getActive()).toHaveLength(1);
  });

  it('回落到回差内才 Cleared', () => {
    const engine = makeEngine(36, 0.5);
    const states: string[] = [];
    engine.onEvent = (e) => states.push(e.state);
    engine.evaluate(tag, 36.5); // Active
    engine.evaluate(tag, 35.8); // 仍在回差内（36-0.5=35.5 以上不清除）
    expect(engine.getActive()).toHaveLength(1);
    engine.evaluate(tag, 35.4); // 回差内 → Cleared
    expect(states).toEqual(['Active', 'Cleared']);
    expect(engine.getActive()).toHaveLength(0);
  });

  it('Bad 质量不评估', () => {
    const engine = makeEngine();
    engine.evaluate(tag, 40, 'Bad');
    expect(engine.getActive()).toHaveLength(0);
  });

  it('停用规则不触发', () => {
    const engine = makeEngine();
    engine.setRules(engine.getRules().map((r) => ({ ...r, enabled: false })));
    engine.evaluate(tag, 40);
    expect(engine.getActive()).toHaveLength(0);
  });

  it('ack 标记确认人', () => {
    const engine = makeEngine();
    engine.evaluate(tag, 36.5);
    const active = engine.getActive()[0];
    const updated = engine.ack(active.id, 'operator_a', '已知悉');
    expect(updated?.ack).toMatchObject({ user: 'operator_a' });
  });

  it('偏差告警：|值-基准| 越限触发，回落回差内清除', () => {
    const engine = new AlarmEngine([
      { id: 'r2', tagId: 't1', kind: 'deviation', threshold: 2, reference: 10, hysteresis: 0.5, enabled: true },
    ]);
    const states: string[] = [];
    engine.onEvent = (e) => states.push(e.state);
    engine.evaluate(tag, 11); // |11-10|=1 未越限
    expect(engine.getActive()).toHaveLength(0);
    engine.evaluate(tag, 12.5); // 2.5 > 2 → Active
    expect(engine.getActive()).toHaveLength(1);
    expect(engine.getActive()[0].message).toContain('|x-10|');
    engine.evaluate(tag, 8.2); // |8.2-10|=1.8 在回差内不清除
    expect(engine.getActive()).toHaveLength(1);
    engine.evaluate(tag, 8.6); // 1.4 < 2-0.5 → Cleared
    expect(states).toEqual(['Active', 'Cleared']);
  });

  it('变化率告警：每秒变化超限触发，平稳后清除', async () => {
    const engine = new AlarmEngine([
      { id: 'r3', tagId: 't1', kind: 'roc', threshold: 5, hysteresis: 1, enabled: true },
    ]);
    const states: string[] = [];
    engine.onEvent = (e) => states.push(e.state);
    engine.evaluate(tag, 20); // 首个采样只记基线
    expect(engine.getActive()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1100));
    engine.evaluate(tag, 26); // 6/s > 5 → Active
    expect(engine.getActive()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    engine.evaluate(tag, 26.5); // 0.5/s < 5-1 → Cleared
    expect(states).toEqual(['Active', 'Cleared']);
  });

  it('删除 roc 规则清理其采样基线', async () => {
    const engine = new AlarmEngine([
      { id: 'r4', tagId: 't1', kind: 'roc', threshold: 5, hysteresis: 0, enabled: true },
    ]);
    engine.evaluate(tag, 20);
    expect(engine.removeRule('r4')).toBe(true);
    expect(engine.getRules()).toHaveLength(0);
  });
});
