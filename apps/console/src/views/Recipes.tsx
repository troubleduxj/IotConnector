import React, { useEffect, useRef, useState } from 'react';
import { Download, Plus, Save, Trash2, Loader2, CheckCircle2, XCircle, Copy, Upload, History } from 'lucide-react';
import {
  fetchRecipes, createRecipe, updateRecipe, deleteRecipe, downloadRecipe,
  fetchRecipeDownloads, duplicateRecipe, exportRecipe, importRecipe,
  fetchGatewayTags, type Recipe, type RecipeDownloadRecord, type GatewayTag, type DownloadResultItem,
} from '../api';
import { toast } from '../components/Toast';
import { confirmDialog } from '../components/confirm';
import { useI18n } from '../i18n';

/** 配方管理（PRD M6）：位号绑定参数集 + 批量下发（下发前显示 diff，逐项回报结果）。
 *  FR-M6-03 版本号（参数集变更 +1）；FR-M6-04 下发记录 / 复制 / JSON 导入导出。 */

export default function Recipes() {
  const { t } = useI18n();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadResults, setDownloadResults] = useState<{ recipeId: string; ok: boolean; results: DownloadResultItem[] } | null>(null);
  const [downloads, setDownloads] = useState<RecipeDownloadRecord[]>([]);
  const importFileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const [r, tg, dl] = await Promise.all([fetchRecipes(), fetchGatewayTags(), fetchRecipeDownloads()]);
    setRecipes(r);
    setTags(tg);
    setDownloads(dl);
    setSelectedId((prev) => (prev && r.some((x) => x.id === prev) ? prev : r[0]?.id ?? null));
  };

  useEffect(() => { void load(); }, []);

  // FR-M6-04 下发记录轮询（5s）
  useEffect(() => {
    const timer = setInterval(() => { fetchRecipeDownloads().then(setDownloads).catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, []);

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
      toast(t('rec.toastSaved'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!selected) return;
    if (!(await confirmDialog({ title: t('rec.confirmDelete', { name: selected.name }), danger: true }))) return;
    await deleteRecipe(selected.id);
    await load();
    toast(t('rec.toastDeleted'));
  };

  const doDownload = async (): Promise<void> => {
    if (!draft || !selected) return;
    const lines = draft.items.map((it) => {
      const tag = tags.find((t) => t.id === it.tagId);
      return `${tag?.name ?? it.tagId}: ${it.value}`;
    });
    if (!(await confirmDialog({ title: t('rec.confirmDownloadTitle', { name: draft.name }), message: lines.join('\n'), confirmText: t('rec.download') }))) return;
    setBusy(true);
    try {
      const res = await downloadRecipe(draft.id);
      setDownloadResults({ recipeId: draft.id, ok: res.ok, results: res.results });
      setDownloads(await fetchRecipeDownloads());
    } finally {
      setBusy(false);
    }
  };

  // FR-M6-04 复制 / 导出 / 导入
  const doDuplicate = async (): Promise<void> => {
    if (!selected) return;
    const copy = await duplicateRecipe(selected.id);
    await load();
    setSelectedId(copy.id);
    toast(t('rec.toastDuplicated', { name: copy.name }));
  };

  const doExport = async (): Promise<void> => {
    if (!selected) return;
    try {
      await exportRecipe(selected.id, selected.name);
    } catch {
      toast(t('rec.exportFailed'));
    }
  };

  const doImportFile = async (file: File): Promise<void> => {
    try {
      const bundle = JSON.parse(await file.text()) as { recipe?: { name?: string } };
      if (!bundle?.recipe?.name) { toast(t('rec.importBadFormat')); return; }
      const created = await importRecipe(bundle);
      await load();
      setSelectedId(created.id);
      toast(t('rec.importDone', { name: created.name }));
    } catch (e) {
      toast(`${t('rec.importFailed')}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const currentValue = (id: string): string => {
    const tag = tags.find((tg) => tg.id === id);
    return tag ? t('rec.currentValueHint', { name: tag.name }) : '';
  };

  return (
    <div className="space-y-6">

      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{t('rec.title')}</h2>
          <p className="text-sm text-slate-500 mt-1">{t('rec.subtitle')}</p>
        </div>
        <button
          onClick={() => { void createRecipe({ name: t('rec.defaultRecipeName'), description: '', items: [] }).then((r) => load().then(() => setSelectedId(r.id))); }}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700"
        >
          <Plus className="w-4 h-4 mr-2" /> {t('rec.newRecipe')}
        </button>
      </div>
      {/* FR-M6-04 导入：隐藏 file input，JSON bundle 服务端校验 */}
      <input
        ref={importFileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImportFile(f);
          e.target.value = '';
        }}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 bg-slate-50/70">
            <span className="font-bold text-slate-800 text-sm">{t('rec.libraryCount', { n: recipes.length })}</span>
          </div>
          <div className="divide-y divide-slate-100">
            {recipes.map((recipe) => (
              <button
                key={recipe.id}
                onClick={() => setSelectedId(recipe.id)}
                className={`w-full text-left p-3.5 transition-colors ${recipe.id === selectedId ? 'bg-indigo-50/50 border-l-2 border-indigo-500' : 'hover:bg-slate-50 border-l-2 border-transparent'}`}
              >
                <div className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
                  <span className="truncate">{recipe.name}</span>
                  <span className="shrink-0 px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[9px] font-mono font-bold">v{recipe.version ?? 1}</span>
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 truncate">{recipe.description || '—'} · {t('rec.paramCount', { n: recipe.items.length })}</div>
              </button>
            ))}
            {recipes.length === 0 && <div className="p-6 text-center text-slate-400 text-xs">{t('rec.emptyRecipes')}</div>}
          </div>
        </div>

        <div className="lg:col-span-8 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          {!draft ? (
            <div className="p-12 text-center text-slate-400 text-sm">{t('rec.selectPrompt')}</div>
          ) : (
            <div className="p-6 space-y-5">
              <div className="flex items-center justify-between">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="font-bold text-slate-900 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none text-base w-56"
                />
                <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[10px] font-mono font-bold">v{selected.version ?? 1}</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => void remove()} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md"><Trash2 className="w-4 h-4" /></button>
                  <button onClick={() => importFileRef.current?.click()} className="flex items-center px-2.5 py-1.5 text-slate-600 bg-slate-100 text-xs font-bold rounded-md hover:bg-slate-200" title={t('rec.import')}>
                    <Upload className="w-3.5 h-3.5 mr-1" /> {t('rec.import')}
                  </button>
                  <button onClick={() => void doDuplicate()} disabled={!selected} className="flex items-center px-2.5 py-1.5 text-slate-600 bg-slate-100 text-xs font-bold rounded-md hover:bg-slate-200 disabled:opacity-50" title={t('rec.duplicate')}>
                    <Copy className="w-3.5 h-3.5 mr-1" /> {t('rec.duplicate')}
                  </button>
                  <button onClick={() => void doExport()} disabled={!selected} className="flex items-center px-2.5 py-1.5 text-slate-600 bg-slate-100 text-xs font-bold rounded-md hover:bg-slate-200 disabled:opacity-50" title={t('rec.export')}>
                    <Upload className="w-3.5 h-3.5 mr-1 rotate-180" /> {t('rec.export')}
                  </button>
                  <button onClick={() => void save()} disabled={busy} className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60">
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} {t('rec.save')}
                  </button>
                  <button onClick={() => void doDownload()} disabled={busy || draft.items.length === 0} className="flex items-center px-3.5 py-1.5 bg-slate-800 text-white text-xs font-bold rounded-md hover:bg-slate-700 disabled:opacity-60">
                    {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />} {t('rec.download')}
                  </button>
                </div>
              </div>

              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder={t('rec.descriptionPlaceholder')}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
              />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t('rec.paramSetTitle')}</h4>
                  <button
                    onClick={() => setDraft({ ...draft, items: [...draft.items, { tagId: tags[0]?.id ?? '', value: 0 }] })}
                    className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" /> {t('rec.addParam')}
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
                  {draft.items.length === 0 && <div className="text-xs text-slate-400 py-2">{t('rec.noParams')}</div>}
                </div>
              </div>

              {downloadResults?.recipeId === draft.id && (
                <div className={`rounded-lg border overflow-hidden text-xs ${downloadResults.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="px-4 py-2 font-bold flex items-center gap-2 text-slate-800">
                    {downloadResults.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-amber-600" />}
                    {t('rec.downloadSummary', { ok: downloadResults.results.filter((r) => r.ok).length, total: downloadResults.results.length })}
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

              <p className="text-[11px] text-slate-400">{t('rec.hint')}</p>
              {currentValue('') && null}
            </div>
          )}
        </div>
      </div>

      {/* FR-M6-04 下发记录（5s 轮询） */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-600" /> {t('rec.downloadHistory')}
          </h3>
          <span className="text-[11px] text-slate-400 font-mono">{t('rec.downloadHistoryCount', { n: downloads.length })}</span>
        </div>
        {downloads.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-xs">{t('rec.emptyDownloads')}</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {downloads.slice(0, 20).map((d) => (
              <div key={d.id} className="px-6 py-2.5 flex items-center gap-4 text-xs">
                {d.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <XCircle className="w-4 h-4 text-amber-600 shrink-0" />}
                <span className="font-mono text-slate-400 shrink-0">{new Date(d.at).toLocaleString()}</span>
                <span className="font-bold text-slate-700">{d.recipeName}</span>
                <span className="px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[10px] font-mono font-bold">v{d.version}</span>
                <span className="text-slate-500">{t('rec.dlBy', { user: d.by })}</span>
                <span className={`ml-auto font-mono font-bold ${d.ok ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {t('rec.dlResult', { ok: d.okCount, total: d.totalCount })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
