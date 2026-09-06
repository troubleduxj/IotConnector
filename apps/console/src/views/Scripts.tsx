import React, { useEffect, useState } from 'react';
import { Plus, Save, Trash2, Loader2, Play, Check, X } from 'lucide-react';
import {
  fetchScripts, createScript, updateScript, deleteScript, runScript,
  type GatewayScript,
} from '../api';

/**
 * 边缘脚本（决策 D5：JS 沙箱）：脚本 CRUD + 触发配置 + 手动运行与输出台。
 * 沙箱 API：Read('通道.位号') / Write('通道.位号', 值) / log(...)
 */

export default function Scripts() {
  const [scripts, setScripts] = useState<GatewayScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GatewayScript | null>(null);
  const [busy, setBusy] = useState(false);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string): void => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const load = async (keepSelection = true): Promise<void> => {
    const list = await fetchScripts();
    setScripts(list);
    setSelectedId((prev) => (keepSelection && prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null));
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const s = scripts.find((x) => x.id === selectedId);
    setDraft(s ? JSON.parse(JSON.stringify(s)) as GatewayScript : null);
    setOutputs(s?.output ?? []);
  }, [selectedId, scripts]);

  const selected = scripts.find((x) => x.id === selectedId) ?? null;

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      if (selected) await updateScript(draft.id, draft);
      else await createScript(draft);
      await load();
      showToast('脚本已保存并生效。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`确认删除脚本 "${selected.name}"？`)) return;
    await deleteScript(selected.id);
    await load(false);
    showToast('已删除。');
  };

  const run = async (): Promise<void> => {
    if (!draft) return;
    // 先保存再运行，保证执行的是编辑器内容
    await save();
    setRunning(true);
    try {
      const result = await runScript(draft.id);
      setOutputs(result.outputs ?? []);
      showToast(result.ok ? '执行完成。' : `执行失败：${result.error ?? ''}`);
    } finally {
      setRunning(false);
    }
  };

  const lineCount = (draft?.code ?? '').split('\n').length;

  return (
    <div className="space-y-6">
      {toast && <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl">{toast}</div>}

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">边缘脚本（JS 沙箱）</h2>
          <p className="text-sm text-slate-500 mt-1">
            沙箱 API：<code className="font-mono text-indigo-600">Read('通道.位号')</code>、
            <code className="font-mono text-indigo-600">Write('通道.位号', 值)</code>、
            <code className="font-mono text-indigo-600">log(...)</code>（超时 1s，写操作在脚本结束后批量应用）
          </p>
        </div>
        <button
          onClick={() => { void createScript({ name: `脚本_${Date.now() % 10000}`, description: '', code: "log('hello');\n", trigger: { type: 'manual' }, enabled: false }).then((s) => load().then(() => setSelectedId(s.id))); }}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4 mr-2" /> 新建脚本
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 脚本列表 */}
        <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <span className="font-bold text-slate-800 text-sm">脚本 ({scripts.length})</span>
          </div>
          <div className="divide-y divide-slate-100">
            {scripts.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left p-3 transition-colors ${s.id === selectedId ? 'bg-indigo-50/50 border-l-2 border-indigo-500' : 'hover:bg-slate-50 border-l-2 border-transparent'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-800 truncate">{s.name}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${s.enabled ? 'bg-green-500' : 'bg-slate-300'}`} />
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  {s.trigger.type === 'interval' ? `周期 ${s.trigger.intervalMs}ms` : s.trigger.type === 'tagChange' ? '位号变化' : '手动'}
                </div>
              </button>
            ))}
            {scripts.length === 0 && <div className="p-6 text-center text-slate-400 text-xs">暂无脚本。</div>}
          </div>
        </div>

        {/* 编辑器 + 配置 */}
        <div className="lg:col-span-9 space-y-6">
          {!draft ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-12 text-center text-slate-400 text-sm">选择或新建脚本。</div>
          ) : (
            <>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/70">
                  <div className="flex items-center gap-3 flex-1">
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      className="font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-sm w-48"
                    />
                    <input
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      placeholder="说明"
                      className="text-xs text-slate-500 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none flex-1"
                    />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold border ${draft.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'}`}
                    >
                      {draft.enabled ? '启用中' : '已停用'}
                    </button>
                    <button onClick={() => void remove()} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md"><Trash2 className="w-4 h-4" /></button>
                    <button onClick={() => void save()} disabled={busy} className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60">
                      {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} 保存
                    </button>
                    <button onClick={() => void run()} disabled={running} className="flex items-center px-3.5 py-1.5 bg-emerald-600 text-white text-xs font-bold rounded-md hover:bg-emerald-700 disabled:opacity-60">
                      {running ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1.5" />} 运行
                    </button>
                  </div>
                </div>

                {/* 触发配置 */}
                <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/70 flex items-center gap-3 text-xs">
                  <span className="font-semibold text-slate-600">触发：</span>
                  <select
                    value={draft.trigger.type}
                    onChange={(e) => {
                      const type = e.target.value as GatewayScript['trigger']['type'];
                      const trigger = type === 'interval' ? { type, intervalMs: 2000 } : type === 'tagChange' ? { type, tagId: '' } : { type };
                      setDraft({ ...draft, trigger });
                    }}
                    className="px-2 py-1.5 border border-slate-300 rounded-md font-medium"
                  >
                    <option value="manual">手动</option>
                    <option value="interval">周期</option>
                    <option value="tagChange">位号变化</option>
                  </select>
                  {draft.trigger.type === 'interval' && (
                    <input
                      value={draft.trigger.intervalMs ?? 2000}
                      onChange={(e) => setDraft({ ...draft, trigger: { type: 'interval', intervalMs: Math.max(500, Number(e.target.value)) } })}
                      className="w-28 px-2 py-1.5 border border-slate-300 rounded-md font-mono"
                      placeholder="ms"
                    />
                  )}
                  {draft.trigger.type === 'tagChange' && (
                    <input
                      value={draft.trigger.tagId ?? ''}
                      onChange={(e) => setDraft({ ...draft, trigger: { type: 'tagChange', tagId: e.target.value } })}
                      className="w-56 px-2 py-1.5 border border-slate-300 rounded-md font-mono"
                      placeholder="位号 id（可从参数诊断页查询）"
                    />
                  )}
                </div>

                {/* 代码编辑器 */}
                <div className="relative bg-slate-900">
                  <div className="absolute left-0 top-0 bottom-0 w-10 select-none text-right pr-2 pt-3 text-[11px] leading-5 font-mono text-slate-600 overflow-hidden">
                    {Array.from({ length: lineCount }, (_, i) => <div key={i}>{i + 1}</div>)}
                  </div>
                  <textarea
                    value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    spellCheck={false}
                    className="w-full h-72 bg-slate-900 text-slate-100 font-mono text-sm leading-5 pl-12 pr-4 py-3 resize-none focus:outline-none border-0"
                  />
                </div>
              </div>

              {/* 输出台 */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="px-6 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                  <h4 className="font-bold text-slate-800 text-sm">输出台</h4>
                  <span className="text-[11px] text-slate-400 font-mono">{outputs.length} 条</span>
                </div>
                <div className="p-4 bg-slate-900 min-h-[100px] max-h-56 overflow-y-auto font-mono text-[11px] leading-5">
                  {outputs.length === 0 ? (
                    <div className="text-slate-500">暂无输出。点击「运行」执行脚本。</div>
                  ) : (
                    outputs.map((line, i) => (
                      <div key={i} className={line.startsWith('✗') || line.startsWith('Write ') ? 'text-cyan-300' : 'text-slate-300'}>
                        {line}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
