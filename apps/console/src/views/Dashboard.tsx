import React, { useEffect, useState } from 'react';
import { mockTags } from '../data';
import { useI18n } from '../i18n';
import { useRuntime } from '../store/runtime';
import { ackAlarm, fetchAlarms, type AlarmsResponse } from '../api';
import { Server, Activity, AlertTriangle, CheckCircle, Bell } from 'lucide-react';

/** 按数据类型格式化：整数不带小数，浮点 2 位（UI 规范 §3.3） */
function formatValue(v: number | string | boolean): string {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return String(v);
}

export default function Dashboard() {
  const { t } = useI18n();
  const { liveValues, channels, status, lastUpdateTs, connect } = useRuntime();
  const [alarms, setAlarms] = useState<AlarmsResponse | null>(null);

  useEffect(() => {
    connect();
  }, [connect]);

  // 告警刷新：WS 实时推送触发即时刷新 + 5s 轮询兜底（PRD FR-M1-04）
  const alarmSeq = useRuntime((s) => s.alarmSeq);
  useEffect(() => {
    const load = (): void => { fetchAlarms().then(setAlarms).catch(() => {}); };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (alarmSeq > 0) fetchAlarms().then(setAlarms).catch(() => {});
  }, [alarmSeq]);

  const activeAlarms = alarms?.active ?? [];
  const recentAlarms = (alarms?.history ?? []).slice(0, 6);

  const activeTags = mockTags.length;
  const goodQualityTags = mockTags.filter((t) => liveValues[t.id]?.quality !== 'Bad').length;
  const warnings = activeTags - goodQualityTags;
  const onlineChannels = Object.values(channels).filter((c) => c.state === 'online').length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">Monitored Tags</div>
            <Server className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-3xl font-bold">{activeTags}</div>
          <div className="text-indigo-600 text-xs mt-2">Active connections</div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">Good Quality</div>
            <CheckCircle className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-3xl font-bold">{goodQualityTags}</div>
          <div className="text-green-600 text-xs mt-2">Optimal range</div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">Warnings</div>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className={`text-3xl font-bold ${activeAlarms.length > 0 ? 'text-rose-500' : 'text-amber-500'}`}>
            {activeAlarms.length}
          </div>
          <div className="text-amber-600/80 text-xs mt-2">
            {activeAlarms.length > 0 ? t('dash.kpi.alarmsPending') : t('dash.kpi.badQualityTags')}
          </div>
        </div>
      </div>

      {/* 告警面板（PRD FR-M1-04） */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <h3 className="font-semibold text-slate-800 flex items-center">
            <Bell className={`w-5 h-5 mr-2 ${activeAlarms.length > 0 ? 'text-rose-500' : 'text-slate-500'}`} />
            Alarms
            {activeAlarms.length > 0 && (
              <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 animate-pulse">
                {activeAlarms.length} ACTIVE
              </span>
            )}
          </h3>
          <span className="text-xs text-slate-400 font-mono">{t('dash.alarms.ruleCount', { n: alarms?.rules.length ?? 0 })}</span>
        </div>
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Active</div>
            {activeAlarms.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
                {t('dash.alarms.emptyActive')}
              </div>
            ) : (
              <div className="space-y-2">
                {activeAlarms.map((a) => (
                  <div key={a.id} className="px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-rose-800 truncate">
                        {a.tagName} <span className="font-mono">{a.kind === 'high' ? '>' : '<'} {a.threshold}</span>
                        {a.ack && <span className="ml-1.5 text-[10px] text-slate-500 font-normal">{t('dash.alarms.ackedBy', { user: a.ack.user })}</span>}
                      </div>
                      <div className="text-[10px] text-rose-500 font-mono">
                        {t('dash.alarms.currentValue', { value: a.value.toFixed(2), time: new Date(a.ts).toLocaleTimeString() })}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!a.ack && (
                        <button
                          onClick={() => void ackAlarm(a.id).then(() => fetchAlarms().then(setAlarms).catch(() => {}))}
                          className="px-2 py-0.5 rounded text-[10px] font-bold bg-white text-rose-600 border border-rose-300 hover:bg-rose-100"
                        >
                          {t('dash.alarms.ack')}
                        </button>
                      )}
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white animate-pulse">
                        ACTIVE
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Recent Events</div>
            {recentAlarms.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
                {t('dash.alarms.noEvents')}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-32 overflow-y-auto">
                {recentAlarms.map((a) => (
                  <div key={a.id} className="px-3 py-1.5 rounded-md bg-slate-50 border border-slate-100 flex items-center justify-between text-[11px]">
                    <span className={`font-bold ${a.state === 'Active' ? 'text-rose-600' : 'text-slate-500'}`}>
                      {a.tagName} {a.state === 'Active' ? t('dash.alarms.triggered') : t('dash.alarms.recovered')}
                    </span>
                    <span className="font-mono text-slate-400">
                      {a.value.toFixed(2)} · {new Date(a.ts).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <h3 className="font-semibold text-slate-800 flex items-center">
            <Activity className="w-5 h-5 mr-2 text-slate-500" />
            Live Equipment Status
          </h3>
          <div className="flex items-center gap-2 text-xs font-medium">
            <span
              className={`w-2 h-2 rounded-full ${
                status === 'live'
                  ? 'bg-green-500 animate-pulse'
                  : status === 'connecting'
                    ? 'bg-amber-400 animate-pulse'
                    : 'bg-slate-300'
              }`}
            />
            <span className="text-slate-500">
              {status === 'live'
                ? `${onlineChannels} channel(s) online · updated ${lastUpdateTs ? new Date(lastUpdateTs).toLocaleTimeString() : '—'}`
                : status === 'connecting'
                  ? 'Connecting to gateway…'
                  : 'Gateway offline, retrying…'}
            </span>
          </div>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {mockTags.map((tag) => {
              const live = liveValues[tag.id];
              const value = live ? live.value : tag.value;
              const isBad = live?.quality === 'Bad';
              return (
                <div key={tag.id} className="p-4 rounded-lg border border-slate-100 bg-slate-50 flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-slate-400">{tag.channel}</span>
                    {live && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${isBad ? 'bg-rose-500' : 'bg-green-500'}`}
                        title={isBad ? 'Bad quality' : `Live (${live.quality})`}
                      />
                    )}
                  </div>
                  <span className="font-medium text-slate-700 truncate" title={tag.name}>
                    {tag.name.split('.')[1] || tag.name}
                  </span>
                  <div
                    className={`mt-2 text-2xl font-bold flex items-baseline ${isBad ? 'text-slate-400' : 'text-slate-900'}`}
                  >
                    {typeof value === 'boolean' ? (
                      <span className={value ? 'text-green-600' : 'text-slate-400'}>{value ? 'TRUE' : 'FALSE'}</span>
                    ) : (
                      <span className="font-mono tabular-nums">{formatValue(value)}</span>
                    )}
                    {tag.type === 'number' && tag.name.includes('Temperature') && (
                      <span className="ml-1 text-sm text-slate-500 font-normal">°C</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
