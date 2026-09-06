import React, { useEffect, useState } from 'react';
import { Bell, Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { fetchAlarmHistory, fetchAlarms, fetchGatewayTags, type AlarmEvent, type AlarmHistoryEvent, type AlarmRule, type GatewayTag } from '../api';
import { useRuntime } from '../store/runtime';
import { useI18n } from '../i18n';

/**
 * 告警中心（PRD FR-M10-01/04）：活动告警总览、规则管理与历史事件查询
 * （历史持久化于 TDengine alarm_events，支持位号/状态/时间过滤与分页）。
 */

type StateFilter = '' | 'Active' | 'Cleared';
type RangeFilter = '' | '1h' | '24h' | '7d';

export default function AlarmCenter() {
  const { t } = useI18n();
  const alarmSeq = useRuntime((s) => s.alarmSeq);
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [active, setActive] = useState<AlarmEvent[]>([]);
  const [events, setEvents] = useState<AlarmHistoryEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [tagId, setTagId] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('');
  const [range, setRange] = useState<RangeFilter>('');
  const [loading, setLoading] = useState(false);

  const pageSize = 20;

  const [loadError, setLoadError] = useState<string | null>(null);
  const loadAll = (): void => {
    fetchGatewayTags().then(setTags).catch(() => {});
    fetchAlarms()
      .then((d) => {
        setRules(d.rules ?? []);
        setActive(d.active ?? []);
        setLoadError(null);
      })
      .catch((e) => setLoadError(String((e as Error).message ?? e)));
  };
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = (p: number): void => {
    setLoading(true);
    const end = Date.now();
    const spans: Record<string, number> = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };
    fetchAlarmHistory({
      tagId: tagId || undefined,
      state: stateFilter || undefined,
      start: range ? end - spans[range] : undefined,
      end: range ? end : undefined,
      limit: pageSize,
      offset: p * pageSize,
    })
      .then((res) => {
        setEvents(res.events);
        setTotal(res.total);
        setPage(p);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    query(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, stateFilter, range]);

  // WS 告警推送 → 即时刷新规则/活动/第一页历史
  useEffect(() => {
    if (alarmSeq === 0) return;
    fetchAlarms().then((d) => {
      setRules(d.rules);
      setActive(d.active);
    }).catch(() => {});
    if (page === 0) query(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmSeq]);

  const tagName = (id: string): string => tags.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <Bell className="w-5 h-5 text-amber-500" /> {t('alarms.title')}
        </h2>
        <p className="text-sm text-slate-500 mt-1">{t('alarms.subtitle')}</p>
      </div>

      {/* 活动告警 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h4 className="font-bold text-slate-800 text-sm">{t('alarms.active')} ({active.length})</h4>
          <button onClick={loadAll} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1">
            {loadError ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} 刷新
          </button>
        </div>
        {loadError && (
          <div className="px-5 py-2 bg-rose-50 text-rose-700 text-xs">加载失败：{loadError}</div>
        )}
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {active.length === 0 ? (
            <div className="col-span-full px-3 py-4 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
              {t('alarms.empty')}
            </div>
          ) : (
            active.map((a) => (
              <div key={a.id} className="px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-bold text-rose-800 truncate">
                    {a.tagName} <span className="font-mono">{a.kind === 'high' ? '>' : '<'} {a.threshold}</span>
                  </div>
                  <div className="text-[10px] text-rose-500 font-mono">
                    {a.value.toFixed(2)} · {new Date(a.ts).toLocaleTimeString()}
                  </div>
                </div>
                <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white animate-pulse">ACTIVE</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 规则表 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50">
          <h4 className="font-bold text-slate-800 text-sm">{t('alarms.rules')} ({rules.length})</h4>
        </div>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="bg-slate-50/70 text-slate-500 text-[10px] uppercase font-bold border-b border-slate-200">
              <th className="px-5 py-2.5">位号</th>
              <th className="px-5 py-2.5">规则</th>
              <th className="px-5 py-2.5">回差</th>
              <th className="px-5 py-2.5">状态</th>
              <th className="px-5 py-2.5">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50/80">
                <td className="px-5 py-2.5 font-mono font-bold text-slate-800">{tagName(r.tagId)}</td>
                <td className="px-5 py-2.5 font-mono">
                  <span className={`font-bold ${r.kind === 'high' ? 'text-rose-600' : 'text-blue-600'}`}>
                    {r.kind === 'high' ? '>' : '<'} {r.threshold}
                  </span>
                </td>
                <td className="px-5 py-2.5 font-mono text-slate-500">±{r.hysteresis}</td>
                <td className="px-5 py-2.5">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${r.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                    {r.enabled ? <Check className="w-3 h-3" /> : null} {r.enabled ? '启用' : '停用'}
                  </span>
                </td>
                <td className="px-5 py-2.5 text-slate-500">{r.message ?? '—'}</td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-6 text-center text-slate-400">{t('alarms.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 历史查询 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-3">
          <h4 className="font-bold text-slate-800 text-sm">{t('alarms.history')}</h4>
          <select
            value={tagId}
            onChange={(e) => setTagId(e.target.value)}
            className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
          >
            <option value="">{t('alarms.filter.tag')}：{t('alarms.filter.all')}</option>
            {tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
          </select>
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
          >
            <option value="">{t('alarms.filter.state')}：{t('alarms.filter.all')}</option>
            <option value="Active">Active</option>
            <option value="Cleared">Cleared</option>
          </select>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as RangeFilter)}
            className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
          >
            <option value="">时间：全部</option>
            <option value="1h">近 1 小时</option>
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
          </select>
          <span className="ml-auto text-xs text-slate-400 font-mono">共 {total} 条</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-slate-50/70 text-slate-500 text-[10px] uppercase font-bold border-b border-slate-200">
                <th className="px-5 py-2.5">时间</th>
                <th className="px-5 py-2.5">位号</th>
                <th className="px-5 py-2.5">事件</th>
                <th className="px-5 py-2.5 text-right">值 / 阈值</th>
                <th className="px-5 py-2.5">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr><td colSpan={5} className="px-5 py-6 text-center text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />查询中…</td></tr>
              )}
              {!loading && events.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-6 text-center text-slate-400">{t('alarms.empty')}</td></tr>
              )}
              {!loading && events.map((e) => (
                <tr key={e.eventId + String(e.ts)} className="hover:bg-slate-50/80">
                  <td className="px-5 py-2.5 font-mono text-slate-500">{new Date(e.ts).toLocaleString()}</td>
                  <td className="px-5 py-2.5 font-mono font-bold text-slate-800">{e.tagName}</td>
                  <td className="px-5 py-2.5">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      e.state === 'Active' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {e.state === 'Active' ? <Bell className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      {e.state === 'Active' ? '触发' : '已恢复'}
                    </span>
                    <span className="ml-2 text-slate-400">{e.kind === 'high' ? '越上限' : '越下限'}</span>
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono">
                    <span className="font-bold text-slate-800">{e.value.toFixed(2)}</span>
                    <span className="text-slate-400"> / {e.threshold}</span>
                  </td>
                  <td className="px-5 py-2.5 text-slate-500">{e.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-2 text-xs">
          <button
            onClick={() => query(page - 1)}
            disabled={page === 0 || loading}
            className="flex items-center px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> {t('alarms.prev')}
          </button>
          <span className="font-mono text-slate-500">第 {page + 1} 页 / 共 {Math.max(1, Math.ceil(total / pageSize))} 页</span>
          <button
            onClick={() => query(page + 1)}
            disabled={(page + 1) * pageSize >= total || loading}
            className="flex items-center px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            {t('alarms.next')} <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
