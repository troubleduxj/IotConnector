import React, { useEffect, useState } from 'react';
import {
  Bell, Check, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Save, Send, Trash2, X,
} from 'lucide-react';
import type { NotificationConfig } from '@iotconnector/shared';
import {
  ackAlarm, createAlarm, deleteAlarm, fetchAlarmHistory, fetchAlarms, fetchGatewayTags,
  saveNotifications, testNotificationChannel, updateAlarm,
  type AlarmEvent, type AlarmHistoryEvent, type AlarmRule, type GatewayTag,
} from '../api';
import { useRuntime } from '../store/runtime';
import { useI18n } from '../i18n';

/**
 * 告警中心（PRD FR-M10-01/04）：
 * TAB 布局 —— 告警规则（CRUD）/ 历史事件（TDengine 持久查询，防抖动渲染）/ 通知配置（Webhook/钉钉/企微/邮件）。
 * 活动告警常驻顶部；WS 推送触发即时刷新。
 */

type Tab = 'rules' | 'history' | 'notify';
type StateFilter = '' | 'Active' | 'Cleared';
type RangeFilter = '' | '1h' | '24h' | '7d';
const HISTORY_PAGE_SIZE = 20;
const HISTORY_MIN_H = 360;

const DEFAULT_NOTIFY: NotificationConfig = {
  enabled: false,
  webhookUrl: '',
  dingtalk: { enabled: false, webhookUrl: '', secret: '' },
  wecom: { enabled: false, webhookUrl: '' },
  email: { enabled: false, host: '', port: 465, username: '', password: '', to: '', secure: true },
};

