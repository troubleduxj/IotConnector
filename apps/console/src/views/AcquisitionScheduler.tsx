import React, { useEffect, useState } from 'react';
import { Activity, Timer, RefreshCcw, Loader2 } from 'lucide-react';
import { fetchScheduler, rebalanceScheduler, type SchedulerStats } from '../api';
import { useI18n } from '../i18n';
import { toast } from '../components/Toast';

/** 采集调度（PRD M3）：真实引擎指标 —— 每通道采样率/通讯统计/周期延迟与全局吞吐；手动重均衡（FR-M3-03）。 */

function barColor(ratio: number): string {
  if (ratio > 0.8) return 'bg-rose-500';
  if (ratio > 0.5) return 'bg-amber-400';
  return 'bg-indigo-500';
}

export default function AcquisitionScheduler() {
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebalancing, setRebalancing] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    const load = (): void => {
      fetchScheduler().then(setStats).catch((e) => setError(String(e)));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const doRebalance = async (): Promise<void> => {
    setRebalancing(true);
    try {
      const r = await rebalanceScheduler();
      toast(t('sched.rebalanceDone', { n: r.reloaded }));
      const fresh = await fetchScheduler();
      setStats(fresh);
    } catch {
      toast(t('sched.rebalanceFail'), false);
    } finally {
      setRebalancing(false);
    }
  };

  const kpis = [
    { label: t('sched.kpiThroughput'), value: `${stats?.rateHz ?? 0} /s` },
    { label: t('sched.kpiOnline'), value: `${stats?.onlineChannels ?? 0} / ${stats?.channels.length ?? 0}` },
    { label: t('sched.kpiSamples'), value: stats ? stats.totalSamples.toLocaleString() : '—' },
    { label: t('sched.kpiUptime'), value: stats ? t('sched.minutes', { n: Math.floor(stats.uptimeSec / 60) }) : '—' },
    { label: t('sched.kpiLatency'), value: stats?.avgCycleMs !== undefined ? `${stats.avgCycleMs} ms` : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{t('sched.title')}</h2>
          <p className="text-sm text-slate-500 mt-1">{t('sched.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void doRebalance()}
            disabled={rebalancing}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rebalancing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
            {t('sched.rebalance')}
          </button>
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-600">
            <span className={`w-2 h-2 rounded-full ${stats ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
            {stats ? 'Scheduler Active' : t('sched.loading')}
          </span>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">{t('sched.loadError', { error })}</div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg"><Activity className="w-6 h-6" /></div>
            <div>
              <div className="text-2xl font-bold text-slate-800">{kpi.value}</div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">{kpi.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 通道利用率 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
          <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <Timer className="w-4 h-4 text-indigo-600" /> {t('sched.channelLoad')}
          </h3>
          <div className="flex items-center gap-4 text-[11px] font-medium text-slate-500">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-indigo-500" /> {t('sched.legendOk')}</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-amber-400" /> {t('sched.legendHigh')}</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-rose-500" /> {t('sched.legendSaturated')}</span>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {(stats?.channels ?? []).map((c) => {
            // 周期利用率 ≈ 实测单次往返 RTT / 采集周期（RTT 由驱动状态 detail 汇报，这里用采样率/预期采样率近似）
            // 预期采样率 = 每周期每位号 1 次 → 预期 Hz = 位号数 / 周期
            const expectedHz = (tags: number) => tags / Math.max(0.2, c.pollIntervalMs / 1000);
            const ratio = c.enabled ? Math.min(1, c.rateHz / Math.max(0.01, expectedHz(c.tags))) : 0;
            return (
              <div key={c.id}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-700 font-mono">{c.name}</span>
                    <span className="text-slate-400">{c.protocol}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      c.state === 'online' ? 'bg-emerald-100 text-emerald-700' : c.state === 'connecting' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
                    }`}>
                      {c.state}
                    </span>
                  </div>
                  <span className="font-mono text-slate-500">
                    {t('sched.channelStats', { rate: c.rateHz, period: c.pollIntervalMs, tags: c.tags })}
                    {c.lastError ? <span className="text-rose-500 ml-2">{c.lastError.slice(0, 40)}</span> : null}
                  </span>
                </div>
                {/* FR-M2-07 帧级通讯统计：TX/RX/错误 + 超时率 + 最近通讯/周期延迟 */}
                <div className="flex items-center gap-3 text-[11px] font-medium text-slate-500 mb-1">
                  <span className="font-mono">TX {c.tx}</span>
                  <span className="font-mono">RX {c.rx}</span>
                  <span className={`font-mono ${c.err > 0 ? 'text-rose-600 font-bold' : ''}`}>
                    {t('sched.errCount', { n: c.err })}
                  </span>
                  {c.timeoutRate > 0 && (
                    <span className="font-mono text-amber-600" title={t('sched.errCount', { n: c.err })}>
                      {t('sched.timeoutRate', { pct: (c.timeoutRate * 100).toFixed(1) })}
                    </span>
                  )}
                  <span className="text-slate-400">
                    {c.lastCommAt ? t('sched.lastComm', { time: new Date(c.lastCommAt).toLocaleTimeString() }) : t('sched.noComm')}
                  </span>
                  {c.avgCycleMs !== undefined && <span className="font-mono text-indigo-600">{c.avgCycleMs} ms/轮</span>}
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${barColor(ratio)}`} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
                </div>
              </div>
            );
          })}
          {(!stats || stats.channels.length === 0) && (
            <div className="text-xs text-slate-400 py-6 text-center">{t('sched.noChannels')}</div>
          )}
        </div>
      </div>
    </div>
  );
}
