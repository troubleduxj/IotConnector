import { describe, it, expect } from 'vitest';
import type { StorageTask, Tag } from '@iotconnector/shared';
import type { TDengineWriter } from '../src/storage/tdengine';
import { StorageTaskEngine } from '../src/storage-tasks';

/** 表达式触发（FR-M4-02④）：条件由假变真写一行，位号按名引用，坏表达式不崩溃 */

function makeTag(id: string, name: string, dataType: Tag['dataType'] = 'Float'): Tag {
  return { id, channelId: 'c1', name, address: '', dataType, unit: '', scale: 1, offset: 0 };
}

function makeTask(expression: string, mappings: StorageTask['mappings']): StorageTask {
  return {
    id: `task_${expression.length}`,
    name: 'expr_task',
    enabled: true,
    tableName: 'expr_tbl',
    trigger: { mode: 'expression', expression },
    mappings,
  };
}

function setup(tags: Tag[], values: Record<string, number | string | boolean>) {
  const inserts: string[] = [];
  const storage = {
    get enabled() { return true; },
    query: async (sql: string) => { inserts.push(sql); return { code: 0 }; },
  } as unknown as TDengineWriter;
  const engine = new StorageTaskEngine(
    storage,
    (id) => values[id],
    (id) => tags.find((tg) => tg.id === id),
    'factory_bridge',
    () => tags,
  );
  return { engine, inserts };
}

describe('storage-tasks expression trigger', () => {
  it('上升沿写一行：false→true 触发，持续为真不重复写', () => {
    const tags = [makeTag('t1', '温度')];
    const values: Record<string, number> = { t1: 70 };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask('温度 > 80', [{ column: 'v', tagId: 't1' }]);
    engine.sync([task]);

    values.t1 = 85; engine.onTagSample('t1', 85);   // false→true → 写一行
    values.t1 = 90; engine.onTagSample('t1', 90);   // 持续为真 → 不写
    values.t1 = 60; engine.onTagSample('t1', 60);   // 回落为假
    values.t1 = 88; engine.onTagSample('t1', 88);   // 再次上升沿 → 再写一行

    const rows = inserts.filter((s) => s.startsWith('INSERT'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('85');
    expect(rows[1]).toContain('88');
  });

  it('多条件布尔：&& 与 == 组合，仅全部满足才触发', () => {
    const tags = [makeTag('t1', '温度'), makeTag('t2', '运行', 'Bool')];
    const values: Record<string, number | boolean> = { t1: 90, t2: false };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask('温度 > 80 && 运行 == true', [{ column: 'v', tagId: 't1' }]);
    engine.sync([task]);

    engine.onTagSample('t1', 90);      // 温度满足但 运行=false → 不写
    values.t2 = true;
    engine.onTagSample('t2', true);    // 双双满足 → 上升沿写一行
    engine.onTagSample('t2', true);    // 维持 → 不写

    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);
  });

  it('前缀串扰防护：位号「温度」与「温度1」共存时按名精确替换', () => {
    const tags = [makeTag('t1', '温度'), makeTag('t2', '温度1')];
    const values: Record<string, number> = { t1: 10, t2: 90 };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask('温度1 > 80', [{ column: 'v', tagId: 't2' }]);
    engine.sync([task]);

    engine.onTagSample('t2', 90);      // 只有 温度1 越限，温度=10 不应影响判定
    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);
  });

  it('坏表达式（非法字符）不崩溃也不写行', () => {
    const tags = [makeTag('t1', '温度')];
    const values: Record<string, number> = { t1: 90 };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask('温度 > 80; process.exit()', [{ column: 'v', tagId: 't1' }]);
    engine.sync([task]);

    expect(() => engine.onTagSample('t1', 90)).not.toThrow();
    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(0);
  });

  it('单等号自动视为 ==', () => {
    const tags = [makeTag('t1', '状态', 'String')];
    const values: Record<string, string> = { t1: 'run' };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask("状态 = 'run'", [{ column: 'v', tagId: 't1' }]);
    engine.sync([task]);

    engine.onTagSample('t1', 'run');
    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);
  });

  it('sync 修剪已删任务的表达式缓存', () => {
    const tags = [makeTag('t1', '温度')];
    const values: Record<string, number> = { t1: 90 };
    const { engine, inserts } = setup(tags, values);
    const task = makeTask('温度 > 80', [{ column: 'v', tagId: 't1' }]);
    engine.sync([task]);
    engine.onTagSample('t1', 90);
    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);

    engine.sync([]);                    // 任务删除
    engine.onTagSample('t1', 95);       // 不再评估
    expect(inserts.filter((s) => s.startsWith('INSERT'))).toHaveLength(1);
  });
});
