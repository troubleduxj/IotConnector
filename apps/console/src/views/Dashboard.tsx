/**
 * 仪表盘（PRD FR-M1，P1+P2+P3 重构）：全真实数据，无 mock。
 * A 区：运行总览 KPI（采集吞吐走势 / 在线通道点阵 / 位号质量 / 活动告警 / 存储管道）
 * B 区：通道健康带 —— 仅展示已创建通道（配置 × /api/scheduler × WS channel-status）
 * C 区：关键工况趋势（C1，TDengine 真聚合 sparkline，可置顶位号）+ 告警速览（C2）
 * D 区：位号总览 —— 按通道分组的真实位号网格，WS 实时值
 * 数据源：/api/config、/api/scheduler（3s）、/api/history（30s）、/api/alarms（WS alarmSeq 触发）、WS tags-batch/storage-status
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, Bell, CheckCircle, ChevronRight, Database, Server,
  SlidersHorizontal, TrendingUp, X,
} from 'lucide-react';
import {
  ackAlarm, fetchAlarms, fetchConfig, fetchHistory, fetchScheduler,
  type AlarmsResponse, type GatewayChannel, type GatewayTag, type SchedulerStats,
} from '../api';
import { PROTOCOL_CONFIGS, type Protocol } from '../shared';
import { useRuntime } from '../store/runtime';
import { useI18n } from '../i18n';
import { alarmKindSymbol } from '../components/alarmKind';

export type DashboardNavTarget = 'devices' | 'diagnostics' | 'alarms' | 'historian';

/** 时长格式化：zh「2分14秒」/ en「2m 14s」；超 1h 显示「1h 5m」 */
function fmtDuration(ms: number, lang: string): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (lang === 'zh') return h > 0 ? `${h}小时${m}分` : `${m}分${sec}秒`;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
}

function formatValue(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  }
  return v;
}

/** 从 WS channel-status detail（如「OK 12ms」）提取往返时延；其余格式（如 OPC UA 订阅描述）不视为时延 */
function parseLatency(detail?: string): string | null {
  const m = detail?.match(/OK (\d+)\s*ms/);
  return m ? `${m[1]}ms` : null;
}

/** 从协议固定色板（text-x border-y bg-z）中取边框色类 */
function protocolBorderCls(protocol: string): string {
  const cls = PROTOCOL_CONFIGS[protocol as Protocol]?.color ?? '';
  return cls.split(' ').find((c) => c.startsWith('border-')) ?? 'border-slate-300';
}

function protocolChipCls(protocol: string): string {
  return PROTOCOL_CONFIGS[protocol as Protocol]?.color ?? 'text-slate-600 border-slate-300 bg-slate-50';
}

/** 协议徽章短名（去尾注，如「EtherNet/IP (Rockwell)」→「EtherNet/IP」） */
function protocolShortName(protocol: string): string {
  return (PROTOCOL_CONFIGS[protocol as Protocol]?.name ?? protocol).replace(/\s+\([^)]*\)$/, '');
}

/** 通道实时状态：WS 优先，调度指标兜底 */
function channelState(
  chId: string,
  wsChannels: Record<string, { state: string }>,
  sched?: SchedulerStats,
): string {
  return wsChannels[chId]?.state ?? sched?.channels.find((c) => c.id === chId)?.state ?? 'offline';
}

