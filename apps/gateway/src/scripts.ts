import vm from 'node:vm';
import type { Script, Tag } from '@iotconnector/shared';

/**
 * 边缘脚本引擎（决策 D5：JS 沙箱，node:vm + 超时 + 白名单 API）。
 * 沙箱 API：
 *   Read('通道.位号') → 当前值
 *   Write('通道.位号', value) → 下发（脚本结束后批量应用）
 *   log(...) → 输出（环形缓冲，最近 50 条）
 * 触发：周期 / 位号值变化 / 手动。
 * 安全边界：VM 非硬安全边界；配合单次超时 + 输出限额 + 写白名单（只允许已存在位号）。
 * 后续可平滑替换为 isolated-vm。
 */

const MAX_OUTPUTS = 50;
const MAX_RUN_MS = 1000;

export interface ScriptRunResult {
  ok: boolean;
  outputs: string[];
  error?: string;
  durationMs: number;
}

export interface ScriptValueLookup {
  /** 按位号名或 id 取当前值 */
  (key: string): number | string | boolean | undefined;
}

export class ScriptEngine {
  private scripts: Script[] = [];
  private outputs = new Map<string, string[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private lastTagValue = new Map<string, boolean>(); // tagChange 触发用（布尔沿）与数值变化检测
  private lastNumeric = new Map<string, number>();

  constructor(
    private lookup: ScriptValueLookup,
    private getTag: (key: string) => Tag | undefined,
    private doWrite: (tagId: string, value: number | string | boolean) => Promise<void>,
  ) {}

  getScripts(): Script[] {
    return this.scripts;
  }

  setScripts(scripts: Script[]): void {
    this.scripts = scripts;
    const ids = new Set(scripts.filter((s) => s.enabled && s.trigger.type === 'interval').map((s) => s.id));
    for (const [id, timer] of this.timers) {
      if (!ids.has(id)) {
        clearInterval(timer);
        this.timers.delete(id);
      }
    }
    for (const script of scripts) {
      if (script.enabled && script.trigger.type === 'interval' && !this.timers.has(script.id)) {
        const ms = Math.max(500, script.trigger.intervalMs);
        this.timers.set(script.id, setInterval(() => void this.runScript(script.id), ms));
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  getOutputs(id: string): string[] {
    return this.outputs.get(id) ?? [];
  }

  /** 引擎位号采样入口：tagChange 触发评估（布尔沿 / 数值变化） */
  onTagSample(tagId: string, value: number | string | boolean): void {
    for (const script of this.scripts) {
      if (!script.enabled || script.trigger.type !== 'tagChange' || script.trigger.tagId !== tagId) continue;
      if (typeof value === 'boolean') {
        const prev = this.lastTagValue.get(tagId) ?? false;
        if (prev !== value) {
          this.lastTagValue.set(tagId, value);
          void this.runScript(script.id);
        }
      } else if (typeof value === 'number') {
        const prev = this.lastNumeric.get(tagId);
        if (prev !== undefined && prev !== value) {
          this.lastNumeric.set(tagId, value);
          void this.runScript(script.id);
        } else if (prev === undefined) {
          this.lastNumeric.set(tagId, value);
        }
      }
    }
  }

  /** 执行脚本：vm 沙箱 + 超时；Write 收集后批量应用 */
  async runScript(id: string): Promise<ScriptRunResult> {
    const script = this.scripts.find((s) => s.id === id);
    if (!script) return { ok: false, outputs: [], error: `script not found: ${id}`, durationMs: 0 };

    const outputs: string[] = [];
    const pendingWrites: Array<{ tagId: string; value: number | string | boolean }> = [];
    const sandbox = {
      Read: (key: string): number | string | boolean | undefined => {
        const v = this.lookup(key);
        if (v === undefined) throw new Error(`Read: 位号不存在 ${key}`);
        return v;
      },
      Write: (key: string, value: number | string | boolean): void => {
        const tag = this.getTag(key);
        if (!tag) throw new Error(`Write: 位号不存在 ${key}`);
        pendingWrites.push({ tagId: tag.id, value });
        outputs.push(`Write ${key} = ${value}`);
      },
      log: (...args: unknown[]): void => {
        outputs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      },
    };
    // console 兼容
    (sandbox as Record<string, unknown>).console = { log: sandbox.log };

    const t0 = Date.now();
    try {
      const context = vm.createContext(sandbox);
      vm.runInContext(script.code, context, { timeout: MAX_RUN_MS, filename: `${script.name}.js` });
    } catch (e) {
      outputs.push(`✗ 执行错误: ${String((e as Error).message ?? e)}`);
      this.pushOutputs(id, outputs);
      return { ok: false, outputs, error: String((e as Error).message ?? e), durationMs: Date.now() - t0 };
    }
    this.pushOutputs(id, outputs);

    // 应用收集的写入
    for (const w of pendingWrites) {
      try {
        await this.doWrite(w.tagId, w.value);
      } catch (e) {
        outputs.push(`✗ Write 失败: ${String(e)}`);
        this.pushOutputs(id, outputs);
      }
    }
    return { ok: true, outputs: this.getOutputs(id), durationMs: Date.now() - t0 };
  }

  private pushOutputs(id: string, lines: string[]): void {
    const all = [...(this.outputs.get(id) ?? []), ...lines];
    this.outputs.set(id, all.slice(-MAX_OUTPUTS));
  }
}

/** 触发说明（供 UI 显示） */
export function describeTrigger(script: Script): string {
  switch (script.trigger.type) {
    case 'interval':
      return `周期 ${script.trigger.intervalMs}ms`;
    case 'tagChange':
      return '位号变化触发';
    default:
      return '手动';
  }
}

