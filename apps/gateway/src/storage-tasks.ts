import type { StorageTask, Tag } from '@iotconnector/shared';
import type { TDengineWriter } from './storage/tdengine';

/**
 * 存储任务执行器（PRD FR-M4-01/02）：
 *  - cycle：周期采集行（任务表所有映射列的当前值）
 *  - deadband：位号变化 ≥ 死区时写一行
 *  - edge：位号上升/下降沿时写一行快照
 *  - expression：条件表达式由假变真（上升沿）时写一行；位号按名引用，
 *    支持 > < >= <= == != && || 与括号，字符白名单校验后编译为 Function
 * 目标表按任务名建于配置库（自动 CREATE TABLE IF NOT EXISTS，列类型按位号类型推导）。
 */

interface CompiledExpr {
  src: string;
  fn?: (getValue: (tagId: string) => number | string | boolean | undefined) => boolean;
  error?: string;
}

function sanitizeTable(name: string): string {
  const t = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(t) ? t : `t_${t}`;
}

function colType(dataType: string): string {
  if (dataType === 'Bool') return 'BOOL';
  if (dataType === 'String') return 'NCHAR(200)';
  return 'DOUBLE';
}

export class StorageTaskEngine {
  private tasks: StorageTask[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  /** deadband/edge 用：位号最近一次写入值 */
  private lastWritten = new Map<string, number | string | boolean>();
  /** edge 用：位号当前布尔态 */
  private edgeState = new Map<string, boolean>();
  /** expression 用：按任务缓存编译结果（含源码，表达式变更自动重编译） */
  private exprCache = new Map<string, CompiledExpr>();
  /** expression 用：条件上一次求值结果（上升沿检测） */
  private exprLast = new Map<string, boolean>();

  constructor(
    private storage: TDengineWriter,
    private getValue: (tagId: string) => number | string | boolean | undefined,
    private getTag: (tagId: string) => Tag | undefined,
    private db: string,
    private getTags: () => Tag[] = () => [],
  ) {}

  sync(tasks: StorageTask[]): void {
    // TDengine 未配置时整体跳过，避免建表请求打到无效 URL 导致进程崩溃
    if (!this.storage.enabled) {
      this.stop();
      this.tasks = [];
      return;
    }
    this.tasks = tasks;
    const ids = new Set(tasks.filter((t) => t.enabled).map((t) => t.id));
    // 清理已删除任务的表达式缓存/沿状态
    const allIds = new Set(tasks.map((t) => t.id));
    for (const id of [...this.exprCache.keys()]) if (!allIds.has(id)) this.exprCache.delete(id);
    for (const id of [...this.exprLast.keys()]) if (!allIds.has(id)) this.exprLast.delete(id);
    // 停止不再启用/已删除的任务
    for (const [id, timer] of this.timers) {
      if (!ids.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }
    for (const task of tasks) {
      if (!task.enabled) continue;
      // 确保表存在
      void this.ensureTable(task);
      // 周期任务启动定时器（幂等）
      if (task.trigger.mode === 'cycle' && !this.timers.has(task.id)) {
        const ms = Math.max(200, task.trigger.intervalMs);
        const timer = setInterval(() => void this.runCycle(task), ms);
        this.timers.set(task.id, timer);
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.exprCache.clear();
    this.exprLast.clear();
  }

  /** 编译表达式：位号名（按长度降序防前缀串扰）替换为取值调用，白名单字符校验 */
  private compileExpr(task: StorageTask): CompiledExpr | undefined {
    if (task.trigger.mode !== 'expression') return undefined;
    const src = task.trigger.expression ?? '';
    const hit = this.exprCache.get(task.id);
    if (hit && hit.src === src) return hit;
    const compiled: CompiledExpr = { src };
    if (!src.trim()) {
      compiled.error = 'empty expression';
    } else if (!/^[A-Za-z0-9_.一-龥\s><=!&|()+\-*/%?:,'"]+$/.test(src)) {
      compiled.error = 'illegal characters';
    } else {
      try {
        const nameToId = new Map(this.getTags().map((tg) => [tg.name, tg.id]));
        let js = src.replace(/(?<![<>=!])=(?!=)/g, '=='); // 容忍单等号写法
        // 单次扫描替换：按长度降序的 alternation 保证「温度1」优先于「温度」匹配
        const names = [...nameToId.keys()].sort((a, b) => b.length - a.length);
        if (names.length > 0) {
          const re = new RegExp(names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
          js = js.replace(re, (m) => `__gv(${JSON.stringify(m)})`);
        }
        const fn = new Function('__gv', `"use strict"; return Boolean(${js});`) as (gv: (name: string) => unknown) => boolean;
        compiled.fn = (getValue) => {
          try {
            return fn((name) => {
              const id = nameToId.get(name);
              return id ? getValue(id) : undefined;
            });
          } catch {
            return false; // 求值异常（如未知位号比较）视为条件不满足
          }
        };
      } catch (e) {
        compiled.error = String(e);
      }
    }
    this.exprCache.set(task.id, compiled);
    return compiled;
  }

  /** 引擎位号采样入口（deadband/edge 触发评估） */
  onTagSample(tagId: string, value: number | string | boolean): void {
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      if (task.trigger.mode === 'deadband' && task.trigger.tagId === tagId) {
        const prev = this.lastWritten.get(tagId);
        const num = Number(value);
        if (typeof prev === 'number' && !Number.isNaN(num) && Math.abs(num - prev) >= task.trigger.deadband) {
          this.lastWritten.set(tagId, num);
          void this.writeSnapshot(task);
        } else if (prev === undefined) {
          this.lastWritten.set(tagId, num);
        }
      }
      if (task.trigger.mode === 'edge' && task.trigger.tagId === tagId && typeof value === 'boolean') {
        const prev = this.edgeState.get(tagId) ?? false;
        this.edgeState.set(tagId, value);
        const rising = !prev && value;
        const falling = prev && !value;
        if ((task.trigger.edge === 'rising' && rising) || (task.trigger.edge === 'falling' && falling)) {
          void this.writeSnapshot(task);
        }
      }
      if (task.trigger.mode === 'expression') {
        const compiled = this.compileExpr(task);
        if (compiled?.fn) {
          const result = compiled.fn(this.getValue);
          const last = this.exprLast.get(task.id) ?? false;
          this.exprLast.set(task.id, result);
          if (result && !last) void this.writeSnapshot(task); // 条件由假变真写一行（事件语义）
        }
      }
    }
  }

  private async ensureTable(task: StorageTask): Promise<void> {
    const cols = task.mappings
      .map((m) => {
        const tag = this.getTag(m.tagId);
        return `\`${m.column.replace(/[^A-Za-z0-9_]/g, '_')}\` ${colType(tag?.dataType ?? 'Float')}`;
      })
      .join(', ');
    if (!cols) return;
    await this.storage.query(
      `CREATE TABLE IF NOT EXISTS ${this.db}.${sanitizeTable(task.tableName)} (ts TIMESTAMP${cols ? ', ' + cols : ''})`,
    );
  }

  /** 写一行：所有映射列取当前值 */
  private async writeSnapshot(task: StorageTask): Promise<void> {
    const cols: string[] = ['ts'];
    const vals: string[] = ['now'];
    for (const m of task.mappings) {
      const v = this.getValue(m.tagId);
      cols.push(`\`${m.column.replace(/[^A-Za-z0-9_]/g, '_')}\``);
      if (typeof v === 'boolean') vals.push(v ? 'true' : 'false');
      else if (typeof v === 'number') vals.push(String(v));
      else vals.push(`'${String(v ?? '').replace(/'/g, "''")}'`);
    }
    const result = await this.storage.query(
      `INSERT INTO ${this.db}.${sanitizeTable(task.tableName)} (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
    );
    if (result.code !== 0) console.error(`[storage-tasks] ${task.name}: ${result.code} ${result.msg ?? result.desc ?? ''}`);
  }

  private async runCycle(task: StorageTask): Promise<void> {
    await this.writeSnapshot(task);
  }
}