export default function Dashboard({ onNavigate }: { onNavigate?: (v: DashboardNavTarget) => void }): React.JSX.Element {
  const { t, lang } = useI18n();
  const { liveValues, channels: wsChannels, storage, status: wsStatus, alarmSeq, connect } = useRuntime();

  const [config, setConfig] = useState<{ channels: GatewayChannel[]; tags: GatewayTag[] } | null>(null);
  const [sched, setSched] = useState<SchedulerStats | null>(null);
  const [alarms, setAlarms] = useState<AlarmsResponse | null>(null);
  const [now, setNow] = useState(Date.now());
  const rateRing = useRef<number[]>([]); // 吞吐迷你走势（最近 40 个 3s 采样）

  const loadAlarms = (): void => { fetchAlarms().then(setAlarms).catch(() => {}); };
  const loadSched = (): void => {
    fetchScheduler()
      .then((s) => {
        setSched(s);
        const ring = rateRing.current;
        ring.push(s.rateHz);
        if (ring.length > 40) ring.splice(0, ring.length - 40);
      })
      .catch(() => {});
  };

  useEffect(() => {
    connect();
    fetchConfig().then(setConfig).catch(() => {});
    loadAlarms();
    loadSched();
    const timer = setInterval(loadSched, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (alarmSeq > 0) loadAlarms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alarmSeq]);

  const activeAlarms = alarms?.active ?? [];
  // 持续时长跳动：仅存在活动告警时开启 1s 刷新
  useEffect(() => {
    if (activeAlarms.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeAlarms.length]);

  const channels = config?.channels ?? [];
  const allTags = config?.tags ?? [];
  const tagsByChannel = useMemo(() => {
    const m = new Map<string, GatewayTag[]>();
    for (const tag of allTags) {
      const list = m.get(tag.channelId) ?? [];
      list.push(tag);
      m.set(tag.channelId, list);
    }
    return m;
  }, [allTags]);

  const enabledChannels = channels.filter((c) => c.enabled);
  const onlineCount = enabledChannels.filter((c) => channelState(c.id, wsChannels, sched ?? undefined) === 'online').length;
  const goodTags = allTags.filter((tg) => liveValues[tg.id]?.quality !== 'Bad' && liveValues[tg.id] !== undefined).length;
  const badTags = allTags.filter((tg) => liveValues[tg.id]?.quality === 'Bad').length;
  const longestAlarm = activeAlarms.length > 0
    ? activeAlarms.reduce((a, b) => (now - a.ts > now - b.ts ? a : b))
    : null;
  const storageState = storage?.state ?? null;

  return (
    <div className="space-y-6">
      {/* ===== A 区：运行总览 KPI ===== */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {/* 采集吞吐 + 迷你走势 */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">{t('dash.kpi.throughput')}</div>
            <Activity className="w-4 h-4 text-indigo-500" />
          </div>
          <div className="text-2xl font-bold tabular-nums">{sched ? sched.rateHz.toFixed(1) : '—'}<span className="text-sm text-slate-400 font-medium"> /s</span></div>
          <Sparkline values={rateRing.current} />
          <div className="text-indigo-600 text-xs mt-1">{t('dash.kpi.totalSamples', { n: sched?.totalSamples ?? 0 })}</div>
        </div>

        {/* 在线通道（点阵） */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">{t('dash.kpi.onlineChannels')}</div>
            <Server className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl font-bold tabular-nums">
            {onlineCount}<span className="text-sm text-slate-400 font-medium"> / {enabledChannels.length}</span>
          </div>
          <div className="flex flex-wrap gap-1 mt-2.5">
            {enabledChannels.map((c) => {
              const st = channelState(c.id, wsChannels, sched ?? undefined);
              return (
                <span
                  key={c.id}
                  title={`${c.name} · ${t(st === 'online' ? 'dash.channels.online' : st === 'connecting' ? 'dash.channels.connecting' : 'dash.channels.offline')}`}
                  className={`w-2.5 h-2.5 rounded-full ${st === 'online' ? 'bg-emerald-500' : st === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-400'}`}
                />
              );
            })}
            {enabledChannels.length === 0 && <span className="text-slate-400 text-xs">—</span>}
          </div>
        </div>

        {/* 监测位号 + 质量分布 */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">{t('dash.kpi.monitoredTags')}</div>
            <CheckCircle className="w-4 h-4 text-slate-400" />
          </div>
          <div className="text-2xl font-bold tabular-nums">{allTags.length}</div>
          <div className="text-xs mt-2">
            <span className="text-emerald-600 font-semibold">{goodTags} ✓</span>
            <span className="text-slate-300 mx-1">·</span>
            <span className={badTags > 0 ? 'text-rose-600 font-semibold' : 'text-slate-400 font-semibold'}>{badTags} ✗</span>
          </div>
        </div>

        {/* 活动告警 + 持续最长 */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">{t('dash.kpi.activeAlarms')}</div>
            <Bell className={`w-4 h-4 ${activeAlarms.length > 0 ? 'text-rose-500' : 'text-slate-400'}`} />
          </div>
          <div className={`text-2xl font-bold tabular-nums ${activeAlarms.length > 0 ? 'text-rose-500' : 'text-slate-700'}`}>
            {activeAlarms.length}
          </div>
          <div className="text-xs mt-2 text-slate-500">
            {longestAlarm ? t('dash.alarms.longest', { d: fmtDuration(now - longestAlarm.ts, lang) }) : t('dash.alarms.emptyActive')}
          </div>
        </div>

        {/* 存储管道 */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-slate-500 text-xs font-semibold uppercase tracking-wider">{t('dash.kpi.storage')}</div>
            <Database className="w-4 h-4 text-slate-400" />
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              storageState === 'online' ? 'bg-emerald-500' : storageState === 'offline' ? 'bg-amber-400' : 'bg-slate-300'
            }`} />
            <span className="text-lg font-bold">
              {storageState ? t(`dash.storage.state.${storageState}`) : '—'}
            </span>
          </div>
          <div className="text-xs mt-2 text-slate-500">
            {storage ? t('dash.storage.queue', { queued: storage.queued, written: storage.written }) : '—'}
          </div>
        </div>
      </div>

      {/* ===== B 区：通道健康带（仅已创建通道） ===== */}
      <div>
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">{t('dash.channels.title')}</div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {channels.map((ch) => {
            const sc = sched?.channels.find((s) => s.id === ch.id);
            const st = channelState(ch.id, wsChannels, sched ?? undefined);
            const latency = parseLatency(wsChannels[ch.id]?.detail);
            const expectedHz = sc && sc.tags > 0 ? sc.tags / Math.max(0.2, ch.pollIntervalMs / 1000) : 0;
            const ratio = ch.enabled && expectedHz > 0 ? Math.min(1, sc!.rateHz / expectedHz) : 0;
            // 负载语义：贴近期望周期（≥80%）即健康；仅明显欠采计时预警
            const loadCls = ratio >= 0.8 ? 'bg-emerald-500' : ratio >= 0.3 ? 'bg-amber-500' : 'bg-slate-300';
            return (
              <button
                key={ch.id}
                onClick={() => onNavigate?.('devices')}
                className={`text-left bg-white p-3 rounded-xl border border-slate-200 shadow-sm border-l-4 ${protocolBorderCls(ch.protocol)} transition-colors hover:border-slate-300 ${ch.enabled ? '' : 'opacity-55'}`}
              >
                <div className="flex items-center justify-between gap-1 mb-1.5">
                  <span className="text-sm font-bold text-slate-800 truncate">{ch.name}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${ch.enabled ? (st === 'online' ? 'bg-emerald-500' : st === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-400') : 'bg-slate-300'}`} />
                </div>
                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${protocolChipCls(ch.protocol)}`}>
                  {protocolShortName(ch.protocol)}
                </span>
                <div className="mt-2 text-[11px] text-slate-500 tabular-nums">
                  {sc ? t('dash.channels.cardStats', { tags: sc.tags, rate: sc.rateHz.toFixed(1), period: ch.pollIntervalMs }) : `${tagsByChannel.get(ch.id)?.length ?? 0} ${lang === 'zh' ? '位号' : 'tags'}`}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${loadCls}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 tabular-nums w-16 text-right">
                    {latency ?? t('dash.channels.load', { p: Math.round(ratio * 100) })}
                  </span>
                </div>
                {!ch.enabled && <div className="mt-1 text-[10px] text-slate-400 font-semibold">{t('dash.channels.disabled')}</div>}
              </button>
            );
          })}
          {channels.length === 0 && (config === null ? (
            <>
              {Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} className="h-[104px]" />)}
            </>
          ) : (
            <div className="col-span-full text-xs text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-4">
              {wsStatus === 'offline' ? t('dash.grid.offline') : t('dash.grid.connecting')}
            </div>
          ))}
        </div>
      </div>

      {/* ===== C 区：关键工况趋势（C1）+ 告警速览（C2） ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 min-w-0">
          <TrendPanel channels={enabledChannels} allTags={allTags} liveValues={liveValues} onNavigate={onNavigate} />
        </div>
        <div className="lg:col-span-4 min-w-0">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
              <h3 className="font-semibold text-slate-800 flex items-center">
                <Bell className={`w-5 h-5 mr-2 ${activeAlarms.length > 0 ? 'text-rose-500' : 'text-slate-500'}`} />
                {t('dash.alarms.title')}
                {activeAlarms.length > 0 && (
                  <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 animate-pulse">
                    {t('dash.alarms.activeBadge', { n: activeAlarms.length })}
                  </span>
                )}
              </h3>
              <button
                onClick={() => onNavigate?.('alarms')}
                className="flex items-center gap-0.5 text-xs font-bold text-indigo-600 hover:text-indigo-700"
              >
                {t('dash.alarms.viewAll')} <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
          {/* 活动告警 */}
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('dash.alarms.activeCol')}</div>
            {activeAlarms.length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
                {t('dash.alarms.emptyActive')}
              </div>
            ) : (
              <div className="space-y-2">
                {activeAlarms.map((a) => (
                  <div key={a.id} className="px-3 py-2.5 rounded-lg bg-rose-50 border border-rose-200 flex items-center justify-between animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-rose-800 truncate flex items-center gap-1">
                        {a.kind === 'high' ? <ArrowUp className="w-3.5 h-3.5 shrink-0" /> : a.kind === 'low' ? <ArrowDown className="w-3.5 h-3.5 shrink-0 text-blue-500" /> : <Activity className="w-3.5 h-3.5 shrink-0 text-violet-500" />}
                        {a.tagName} <span className="font-mono">{alarmKindSymbol(a.kind)} {a.threshold}</span>
                        {a.ack && <span className="ml-1.5 text-[10px] text-slate-500 font-normal">{t('dash.alarms.ackedBy', { user: a.ack.user })}</span>}
                      </div>
                      <div className="text-[10px] text-rose-500 font-mono mt-0.5">
                        {t('dash.alarms.currentValue', { value: a.value.toFixed(2), time: new Date(a.ts).toLocaleTimeString() })}
                        <span className="ml-2 text-rose-400">{t('dash.alarms.duration', { d: fmtDuration(now - a.ts, lang) })}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!a.ack && (
                        <button
                          onClick={() => void ackAlarm(a.id).then(loadAlarms).catch(() => {})}
                          className="px-2 py-1 text-[11px] font-bold text-rose-700 bg-white border border-rose-300 rounded-md hover:bg-rose-100 transition-colors"
                        >
                          {t('dash.alarms.ack')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 最近事件 */}
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">{t('dash.alarms.recentEvents')}</div>
            {(alarms?.history ?? []).length === 0 ? (
              <div className="px-3 py-4 text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
                {t('dash.alarms.noEvents')}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {(alarms?.history ?? []).slice(0, 8).map((a) => (
                  <div key={a.id} className="px-3 py-1.5 rounded-md bg-slate-50 border border-slate-100 flex items-center justify-between text-[11px]">
                    <span className={`font-bold flex items-center gap-1 ${a.state === 'Active' ? 'text-rose-600' : 'text-slate-500'}`}>
                      {a.state === 'Active'
                        ? <AlertTriangle className="w-3 h-3 shrink-0" />
                        : <CheckCircle className="w-3 h-3 shrink-0 text-emerald-500" />}
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
        </div>
      </div>

      {/* ===== D 区：位号总览（按通道分组，真实位号 + WS 实时值） ===== */}
      <div className="space-y-3">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">{t('dash.grid.title')}</div>
        {channels.map((ch) => {
          const chTags = tagsByChannel.get(ch.id) ?? [];
          const st = channelState(ch.id, wsChannels, sched ?? undefined);
          const latency = parseLatency(wsChannels[ch.id]?.detail);
          const online = st === 'online';
          return (
            <div key={ch.id} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <button
                onClick={() => onNavigate?.('devices')}
                className="w-full px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center gap-2 text-left hover:bg-slate-100 transition-colors"
              >
                <span className={`w-1 h-4 rounded-full ${protocolBorderCls(ch.protocol)} border-l-2`} />
                <span className="text-sm font-bold text-slate-800">{ch.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${protocolChipCls(ch.protocol)}`}>
                  {protocolShortName(ch.protocol)}
                </span>
                <span className={`text-[11px] font-semibold ${online ? 'text-emerald-600' : 'text-slate-400'}`}>
                  {online ? t('dash.channels.online') : ch.enabled ? t('dash.channels.offline') : t('dash.channels.disabled')}
                </span>
                <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                  {latency ? t('dash.grid.channelMeta', { ms: ch.pollIntervalMs, lat: latency }) : `${ch.pollIntervalMs}ms`}
                </span>
                <span className="text-[11px] text-slate-400">{t('dev.tagCount', { n: chTags.length })}</span>
                <ChevronRight className="w-4 h-4 text-slate-300 ml-auto" />
              </button>
              {chTags.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-400">{t('dash.grid.noTags')}</div>
              ) : (
                <div className="p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
                  {chTags.map((tag) => {
                    const live = liveValues[tag.id];
                    const isBad = live?.quality === 'Bad';
                    const suffix = tag.name.includes('.') ? tag.name.split('.').slice(1).join('.') : tag.name;
                    return (
                      <button
                        key={tag.id}
                        onClick={() => onNavigate?.('diagnostics')}
                        className={`text-left p-2.5 rounded-lg border flex flex-col ${isBad ? 'border-rose-200 bg-rose-50/60' : 'border-slate-100 bg-slate-50'} ${!ch.enabled ? 'opacity-50' : ''} hover:border-indigo-200 transition-colors`}
                        title={tag.description || tag.name}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-slate-600 truncate">{suffix}</span>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? (isBad ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'}`}
                            title={live ? live.quality : t('dash.grid.waitLive')}
                          />
                        </div>
                        <div className={`mt-1 text-lg font-bold tabular-nums flex items-baseline gap-1 ${live ? (isBad ? 'text-slate-400' : 'text-slate-900') : 'text-slate-300'}`}>
                          <span className="truncate">{live ? formatValue(live.value) : '—'}</span>
                          {tag.unit && <span className="text-[11px] text-slate-400 font-normal">{tag.unit}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {channels.length === 0 && (config === null ? (
          Array.from({ length: 2 }, (_, i) => <SkeletonCard key={i} className="h-24" />)
        ) : (
          <div className="text-xs text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-4">
            {t('dash.grid.connecting')}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 迷你走势（吞吐）：纯 SVG polyline，无图表库 */
function Sparkline({ values }: { values: number[] }): React.JSX.Element {
  const w = 120;
  const h = 26;
  if (values.length < 2) {
    return <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[26px] mt-1" preserveAspectRatio="none"><line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="#e2e8f0" strokeWidth="1.5" /></svg>;
  }
  const max = Math.max(...values, 0.1);
  const min = Math.min(...values, 0);
  const span = Math.max(0.01, max - min);
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[26px] mt-1" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ===== C1：关键工况趋势（TDengine 真聚合 + 可置顶位号） =====

const PIN_KEY = 'fb_dash_pinned_tags';
const MAX_PIN = 6;
const TREND_WINDOW_MS = 30 * 60_000;
const TREND_INTERVAL_SEC = 30;
const ANALOG_TYPES = new Set(['Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double']);

/** C1 面板：置顶位号 30min 走势（/api/history 30s 粒度），现值取 WS 实时 */
function TrendPanel({
  channels, allTags, liveValues, onNavigate,
}: {
  channels: GatewayChannel[];
  allTags: GatewayTag[];
  liveValues: Record<string, { value: number | string | boolean; quality?: string; ts: number }>;
  onNavigate?: (v: DashboardNavTarget) => void;
}): React.JSX.Element {
  const { t, lang } = useI18n();
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PIN_KEY);
      if (raw !== null) {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').slice(0, MAX_PIN);
      }
    } catch { /* 损坏则走默认 */ }
    return [];
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [series, setSeries] = useState<Record<string, number[]>>({});
  const [storageOff, setStorageOff] = useState(false);
  const pinnedKey = pinned.join(',');

  // 首次进入（从未设置过置顶）→ 每个已启用通道取第一个模拟量位号
  useEffect(() => {
    if (localStorage.getItem(PIN_KEY) !== null) return;
    if (channels.length === 0 || allTags.length === 0) return;
    const def: string[] = [];
    for (const ch of channels) {
      const tag = allTags.find((tg) => tg.channelId === ch.id && ANALOG_TYPES.has(tg.dataType));
      if (tag) def.push(tag.id);
    }
    const picked = def.slice(0, MAX_PIN);
    setPinned(picked);
    localStorage.setItem(PIN_KEY, JSON.stringify(picked));
  }, [channels, allTags]);

  const loadTrend = (): void => {
    if (pinned.length === 0) { setSeries({}); return; }
    const end = Date.now();
    fetchHistory(pinned, end - TREND_WINDOW_MS, end, TREND_INTERVAL_SEC)
      .then((res) => {
        const m: Record<string, number[]> = {};
        for (const s of res.series) m[s.tagId] = (s.points ?? []).map((p) => p.avg);
        setSeries(m);
        setStorageOff(false);
      })
      .catch(() => setStorageOff(true));
  };

  useEffect(() => {
    loadTrend();
    const timer = setInterval(loadTrend, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedKey]);

  const tagById = useMemo(() => new Map(allTags.map((tg) => [tg.id, tg])), [allTags]);
  const chName = useMemo(() => new Map(channels.map((c) => [c.id, c.name])), [channels]);
  const analogTags = useMemo(
    () => allTags.filter((tg) => ANALOG_TYPES.has(tg.dataType) && channels.some((c) => c.id === tg.channelId)),
    [allTags, channels],
  );

  const togglePin = (id: string): void => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < MAX_PIN ? [...prev, id] : prev;
      localStorage.setItem(PIN_KEY, JSON.stringify(next));
      return next;
    });
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h3 className="font-semibold text-slate-800 flex items-center">
          <TrendingUp className="w-5 h-5 mr-2 text-indigo-500" />
          {t('dash.trend.title')}
          <span className="ml-2 text-[10px] font-mono text-slate-400">{t('dash.trend.window')}</span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs font-bold rounded-md border transition-colors ${
              pickerOpen ? 'text-indigo-700 bg-indigo-50 border-indigo-200' : 'text-slate-500 bg-white border-slate-200 hover:text-indigo-600'
            }`}
          >
            {pickerOpen ? <X className="w-3.5 h-3.5" /> : <SlidersHorizontal className="w-3.5 h-3.5" />}
            {t('dash.trend.edit')}
          </button>
          <button
            onClick={() => onNavigate?.('historian')}
            className="flex items-center gap-0.5 text-xs font-bold text-indigo-600 hover:text-indigo-700"
          >
            {t('dash.trend.custom')} <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {pickerOpen && (
        <div className="px-5 py-3 border-b border-slate-100 bg-indigo-50/40 animate-in fade-in slide-in-from-top-1">
          <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
            {t('dash.trend.pickTitle', { n: MAX_PIN })}
          </div>
          {analogTags.length === 0 ? (
            <div className="text-xs text-slate-400 py-1">{t('dash.trend.noAnalog')}</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 max-h-44 overflow-y-auto">
              {analogTags.map((tag) => {
                const active = pinned.includes(tag.id);
                const full = !active && pinned.length >= MAX_PIN;
                return (
                  <button
                    key={tag.id}
                    onClick={() => { if (!full) togglePin(tag.id); }}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] text-left transition-colors ${
                      active ? 'bg-indigo-600 text-white border-indigo-600' : full ? 'bg-white text-slate-300 border-slate-100 cursor-not-allowed' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                    }`}
                    title={`${chName.get(tag.channelId) ?? ''} · ${tag.name}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? 'bg-white' : 'bg-slate-300'}`} />
                    <span className="truncate">{tag.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="p-4 space-y-2">
        {storageOff ? (
          <div className="px-4 py-6 text-center text-xs text-slate-500 bg-slate-50 rounded-lg border border-slate-100">
            <Database className="w-5 h-5 mx-auto mb-2 text-slate-300" />
            {t('dash.trend.storageHint')}
          </div>
        ) : pinned.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-slate-400 bg-slate-50 rounded-lg border border-slate-100">
            {t('dash.trend.empty')}
          </div>
        ) : (
          pinned.map((id) => {
            const tag = tagById.get(id);
            if (!tag) return null;
            const vals = series[id] ?? [];
            const live = liveValues[id];
            const isBad = live?.quality === 'Bad';
            return (
              <button
                key={id}
                onClick={() => onNavigate?.('historian')}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-100 bg-slate-50 hover:border-indigo-200 transition-colors"
                title={vals.length > 0 ? `${tag.name} · ${Math.min(...vals).toFixed(2)} ~ ${Math.max(...vals).toFixed(2)} ${tag.unit ?? ''}` : tag.name}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${live ? (isBad ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'}`} />
                <div className="w-36 md:w-44 min-w-0 text-left shrink-0">
                  <div className="text-xs font-bold text-slate-700 truncate">{tag.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{chName.get(tag.channelId) ?? tag.channelId}</div>
                </div>
                <TrendSpark values={vals} />
                <div className="w-24 text-right shrink-0">
                  <span className={`text-base font-bold tabular-nums ${live ? (isBad ? 'text-slate-400' : 'text-slate-900') : 'text-slate-300'}`}>
                    {live ? formatValue(live.value) : '—'}
                  </span>
                  {tag.unit && <span className="text-[10px] text-slate-400 ml-0.5">{tag.unit}</span>}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** C1 行内走势：面积填充 + 描边，min-max 归一化 */
function TrendSpark({ values }: { values: number[] }): React.JSX.Element {
  const w = 200;
  const h = 30;
  if (values.length < 2) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="flex-1 h-[30px]" preserveAspectRatio="none">
        <line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="#e2e8f0" strokeWidth="1.5" />
      </svg>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(0.0001, max - min);
  const x = (i: number): number => (i / (values.length - 1)) * w;
  const y = (v: number): number => h - 2 - ((v - min) / span) * (h - 4);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="flex-1 h-[30px] min-w-0" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dashTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="url(#dashTrendFill)" />
      <polyline points={line} fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** P4：加载骨架卡 */
function SkeletonCard({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={`bg-white rounded-xl border border-slate-100 p-3 ${className ?? ''}`} aria-hidden>
      <div className="animate-pulse space-y-2">
        <div className="h-3 w-1/2 bg-slate-200 rounded" />
        <div className="h-5 w-2/3 bg-slate-200 rounded" />
        <div className="h-1.5 w-full bg-slate-100 rounded" />
      </div>
    </div>
  );
}
