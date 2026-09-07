import { describe, it, expect, vi } from 'vitest';
import { ScriptEngine } from '../src/scripts';
import type { Script } from '@iotconnector/shared';

const makeScript = (over: Partial<Script> = {}): Script => ({
  id: 'scr_1',
  name: '测试脚本',
  description: '',
  code: "log('hi');",
  trigger: { type: 'manual' },
  enabled: true,
  ...over,
});

const makeEngine = (): ScriptEngine =>
  new ScriptEngine(
    () => 1,
    () => undefined,
    async () => undefined,
  );

describe('ScriptEngine 运行监控（FR-M8-06）', () => {
  it('成功执行累计 runs 并记录耗时', async () => {
    const engine = makeEngine();
    engine.setScripts([makeScript()]);
    const r = await engine.runScript('scr_1');
    expect(r.ok).toBe(true);
    const st = engine.getRunStats('scr_1');
    expect(st.runs).toBe(1);
    expect(st.consecutiveErrors).toBe(0);
    expect(st.lastDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('执行错误累计 errors/consecutiveErrors', async () => {
    const engine = makeEngine();
    engine.setScripts([makeScript({ code: 'throw new Error("boom");' })]);
    await engine.runScript('scr_1');
    await engine.runScript('scr_1');
    const st = engine.getRunStats('scr_1');
    expect(st.errors).toBe(2);
    expect(st.consecutiveErrors).toBe(2);
    expect(st.lastError).toContain('boom');
  });

  it('成功一次即清零 consecutiveErrors', async () => {
    const engine = makeEngine();
    engine.setScripts([makeScript({ code: 'throw new Error("x");' })]);
    await engine.runScript('scr_1');
    // 换成成功脚本（等价于用户修复后重新 setScripts）
    engine.setScripts([makeScript()]);
    await engine.runScript('scr_1');
    expect(engine.getRunStats('scr_1').consecutiveErrors).toBe(0);
    expect(engine.getRunStats('scr_1').errors).toBe(1); // 历史错误数保留
  });

  it('连续崩溃 3 次触发自动禁用回调且后续拒绝执行', async () => {
    const engine = makeEngine();
    const onAutoDisable = vi.fn();
    engine.onAutoDisable = onAutoDisable;
    engine.setScripts([makeScript({ code: 'throw new Error("crash");' })]);
    await engine.runScript('scr_1');
    await engine.runScript('scr_1');
    expect(onAutoDisable).not.toHaveBeenCalled();
    await engine.runScript('scr_1'); // 第 3 次
    expect(onAutoDisable).toHaveBeenCalledTimes(1);
    expect(onAutoDisable.mock.calls[0][0]).toBe('scr_1');
    expect(engine.getRunStats('scr_1').autoDisabled).toBe(true);
    // 禁用后拒绝继续执行（config 同步窗口兜底）
    const r = await engine.runScript('scr_1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('auto-disabled');
    // 且不会重复回调
    expect(onAutoDisable).toHaveBeenCalledTimes(1);
  });

  it('重新启用（enabled=true setScripts）清除自动禁用标记', async () => {
    const engine = makeEngine();
    engine.setScripts([makeScript({ code: 'throw new Error("crash");' })]);
    await engine.runScript('scr_1');
    await engine.runScript('scr_1');
    await engine.runScript('scr_1');
    expect(engine.getRunStats('scr_1').autoDisabled).toBe(true);
    // 用户修复代码并重新启用
    engine.setScripts([makeScript()]);
    await engine.runScript('scr_1');
    const st = engine.getRunStats('scr_1');
    expect(st.autoDisabled).toBe(false);
    expect(st.consecutiveErrors).toBe(0);
  });

  it('setScripts 清理已删除脚本的统计', async () => {
    const engine = makeEngine();
    engine.setScripts([makeScript()]);
    await engine.runScript('scr_1');
    engine.setScripts([]);
    expect(engine.getRunStats('scr_1').runs).toBe(0);
  });
});