export default function AlarmCenter() {
  const { t } = useI18n();
  const alarmSeq = useRuntime((s) => s.alarmSeq);

  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [active, setActive] = useState<AlarmEvent[]>([]);
  const [rules, setRules] = useState<AlarmRule[]>([]);

  const [tab, setTab] = useState<Tab>('rules');

  // 规则 CRUD 弹窗
  const [ruleModal, setRuleModal] = useState<{ mode: 'add' | 'edit'; draft: AlarmRule } | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);

  // 历史查询
  const [history, setEvents] = useState<AlarmHistoryEvent[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [filterTagId, setFilterTagId] = useState('');
  const [filterState, setFilterState] = useState<StateFilter>('');
  const [filterRange, setFilterRange] = useState<RangeFilter>('');

  // 通知配置
  const [notify, setNotify] = useState<NotificationConfig>(DEFAULT_NOTIFY);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyTest, setNotifyTest] = useState<{ channel: string; ok: boolean; msg: string } | null>(null);

  const tagName = (id: string): string => tags.find((tg) => tg.id === id)?.name ?? id;

  const loadMeta = (): void => {
    fetchGatewayTags().then(setTags).catch(() => {});
    fetchAlarms()
      .then((d) => {
        setRules(d.rules);
        setActive(d.active);
      })
      .catch(() => {});
  };

  const queryHistory = (p: number): void => {
    setHistoryLoading(true);
    const end = Date.now();
    const spans: Record<string, number> = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3 };
    fetchAlarmHistory({
      tagId: filterTagId || undefined,
      state: filterState || undefined,
      start: filterRange ? end - spans[filterRange] : undefined,
      end: filterRange ? end : undefined,
      limit: HISTORY_PAGE_SIZE,
      offset: p * HISTORY_PAGE_SIZE,
    })
      .then((res) => {
        setEvents(res.events ?? []);
        setHistoryTotal(res.total ?? 0);
        setPage(p);
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  };

  useEffect(() => {
    loadMeta();
  }, []);

  useEffect(() => {
    queryHistory(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTagId, filterState, filterRange]);

  // WS 告警推送 → 即时刷新（历史仅在第一页时刷新，避免翻页跳动）
  useEffect(() => {
    if (alarmSeq === 0) return;
    fetchAlarms()
      .then((d) => {
        setRules(d.rules);
        setActive(d.active);
      })
      .catch(() => {});
    if (page === 0) queryHistory(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmSeq]);

  // ===== 通知配置加载 =====
  useEffect(() => {
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((d) => setNotify({ ...DEFAULT_NOTIFY, ...d }))
      .catch(() => {});
  }, []);

  const saveNotifyCfg = async (): Promise<void> => {
    setNotifyBusy(true);
    try {
      const saved = await saveNotifications(notify);
      setNotify(saved);
      showToast(t('alarms.notify.savedToast'));
    } finally {
      setNotifyBusy(false);
    }
  };

  const testNotify = async (channel: string): Promise<void> => {
    setNotifyTest({ channel, ok: true, msg: t('alarms.notify.testing') });
    const res = await testNotificationChannel(channel);
    setNotifyTest({ channel, ok: res.ok, msg: res.ok ? t('alarms.notify.testOk') : res.error ?? t('alarms.notify.testFail') });
  };

  const showToastMsg = (msg: string): void => {
    setNotifyTest({ channel: '__rule', ok: true, msg });
    setTimeout(() => setNotifyTest(null), 2500);
  };

  const submitRule = async (): Promise<void> => {
    if (!ruleModal) return;
    setRuleBusy(true);
    try {
      if (ruleModal.mode === 'add') await createAlarm(ruleModal.draft);
      else await updateAlarm(ruleModal.draft.id, ruleModal.draft);
      setRuleModal(null);
      fetchAlarms()
        .then((d) => {
          setRules(d.rules);
          setActive(d.active);
        })
        .catch(() => {});
    } finally {
      setRuleBusy(false);
    }
  };

  const toggleRule = async (rule: AlarmRule): Promise<void> => {
    await updateAlarm(rule.id, { enabled: !rule.enabled });
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !rule.enabled } : r)));
  };

  const removeRule = async (rule: AlarmRule): Promise<void> => {
    if (!window.confirm(t('alarms.confirmDelete', { rule: `${tagName(rule.tagId)} ${rule.kind === 'high' ? '>' : '<'} ${rule.threshold}` }))) return;
    await deleteAlarm(rule.id);
    setRules((prev) => prev.filter((r) => r.id !== rule.id));
    fetchAlarms().then((d) => setActive(d.active)).catch(() => {});
  };

  const totalPages = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <Bell className="w-5 h-5 text-amber-500" /> {t('alarms.title')}
        </h2>
        <p className="text-sm text-slate-500 mt-1">{t('alarms.subtitle')}</p>
      </div>

      {/* 活动告警常驻条 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50">
          <h4 className="font-bold text-slate-800 text-sm">
            {t('alarms.active')} ({active.length})
          </h4>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 min-h-[72px]">
          {active.length === 0 ? (
            <div className="col-span-full px-3 py-3 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
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
                <div className="flex items-center gap-1.5 shrink-0">
                  {!a.ack && (
                    <button
                      onClick={() => void ackAlarm(a.id).then(() => fetchAlarms().then((d) => { setRules(d.rules); setActive(d.active); }).catch(() => {}))}
                      className="px-2 py-0.5 rounded text-[10px] font-bold bg-white text-rose-600 border border-rose-300 hover:bg-rose-100"
                    >
                      {t('alarms.ack')}
                    </button>
                  )}
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white animate-pulse">{t('alarms.state.activeBadge')}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* TABS */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 border-b border-slate-200 flex gap-1">
          {(
            [
              ['rules', t('alarms.tabRules', { n: rules.length })],
              ['history', t('alarms.tabHistory', { n: historyTotal })],
              ['notify', t('alarms.tabNotify')],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === key ? 'text-indigo-600 border-indigo-600' : 'text-slate-500 hover:text-slate-700 border-transparent'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ===== 告警规则 TAB ===== */}
        {tab === 'rules' && (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs text-slate-500">{t('alarms.rulesHint')}</p>
              <button
                onClick={() =>
                  setRuleModal({
                    mode: 'add',
                    draft: { id: '', tagId: tags[0]?.id ?? '', kind: 'high', threshold: 0, hysteresis: 0.5, enabled: true, message: '' },
                  })
                }
                disabled={tags.length === 0}
                className="flex items-center px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> {t('alarms.addRule')}
              </button>
            </div>
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-[10px] uppercase font-bold border-b border-slate-200">
                  <th className="px-4 py-2.5">{t('alarms.col.tag')}</th>
                  <th className="px-4 py-2.5">{t('alarms.col.rule')}</th>
                  <th className="px-4 py-2.5">{t('alarms.col.hysteresis')}</th>
                  <th className="px-4 py-2.5">{t('alarms.col.state')}</th>
                  <th className="px-4 py-2.5">{t('alarms.col.desc')}</th>
                  <th className="px-4 py-2.5 text-right">{t('alarms.col.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((rule) => (
                  <tr key={rule.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-2.5 font-mono font-bold text-slate-800">{tagName(rule.tagId)}</td>
                    <td className="px-4 py-2.5 font-mono">
                      <span className={`font-bold ${rule.kind === 'high' ? 'text-rose-600' : 'text-blue-600'}`}>
                        {rule.kind === 'high' ? '>' : '<'} {rule.threshold}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-500">±{rule.hysteresis}</td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${rule.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                        {rule.enabled ? <Check className="w-3 h-3" /> : null} {rule.enabled ? t('alarms.enabled') : t('alarms.disabled')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">{rule.message ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => void toggleRule(rule)} className="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 mr-3">
                        {rule.enabled ? t('alarms.disable') : t('alarms.enable')}
                      </button>
                      <button onClick={() => setRuleModal({ mode: 'edit', draft: { ...rule } })} className="p-1.5 text-slate-400 hover:text-indigo-600 rounded-md hover:bg-indigo-50 mr-1" title={t('alarms.edit')}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => void removeRule(rule)} className="p-1.5 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50" title={t('alarms.delete')}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rules.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">{t('alarms.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ===== 历史事件 TAB（防抖动：查询期间保留旧数据 + 固定最小高度） ===== */}
        {tab === 'history' && (
          <div>
            <div className="px-6 py-3.5 border-b border-slate-100 bg-slate-50 flex flex-wrap items-center gap-3">
              <select
                value={filterTagId}
                onChange={(e) => setFilterTagId(e.target.value)}
                className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
              >
                <option value="">{t('alarms.filter.tag')}：{t('alarms.filter.all')}</option>
                {tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
              </select>
              <select
                value={filterState}
                onChange={(e) => setFilterState(e.target.value as StateFilter)}
                className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
              >
                <option value="">{t('alarms.filter.state')}：{t('alarms.filter.all')}</option>
                <option value="Active">{t('alarms.filter.active')}</option>
                <option value="Cleared">{t('alarms.filter.cleared')}</option>
              </select>
              <select
                value={filterRange}
                onChange={(e) => setFilterRange(e.target.value as RangeFilter)}
                className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
              >
                <option value="">{t('alarms.filter.time')}：{t('alarms.filter.all')}</option>
                <option value="1h">{t('alarms.range.1h')}</option>
                <option value="24h">{t('alarms.range.24h')}</option>
                <option value="7d">{t('alarms.range.7d')}</option>
              </select>
              {historyLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />}
              <span className="ml-auto text-xs text-slate-400 font-mono">{t('alarms.totalCount', { n: historyTotal })}</span>
            </div>

            <div style={{ minHeight: HISTORY_MIN_H }}>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-slate-50/70 text-slate-500 text-[10px] uppercase font-bold border-b border-slate-200">
                    <th className="px-6 py-2.5">{t('alarms.col.time')}</th>
                    <th className="px-6 py-2.5">{t('alarms.col.tag')}</th>
                    <th className="px-6 py-2.5">{t('alarms.col.event')}</th>
                    <th className="px-6 py-2.5 text-right">{t('alarms.col.valueThreshold')}</th>
                    <th className="px-6 py-2.5">{t('alarms.col.desc')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {history.map((e) => (
                    <tr key={e.eventId + String(e.ts)} className="hover:bg-slate-50/80">
                      <td className="px-6 py-2.5 font-mono text-slate-500">{new Date(e.ts).toLocaleString()}</td>
                      <td className="px-6 py-2.5 font-mono font-bold text-slate-800">{e.tagName}</td>
                      <td className="px-6 py-2.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          e.state === 'Active' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {e.state === 'Active' ? <Bell className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                          {e.state === 'Active' ? t('alarms.state.triggered') : t('alarms.state.cleared')}
                        </span>
                        <span className="ml-2 text-slate-400">{e.kind === 'high' ? t('alarms.kind.high') : t('alarms.kind.low')}</span>
                      </td>
                      <td className="px-6 py-2.5 text-right font-mono">
                        <span className="font-bold text-slate-800">{e.value.toFixed(2)}</span>
                        <span className="text-slate-400"> / {e.threshold}</span>
                      </td>
                      <td className="px-6 py-2.5 text-slate-500">{e.message ?? '—'}</td>
                    </tr>
                  ))}
                  {!historyLoading && history.length === 0 && (
                    <tr><td colSpan={5} className="px-6 py-10 text-center text-slate-400">{t('alarms.empty')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-end gap-2 text-xs">
              <button
                onClick={() => queryHistory(page - 1)}
                disabled={page === 0 || historyLoading}
                className="flex items-center px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> {t('alarms.prev')}
              </button>
              <span className="font-mono text-slate-500">{t('alarms.pageInfo', { current: page + 1, total: totalPages })}</span>
              <button
                onClick={() => queryHistory(page + 1)}
                disabled={(page + 1) * HISTORY_PAGE_SIZE >= historyTotal || historyLoading}
                className="flex items-center px-2.5 py-1 border border-slate-300 rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
              >
                {t('alarms.next')} <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* ===== 通知配置 TAB ===== */}
        {tab === 'notify' && (
          <NotifyConfigTab
            cfg={notify}
            onChange={setNotify}
            busy={notifyBusy}
            onSave={() => void saveNotifyCfg()}
            onTest={(ch) => void testNotify(ch)}
            testResult={notifyTest}
          />
        )}
      </div>

      {/* 规则新增/编辑弹窗 */}
      {ruleModal && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800">{ruleModal.mode === 'add' ? t('alarms.modal.add') : t('alarms.modal.edit')}</h3>
              <button onClick={() => setRuleModal(null)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('alarms.col.tag')} *</label>
                <select
                  value={ruleModal.draft.tagId}
                  onChange={(e) => setRuleModal({ ...ruleModal, draft: { ...ruleModal.draft, tagId: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-medium bg-slate-50"
                >
                  {tags.map((tg) => <option key={tg.id} value={tg.id}>{tg.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('alarms.field.kind')}</label>
                  <select
                    value={ruleModal.draft.kind}
                    onChange={(e) => setRuleModal({ ...ruleModal, draft: { ...ruleModal.draft, kind: e.target.value as 'high' | 'low' } })}
                    className="w-full px-2 py-2 border border-slate-300 rounded-md text-sm font-semibold"
                  >
                    <option value="high">{t('alarms.kind.high')} &gt;</option>
                    <option value="low">{t('alarms.kind.low')} &lt;</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('alarms.field.threshold')} *</label>
                  <input
                    value={ruleModal.draft.threshold}
                    onChange={(e) => setRuleModal({ ...ruleModal, draft: { ...ruleModal.draft, threshold: Number(e.target.value) } })}
                    className="w-full px-2 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('alarms.col.hysteresis')}</label>
                  <input
                    value={ruleModal.draft.hysteresis}
                    onChange={(e) => setRuleModal({ ...ruleModal, draft: { ...ruleModal.draft, hysteresis: Number(e.target.value) } })}
                    className="w-full px-2 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('alarms.col.desc')}</label>
                <input
                  value={ruleModal.draft.message ?? ''}
                  onChange={(e) => setRuleModal({ ...ruleModal, draft: { ...ruleModal.draft, message: e.target.value } })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                />
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
              <button onClick={() => setRuleModal(null)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md">{t('alarms.cancel')}</button>
              <button
                onClick={() => void submitRule()}
                disabled={ruleBusy}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-md flex items-center"
              >
                {ruleBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />} {t('alarms.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 通知配置 TAB 内容 */
function NotifyConfigTab({
  cfg, onChange, busy, onSave, onTest, testResult,
}: {
  cfg: NotificationConfig;
  onChange: (cfg: NotificationConfig) => void;
  busy: boolean;
  onSave: () => void;
  onTest: (channel: string) => void;
  testResult: { channel: string; ok: boolean; msg: string } | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const field = 'w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500';
  const label = 'block text-xs font-semibold text-slate-600 mb-1.5';

  const channelCard = (
    key: 'webhook' | 'dingtalk' | 'wecom' | 'email',
    title: string,
    body: React.JSX.Element,
  ): React.JSX.Element => {
    const enabled = key === 'webhook' ? Boolean(cfg.webhookUrl) : cfg[key].enabled;
    const test = testResult?.channel === key ? testResult : null;
    return (
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 bg-slate-50 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-800">{title}</span>
          <div className="flex items-center gap-2">
            {key !== 'webhook' && (
              <button
                onClick={() => onChange({ ...cfg, [key]: { ...cfg[key], enabled: !enabled } })}
                className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                  enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'
                }`}
              >
                {enabled ? t('alarms.enabled') : t('alarms.disabled')}
              </button>
            )}
            <button
              onClick={() => onTest(key)}
              className="flex items-center px-2 py-0.5 text-[10px] font-bold text-indigo-600 hover:bg-indigo-50 rounded"
            >
              <Send className="w-3 h-3 mr-0.5" /> {t('alarms.test')}
            </button>
          </div>
        </div>
        <div className="p-4 space-y-3">{body}</div>
        {test && (
          <div className={`px-4 py-1.5 text-[11px] ${test.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
            {test.ok ? '✓ ' : '✗ '}{test.msg}
          </div>
        )}
        {!enabled && key !== 'webhook' && <div className="px-4 py-1.5 text-[10px] text-slate-400 bg-slate-50">{t('alarms.channelDisabled')}</div>}
      </div>
    );
  };

  return (
    <div className="p-6 space-y-5">
      <div className="px-4 py-3 rounded-lg bg-indigo-50/60 border border-indigo-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-slate-800">{t('alarms.notify.master')}</div>
          <div className="text-[11px] text-slate-500">{t('alarms.notify.masterHint')}</div>
        </div>
        <button
          onClick={() => onChange({ ...cfg, enabled: !cfg.enabled })}
          className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors ${
            cfg.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'
          }`}
        >
          {cfg.enabled ? t('alarms.notify.on') : t('alarms.notify.off')}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {channelCard('webhook', t('alarms.channel.webhook'), (
          <div>
            <label className={label}>{t('alarms.field.webhookUrl')}</label>
            <input value={cfg.webhookUrl} onChange={(e) => onChange({ ...cfg, webhookUrl: e.target.value })} placeholder="https://…" className={field} />
            <p className="text-[10px] text-slate-400 mt-1">{t('alarms.field.postJson')}{`{ event, tagName, kind, value, threshold, message }`}</p>
          </div>
        ))}

        {channelCard('dingtalk', t('alarms.channel.dingtalk'), (
          <div className="space-y-2">
            <div>
              <label className={label}>{t('alarms.field.webhookUrl')}</label>
              <input
                value={cfg.dingtalk.webhookUrl}
                onChange={(e) => onChange({ ...cfg, dingtalk: { ...cfg.dingtalk, webhookUrl: e.target.value } })}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                className={field}
              />
            </div>
            <div>
              <label className={label}>{t('alarms.field.secret')}</label>
              <input
                value={cfg.dingtalk.secret}
                onChange={(e) => onChange({ ...cfg, dingtalk: { ...cfg.dingtalk, secret: e.target.value } })}
                placeholder="SEC…"
                className={field}
              />
            </div>
          </div>
        ))}

        {channelCard('wecom', t('alarms.channel.wecom'), (
          <div>
            <label className={label}>{t('alarms.field.webhookUrl')}</label>
            <input
              value={cfg.wecom.webhookUrl}
              onChange={(e) => onChange({ ...cfg, wecom: { ...cfg.wecom, webhookUrl: e.target.value } })}
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
              className={field}
            />
          </div>
        ))}

        {channelCard('email', t('alarms.channel.email'), (
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <label className={label}>{t('alarms.field.smtpHost')}</label>
              <input value={cfg.email.host} onChange={(e) => onChange({ ...cfg, email: { ...cfg.email, host: e.target.value } })} placeholder="smtp.example.com" className={field} />
            </div>
            <div>
              <label className={label}>{t('alarms.field.port')}</label>
              <input value={cfg.email.port} onChange={(e) => onChange({ ...cfg, email: { ...cfg.email, port: Number(e.target.value) } })} className={field} />
            </div>
            <div>
              <label className={label}>TLS</label>
              <button
                onClick={() => onChange({ ...cfg, email: { ...cfg.email, secure: !cfg.email.secure } })}
                className={`w-full px-3 py-2 rounded-md text-xs font-bold border ${cfg.email.secure ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-50 text-slate-500 border-slate-200'}`}
              >
                {cfg.email.secure ? 'SSL/TLS' : 'STARTTLS'}
              </button>
            </div>
            <div>
              <label className={label}>{t('alarms.field.username')}</label>
              <input value={cfg.email.username} onChange={(e) => onChange({ ...cfg, email: { ...cfg.email, username: e.target.value } })} className={field} />
            </div>
            <div>
              <label className={label}>{t('alarms.field.password')}</label>
              <input type="password" value={cfg.email.password} onChange={(e) => onChange({ ...cfg, email: { ...cfg.email, password: e.target.value } })} className={field} />
            </div>
            <div className="col-span-2">
              <label className={label}>{t('alarms.field.recipients')}</label>
              <input value={cfg.email.to} onChange={(e) => onChange({ ...cfg, email: { ...cfg.email, to: e.target.value } })} placeholder="a@x.com, b@x.com" className={field} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex items-center px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} {t('alarms.notify.save')}
        </button>
      </div>
    </div>
  );
}

function showToast(msg: string): void {
  // 简易 toast：复用页面级提示（后续统一到 Toast 组件）
  window.dispatchEvent(new CustomEvent('fb-toast', { detail: msg }));
}
