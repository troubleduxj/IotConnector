import React, { useEffect, useState } from 'react';
import { Database, Plus, Save, Trash2, Loader2, Zap } from 'lucide-react';
import {
  fetchStorageTasks, createStorageTask, updateStorageTask, deleteStorageTask,
  fetchGatewayTags, type StorageTask, type GatewayTag,
} from '../api';

/** 存储规则（PRD M4）：存储任务 CRUD + 触发器（周期/死区/边沿），由网关执行写入。 */

const emptyTask = (): Omit<StorageTask, 'id'> => ({
  name: '新存储任务',
  enabled: true,
  tableName: 'task_new',
  trigger: { mode: 'cycle', intervalMs: 5000 },
  mappings: [],
});

export default function DataStorage() {
  const [tasks, setTasks] = useState<StorageTask[]>([]);
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StorageTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string): void => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const load = async (): Promise<void> => {
    const [t, tg] = await Promise.all([fetchStorageTasks(), fetchGatewayTags()]);
    setTasks(t);
    setTags(tg);
    setSelectedId((prev) => (prev && t.some((x) => x.id === prev) ? prev : t[0]?.id ?? null));
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const t = tasks.find((x) => x.id === selectedId);
    setDraft(t ? JSON.parse(JSON.stringify(t)) as StorageTask : null);
  }, [selectedId, tasks]);

  const selected = tasks.find((x) => x.id === selectedId) ?? null;

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      if (selected) await updateStorageTask(draft.id, draft);
      else await createStorageTask(draft);
      await load();
      showToast('存储任务已保存并生效。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`确认删除任务 "${selected.name}"？`)) return;
    await deleteStorageTask(selected.id);
    await load();
    showToast('已删除。');
  };

  return (
    <div className="space-y-6">
      {toast && <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl">{toast}</div>}

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">存储规则</h2>
          <p className="text-sm text-slate-500 mt-1">存储任务由网关执行：周期快照 / 死区触发 / 边沿快照，写入 TDengine 独立表。</p>
        </div>
        <button
          onClick={() => { void createStorageTask(emptyTask()).then((created) => load().then(() => setSelectedId(created.id))); }}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4 mr-2" /> 新增任务
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <span className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
              <Database className="w-4 h-4 text-indigo-600" /> 存储任务 ({tasks.length})
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {tasks.map((task) => (
              <button
                key={task.id}
                onClick={() => setSelectedId(task.id)}
                className={`w-full text-left p-3.5 transition-colors ${task.id === selectedId ? 'bg-indigo-50/50 border-l-2 border-indigo-500' : 'hover:bg-slate-50 border-l-2 border-transparent'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-800">{task.name}</span>
                  <span className={`w-2 h-2 rounded-full ${task.enabled ? 'bg-green-500' : 'bg-slate-300'}`} />
                </div>
                <div className="text-[10px] font-mono text-slate-400 mt-1">
                  {task.tableName} · {task.trigger.mode === 'cycle' ? `周期 ${task.trigger.intervalMs}ms` : task.trigger.mode === 'deadband' ? `死区 ±${task.trigger.deadband}` : `沿触发 (${task.trigger.edge})`}
                </div>
              </button>
            ))}
            {tasks.length === 0 && <div className="p-6 text-center text-slate-400 text-xs">暂无任务，点击右上角新增。</div>}
          </div>
        </div>

        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {!draft ? (
            <div className="p-12 text-center text-slate-400 text-sm">选择左侧任务。</div>
          ) : (
            <div className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-base w-64"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                    className={`px-2.5 py-1 rounded-md text-xs font-bold border ${draft.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'}`}
                  >
                    {draft.enabled ? '启用中' : '已停用'}
                  </button>
                  <button onClick={() => void remove()} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md"><Trash2 className="w-4 h-4" /></button>
                  <button onClick={() => void save()} disabled={busy} className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60">
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} 保存并生效
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">目标表名（自动建表）</label>
                  <input value={draft.tableName} onChange={(e) => setDraft({ ...draft, tableName: e.target.value })} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">触发模式</label>
                  <select
                    value={draft.trigger.mode}
                    onChange={(e) => {
                      const mode = e.target.value as StorageTask['trigger']['mode'];
                      const trigger =
                        mode === 'cycle' ? { mode, intervalMs: 5000 } :
                        mode === 'deadband' ? { mode, tagId: tags[0]?.id ?? '', deadband: 0.5 } :
                        { mode, tagId: tags[0]?.id ?? '', edge: 'rising' as const };
                      setDraft({ ...draft, trigger });
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium bg-slate-50"
                  >
                    <option value="cycle">周期快照</option>
                    <option value="deadband">死区触发（变化 ≥ 死区）</option>
                    <option value="edge">边沿快照（位号上升/下降沿）</option>
                  </select>
                </div>
              </div>

              {draft.trigger.mode === 'cycle' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">周期 (ms，最小 200)</label>
                  <input
                    value={draft.trigger.intervalMs ?? 5000}
                    onChange={(e) => setDraft({ ...draft, trigger: { mode: 'cycle', intervalMs: Math.max(200, Number(e.target.value)) } })}
                    className="w-40 px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
              )}
              {draft.trigger.mode === 'deadband' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">监视位号</label>
                    <select value={draft.trigger.tagId ?? ''} onChange={(e) => setDraft({ ...draft, trigger: { mode: 'deadband', tagId: e.target.value, deadband: draft.trigger.deadband ?? 0.5 } })} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm">
                      {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">死区（绝对值）</label>
                    <input value={draft.trigger.deadband ?? 0.5} onChange={(e) => setDraft({ ...draft, trigger: { mode: 'deadband', tagId: draft.trigger.tagId ?? tags[0]?.id ?? '', deadband: Number(e.target.value) } })} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono" />
                  </div>
                </div>
              )}
              {draft.trigger.mode === 'edge' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">监视位号（布尔）</label>
                    <select value={draft.trigger.tagId ?? ''} onChange={(e) => setDraft({ ...draft, trigger: { mode: 'edge', tagId: e.target.value, edge: draft.trigger.edge ?? 'rising' } })} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm">
                      {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">沿</label>
                    <select value={draft.trigger.edge ?? 'rising'} onChange={(e) => setDraft({ ...draft, trigger: { mode: 'edge', tagId: draft.trigger.tagId ?? tags[0]?.id ?? '', edge: e.target.value as 'rising' | 'falling' } })} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium">
                      <option value="rising">上升沿（false→true）</option>
                      <option value="falling">下降沿（true→false）</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="pt-2 border-t border-slate-100">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" /> 列映射（列名 ← 位号当前值）
                  </h4>
                  <button
                    onClick={() => setDraft({ ...draft, mappings: [...draft.mappings, { column: `col${draft.mappings.length + 1}`, tagId: tags[0]?.id ?? '' }] })}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> 加列
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.mappings.map((m, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={m.column}
                        onChange={(e) => {
                          const mappings = [...draft.mappings];
                          mappings[i] = { ...m, column: e.target.value };
                          setDraft({ ...draft, mappings });
                        }}
                        className="w-40 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                      />
                      <span className="text-slate-400 text-xs">←</span>
                      <select
                        value={m.tagId}
                        onChange={(e) => {
                          const mappings = [...draft.mappings];
                          mappings[i] = { ...m, tagId: e.target.value };
                          setDraft({ ...draft, mappings });
                        }}
                        className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md text-xs"
                      >
                        {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <button onClick={() => setDraft({ ...draft, mappings: draft.mappings.filter((_, k) => k !== i) })} className="p-1 text-slate-400 hover:text-red-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {draft.mappings.length === 0 && <div className="text-xs text-slate-400 py-2">尚未配置映射列。</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
