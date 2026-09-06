import React, { useEffect, useState } from 'react';
import { Download, Plus, Save, Trash2, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import {
  fetchRecipes, createRecipe, updateRecipe, deleteRecipe, downloadRecipe,
  fetchGatewayTags, type Recipe, type GatewayTag, type DownloadResultItem,
} from '../api';

/** 配方管理（PRD M6）：位号绑定参数集 + 批量下发（下发前显示 diff，逐项回报结果）。 */

export default function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadResults, setDownloadResults] = useState<{ recipeId: string; ok: boolean; results: DownloadResultItem[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (m: string): void => { setToast(m); setTimeout(() => setToast(null), 2500); };

  const load = async (): Promise<void> => {
    const [r, tg] = await Promise.all([fetchRecipes(), fetchGatewayTags()]);
    setRecipes(r);
    setTags(tg);
    setSelectedId((prev) => (prev && r.some((x) => x.id === prev) ? prev : r[0]?.id ?? null));
  };

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const r = recipes.find((x) => x.id === selectedId);
    setDraft(r ? JSON.parse(JSON.stringify(r)) as Recipe : null);
    setDownloadResults(null);
  }, [selectedId, recipes]);

  const selected = recipes.find((x) => x.id === selectedId) ?? null;

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    try {
      if (selected) await updateRecipe(draft.id, draft);
      else await createRecipe(draft);
      await load();
      showToast('配方已保存。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!window.confirm(`确认删除配方 "${selected.name}"？`)) return;
    await deleteRecipe(selected.id);
    await load();
    showToast('已删除。');
  };

  const doDownload = async (): Promise<void> => {
    if (!draft || !selected) return;
    const lines = draft.items.map((it) => {
      const tag = tags.find((t) => t.id === it.tagId);
      return `${tag?.name ?? it.tagId}: ${it.value}`;
    });
    if (!window.confirm(`确认将配方 "${draft.name}" 下发到控制器？\n\n${lines.join('\n')}`)) return;
    setBusy(true);
    try {
      const res = await downloadRecipe(draft.id);
      setDownloadResults({ recipeId: draft.id, ok: res.ok, results: res.results });
    } finally {
      setBusy(false);
    }
  };

  const currentValue = (id: string): string => {
    const t = tags.find((tg) => tg.id === id);
    return t ? `${t.name} 当前值可见于参数诊断页` : '';
  };

  return (
    <div className="space-y-6">
      {toast && <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl">{toast}</div>}

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">配方管理</h2>
          <p className="text-sm text-slate-500 mt-1">位号绑定参数集，一键批量下发到控制器（下发前二次确认）。</p>
        </div>
        <button
          onClick={() => { void createRecipe({ name: '新配方', description: '', items: [] }).then((r) => load().then(() => setSelectedId(r.id))); }}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4 mr-2" /> 新增配方
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <span className="font-bold text-slate-800 text-sm">配方库 ({recipes.length})</span>
          </div>
          <div className="divide-y divide-slate-100">
            {recipes.map((recipe) => (
              <button
                key={recipe.id}
                onClick={() => setSelectedId(recipe.id)}
                className={`w-full text-left p-3.5 transition-colors ${recipe.id === selectedId ? 'bg-indigo-50/50 border-l-2 border-indigo-500' : 'hover:bg-slate-50 border-l-2 border-transparent'}`}
              >
                <div className="font-bold text-xs text-slate-800">{recipe.name}</div>
                <div className="text-[10px] text-slate-400 mt-0.5 truncate">{recipe.description || '—'} · {recipe.items.length} 参数</div>
              </button>
            ))}
            {recipes.length === 0 && <div className="p-6 text-center text-slate-400 text-xs">暂无配方。</div>}
          </div>
        </div>

        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {!draft ? (
            <div className="p-12 text-center text-slate-400 text-sm">选择左侧配方。</div>
          ) : (
            <div className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-base w-56"
                />
                <div className="flex items-center gap-2">
                  <button onClick={() => void remove()} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md"><Trash2 className="w-4 h-4" /></button>
                  <button onClick={() => void save()} disabled={busy} className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60">
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} 保存
                  </button>
                  <button onClick={() => void doDownload()} disabled={busy || draft.items.length === 0} className="flex items-center px-3.5 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-md hover:bg-slate-700 disabled:opacity-60">
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />} 下发到控制器
                  </button>
                </div>
              </div>

              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="配方说明"
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">参数集（位号 → 目标值）</h4>
                  <button
                    onClick={() => setDraft({ ...draft, items: [...draft.items, { tagId: tags[0]?.id ?? '', value: 0 }] })}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> 加参数
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.items.map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <select
                        value={item.tagId}
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[i] = { ...item, tagId: e.target.value };
                          setDraft({ ...draft, items });
                        }}
                        className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                      >
                        {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <span className="text-slate-400 text-xs">=</span>
                      <input
                        value={String(item.value)}
                        onChange={(e) => {
                          const items = [...draft.items];
                          const tag = tags.find((t) => t.id === item.tagId);
                          items[i] = { ...item, value: tag?.dataType === 'Bool' ? e.target.value.toLowerCase() === 'true' : Number(e.target.value) };
                          setDraft({ ...draft, items });
                        }}
                        className="w-32 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                      />
                      <button onClick={() => setDraft({ ...draft, items: draft.items.filter((_, k) => k !== i) })} className="p-1 text-slate-400 hover:text-red-600">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {draft.items.length === 0 && <div className="text-xs text-slate-400 py-2">尚未配置参数。</div>}
                </div>
              </div>

              {downloadResults?.recipeId === draft.id && (
                <div className={`rounded-lg border overflow-hidden text-xs ${downloadResults.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="px-4 py-2 font-bold flex items-center gap-2 text-slate-800">
                    {downloadResults.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-amber-600" />}
                    下发完成（{downloadResults.results.filter((r) => r.ok).length}/{downloadResults.results.length} 成功）
                  </div>
                  <div className="divide-y divide-white/60">
                    {downloadResults.results.map((r, i) => (
                      <div key={i} className="px-4 py-1.5 flex items-center gap-2 font-mono text-[11px]">
                        {r.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-600" /> : <XCircle className="w-3 h-3 text-rose-600" />}
                        <span className="font-bold text-slate-700">{r.name ?? r.tagId}</span>
                        <span className="text-slate-500">= {String(r.value)}</span>
                        {r.error && <span className="text-rose-600">{r.error}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-slate-400">提示：参数的当前值可在「参数诊断」页查看；下发前会显示完整 diff 供确认。</p>
              {currentValue('') && null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
