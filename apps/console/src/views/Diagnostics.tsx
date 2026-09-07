import React, { useEffect, useMemo, useState } from 'react';
import { fetchAlarms, fetchGatewayTags, fetchShadow, writeTagValue, createAlarm, updateAlarm, deleteAlarm, type AlarmRule, type GatewayTag, type TagShadow } from '../api';
import { useRuntime } from '../store/runtime';
import { useI18n } from '../i18n';
import { alarmKindColorCls } from '../components/alarmKind';
import { Search, Send, X, Bell, Trash2, Check, Loader2, Copy } from 'lucide-react';

/**
 * 在线参数诊断（PRD M5）：真实位号表 + WS 实时值 + 类型感知写入 + 告警规则管理。
 * 位号来自网关 /api/tags（单一数据源），实时值/质量来自 WS 推送。
 */

type WriteTarget = { tag: GatewayTag };
type AlarmTarget = { tag: GatewayTag };

export default function Diagnose() {
  const { t } = useI18n();
  const [tags, setTags] = useState<GatewayTag[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const { liveValues, status, connect } = useRuntime();

  const [writeTarget, setWriteTarget] = useState<WriteTarget | null>(null);
  const [writeValue, setWriteValue] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeResult, setWriteResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [alarmTarget, setAlarmTarget] = useState<AlarmTarget | null>(null);
  const [alarmRules, setAlarmRules] = useState<AlarmRule[]>([]);
  const [alarmKind, setAlarmKind] = useState<'high' | 'low'>('high');
  const [alarmThreshold, setAlarmThreshold] = useState('');
  const [alarmHyst, setAlarmHyst] = useState('0.2');
  const [alarmBusy, setAlarmBusy] = useState(false);

  const loadTags = (): void => {
    fetchGatewayTags().then(setTags).catch(() => setTags([]));
  };

  useEffect(() => {
    connect();
    loadTags();
  }, [connect]);

  // ===== #22 设备影子（FR-M9-04）：reported vs desired =====
  const [shadows, setShadows] = useState<TagShadow[]>([]);
  const [shadowPending, setShadowPending] = useState(0);
  const [shadowSearch, setShadowSearch] = useState('');

  const loadShadow = (): void => {
    fetchShadow().then((d) => { setShadows(d.shadows); setShadowPending(d.pending); }).catch(() => undefined);
  };

  useEffect(() => {
    loadShadow();
    const timer = setInterval(loadShadow, 3000);
    return () => clearInterval(timer);
  }, []);

  const filteredShadows = useMemo(
    () => shadows.filter((s) =>
      s.name.toLowerCase().includes(shadowSearch.toLowerCase()) ||
      s.channel.toLowerCase().includes(shadowSearch.toLowerCase())),
    [shadows, shadowSearch],
  );

  const loadAlarmRules = (): void => {
    fetchAlarms().then((d) => setAlarmRules(d.rules)).catch(() => setAlarmRules([]));
  };

  const filteredTags = useMemo(
    () =>
      tags.filter(
        (t) =>
          t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          t.channelId.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
    [tags, searchTerm],
  );

  const openWrite = (tag: GatewayTag): void => {
    const current = liveValues[tag.id]?.value;
    setWriteTarget({ tag });
    setWriteValue(typeof current === 'boolean' ? String(current) : typeof current === 'number' ? String(current) : '');
    setWriteResult(null);
  };

  const submitWrite = async (): Promise<void> => {
    if (!writeTarget) return;
    const { tag } = writeTarget;
    let value: number | string | boolean = writeValue;
    if (tag.dataType === 'Bool') {
      value = writeValue.trim().toLowerCase() === 'true' || writeValue === '1';
    } else if (tag.dataType !== 'String') {
      value = Number(writeValue);
      if (Number.isNaN(value)) {
        setWriteResult({ ok: false, msg: t('diag.invalidNumber') });
        return;
      }
    }
    setWriteBusy(true);
    const result = await writeTagValue(tag.id, value);
    setWriteBusy(false);
    setWriteResult(
      result.ok
        ? { ok: true, msg: t('diag.writeSent', { name: tag.name, value: String(value) }) }
        : { ok: false, msg: t('diag.writeFailed', { error: result.error ?? 'unknown' }) },
    );
  };

  const openAlarms = (tag: GatewayTag): void => {
    setAlarmTarget({ tag });
    setAlarmThreshold('');
    setAlarmKind('high');
    loadAlarmRules();
  };

  const tagRules = alarmRules.filter((r) => r.tagId === alarmTarget?.tag.id);

  const submitAlarm = async (): Promise<void> => {
    if (!alarmTarget || !alarmThreshold) return;
    const threshold = Number(alarmThreshold);
    if (Number.isNaN(threshold)) return;
    setAlarmBusy(true);
    await createAlarm({
      tagId: alarmTarget.tag.id,
      kind: alarmKind,
      threshold,
      hysteresis: Number(alarmHyst) || 0,
      enabled: true,
      message: `${alarmTarget.tag.name} ${alarmKind === 'high' ? '>' : '<'} ${threshold}`,
    });
    setAlarmBusy(false);
    loadAlarmRules();
  };

  const qualityCell = (tag: GatewayTag): { label: string; cls: string } => {
    const live = liveValues[tag.id];
    const q = live?.quality ?? 'Uncertain';
    if (q === 'Good') return { label: 'Good', cls: 'text-green-700 bg-green-500' };
    if (q === 'Bad') return { label: 'Bad', cls: 'text-rose-700 bg-rose-500' };
    return { label: 'Uncertain', cls: 'text-amber-700 bg-amber-400' };
  };

  const formatLive = (tag: GatewayTag): string => {
    const live = liveValues[tag.id];
    if (!live) return '—';
    const v = live.value;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
    return String(v);
  };

  return (
    <div className="space-y-6 relative">
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
          <div className="relative w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={t('diag.filterPlaceholder')}
              className="w-full pl-9 pr-4 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <span
              className={`w-2 h-2 rounded-full ${
                status === 'live' ? 'bg-green-500 animate-pulse' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'
              }`}
            />
            {status === 'live' ? t('diag.liveCount', { n: tags.length }) : status === 'connecting' ? t('diag.connecting') : t('diag.offline')}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold tracking-wider">
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.channel')}</th>
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.tag')}</th>
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.address')}</th>
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.value')}</th>
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.type')}</th>
                <th className="px-6 py-3 border-b border-slate-200">{t('diag.col.quality')}</th>
                <th className="px-6 py-3 border-b border-slate-200 text-right">{t('diag.col.actions')}</th>
              </tr>
            </thead>
            <tbody className="text-sm text-slate-600">
              {filteredTags.map((tag) => {
                const q = qualityCell(tag);
                return (
                  <tr key={tag.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-3 font-mono font-medium text-[12px]">{tag.channelId}</td>
                    <td className="px-6 py-3 font-mono font-medium text-slate-900">
                      {tag.name}
                      {tag.unit && <span className="ml-1 text-slate-400 text-[11px]">{tag.unit}</span>}
                    </td>
                    <td className="px-6 py-3 font-mono text-[12px] text-slate-500">{tag.address}</td>
                    <td className="px-6 py-3 font-semibold text-slate-800 font-mono">{formatLive(tag)}</td>
                    <td className="px-6 py-3 text-slate-500 text-[12px]">{tag.dataType}</td>
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center gap-2 font-medium ${q.cls.replace(/bg-\S+/, '')}`}>
                        <span className={`w-2 h-2 rounded-full ${q.cls.split(' ')[1]}`}></span>
                        {q.label}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => openAlarms(tag)}
                        className="text-slate-400 hover:text-amber-600 transition-colors p-1.5 rounded-md hover:bg-amber-50 mr-1"
                        title={t('diag.alarmRules')}
                      >
                        <Bell className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => openWrite(tag)}
                        className="text-slate-400 hover:text-indigo-600 transition-colors p-1.5 rounded-md hover:bg-indigo-50"
                        title={t('diag.write')}
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filteredTags.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-slate-500 text-sm">
                    {tags.length === 0 ? t('diag.noTagsLoaded') : t('diag.noMatch', { q: searchTerm })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ===== #22 设备影子（FR-M9-04）===== */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
          <div className="flex items-center gap-2.5">
            <Copy className="w-4 h-4 text-indigo-600" />
            <h3 className="font-bold text-slate-800 text-sm">{t('diag.shadow.title')}</h3>
            {shadowPending > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold">
                {t('diag.shadow.pendingBadge', { n: shadowPending })}
              </span>
            )}
          </div>
          <div className="relative w-56">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder={t('diag.shadow.search')}
              value={shadowSearch}
              onChange={(e) => setShadowSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 border border-slate-300 rounded-md text-xs focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold tracking-wider">
                <th className="px-6 py-2.5 border-b border-slate-200">{t('diag.col.tag')}</th>
                <th className="px-6 py-2.5 border-b border-slate-200">{t('diag.col.channel')}</th>
                <th className="px-6 py-2.5 border-b border-slate-200">{t('diag.shadow.reported')}</th>
                <th className="px-6 py-2.5 border-b border-slate-200">{t('diag.shadow.desired')}</th>
                <th className="px-6 py-2.5 border-b border-slate-200">{t('diag.shadow.state')}</th>
              </tr>
            </thead>
            <tbody className="text-sm text-slate-600">
              {filteredShadows.map((s) => (
                <tr key={s.tagId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-2.5 font-mono font-medium text-slate-900 text-[12px]">{s.name}</td>
                  <td className="px-6 py-2.5 font-mono text-[12px] text-slate-500">{s.channel}</td>
                  <td className="px-6 py-2.5 font-mono text-[12px]">
                    {s.reported ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${s.reported.quality === 'Bad' ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                        <span className="text-slate-800 font-semibold">{String(s.reported.value)}</span>
                        <span className="text-slate-400 text-[10px]">{new Date(s.reported.ts).toLocaleTimeString()}</span>
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-2.5 font-mono text-[12px]">
                    {s.desired ? (
                      <span title={`${t('diag.shadow.by')} ${s.desired.by} · ${new Date(s.desired.ts).toLocaleTimeString()}`}>
                        <span className="text-indigo-700 font-semibold">{String(s.desired.value)}</span>
                        <span className="text-slate-400 text-[10px] ml-1">@{s.desired.by}</span>
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-6 py-2.5">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      s.state === 'pending' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'
                    }`}>
                      {s.state === 'pending' ? t('diag.shadow.pending') : t('diag.shadow.synced')}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredShadows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-6 py-6 text-center text-slate-400 text-xs">
                    {shadows.length === 0 ? t('diag.shadow.empty') : t('diag.noMatch', { q: shadowSearch })}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-2 bg-slate-50 text-[10px] text-slate-400">
          {t('diag.shadow.hint')}
        </div>
      </div>

      {/* 写入弹窗 */}
      {writeTarget && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800">{t('diag.writeTitle')}</h3>
              <button onClick={() => setWriteTarget(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t('diag.label.tag')}</label>
                <div className="text-sm font-mono font-medium text-slate-900">
                  {writeTarget.tag.name}
                  {writeTarget.tag.unit && <span className="ml-1 text-slate-400">({writeTarget.tag.unit})</span>}
                </div>
                <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                  {writeTarget.tag.channelId} · {writeTarget.tag.address} · {writeTarget.tag.dataType}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t('diag.label.currentValue')}</label>
                <div className="text-sm text-slate-700 font-mono">{formatLive(writeTarget.tag)}</div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">{t('diag.label.newValue')}</label>
                {writeTarget.tag.dataType === 'Bool' ? (
                  <select
                    value={writeValue}
                    onChange={(e) => setWriteValue(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="true">TRUE</option>
                    <option value="false">FALSE</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={writeValue}
                    onChange={(e) => setWriteValue(e.target.value)}
                    inputMode={writeTarget.tag.dataType === 'String' ? 'text' : 'decimal'}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    autoFocus
                  />
                )}
                <p className="text-[11px] text-slate-400 mt-1.5">
                  {t('diag.writeWarning')}
                </p>
              </div>
              {writeResult && (
                <div
                  className={`px-3 py-2 rounded-md text-xs flex items-center gap-2 ${
                    writeResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
                  }`}
                >
                  {writeResult.ok ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                  {writeResult.msg}
                </div>
              )}
            </div>
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end space-x-3">
              <button
                onClick={() => setWriteTarget(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-md transition-colors"
              >
                {t('diag.close')}
              </button>
              <button
                onClick={() => void submitWrite()}
                disabled={writeBusy}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 rounded-md transition-colors flex items-center"
              >
                {writeBusy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                {t('diag.confirmWrite')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 告警规则弹窗 */}
      {alarmTarget && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-500" /> {t('diag.alarmRules')}
              </h3>
              <button
                onClick={() => setAlarmTarget(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="text-sm font-mono font-medium text-slate-900">{alarmTarget.tag.name}</div>

              {tagRules.length > 0 && (
                <div className="space-y-2">
                  {tagRules.map((rule) => (
                    <div key={rule.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="text-xs">
                        <span className={`font-bold ${alarmKindColorCls(rule.kind)}`}>
                          {t(`diag.kind.${rule.kind}`)}
                        </span>
                        <span className="font-mono ml-1">{rule.threshold}</span>
                        <span className="text-slate-400 ml-2">{t('diag.hysteresis')} {rule.hysteresis}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => void updateAlarm(rule.id, { enabled: !rule.enabled }).then(loadAlarmRules)}
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            rule.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          {rule.enabled ? t('diag.enabled') : t('diag.disabled')}
                        </button>
                        <button
                          onClick={() => void deleteAlarm(rule.id).then(loadAlarmRules)}
                          className="p-1 text-slate-400 hover:text-rose-600"
                          title={t('diag.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-600 mb-2">{t('diag.newRule')}</div>
                <div className="flex items-center gap-2">
                  <select
                    value={alarmKind}
                    onChange={(e) => setAlarmKind(e.target.value as 'high' | 'low')}
                    className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-semibold"
                  >
                    <option value="high">{t('diag.kind.high')} &gt;</option>
                    <option value="low">{t('diag.kind.low')} &lt;</option>
                  </select>
                  <input
                    type="text"
                    placeholder={t('diag.threshold')}
                    value={alarmThreshold}
                    onChange={(e) => setAlarmThreshold(e.target.value)}
                    className="w-24 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                  />
                  <span className="text-[11px] text-slate-400">{t('diag.hysteresis')}</span>
                  <input
                    type="text"
                    value={alarmHyst}
                    onChange={(e) => setAlarmHyst(e.target.value)}
                    className="w-16 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                  />
                  <button
                    onClick={() => void submitAlarm()}
                    disabled={alarmBusy || !alarmThreshold}
                    className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-50 flex items-center"
                  >
                    {alarmBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
