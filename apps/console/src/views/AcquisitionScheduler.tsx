import React, { useEffect, useState } from 'react';
import { Activity, Timer } from 'lucide-react';
import { fetchScheduler, type SchedulerStats } from '../api';

/** 采集调度（PRD M3）：真实引擎指标 —— 每通道采样率/状态/错误与全局吞吐。 */

function barColor(ratio: number): string {
  if (ratio > 0.8) return 'bg-rose-500';
  if (ratio > 0.5) return 'bg-amber-400';
  return 'bg-indigo-500';
}

export default function AcquisitionScheduler() {
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = (): void => {
      fetchScheduler().then(setStats).catch((e) => setError(String(e)));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  const kpis = [
    { label: '采样总吞吐', value: `${stats?.rateHz ?? 0} /s` },
    { label: '在线通道', value: `${stats?.onlineChannels ?? 0} / ${stats?.channels.length ?? 0}` },
    { label: '累计采样', value: stats ? stats.totalSamples.toLocaleString() : '—' },
    { label: '运行时长', value: stats ? `${Math.floor(stats.uptimeSec / 60)} 分` : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">采集调度</h2>
          <p className="text-sm text-slate-500 mt-1">引擎实时指标：每通道采样率、周期利用率与错误（3 秒自动刷新）。</p>
        </div>
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-600">
          <span className={`w-2 h-2 rounded-full ${stats ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
          {stats ? 'Scheduler Active' : '加载中…'}
        </span>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">指标加载失败：{error}</div>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
            <Timer className="w-4 h-4 text-indigo-600" /> 通道采集负载（周期利用率）
          </h3>
          <div className="flex items-center gap-4 text-[11px] font-medium text-slate-500">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-indigo-500" /> 顺畅 (&lt;50%)</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-amber-400" /> 偏高 (50-80%)</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-rose-500" /> 饱和 (&gt;80%)</span>
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
                    {c.rateHz} samples/s · 周期 {c.pollIntervalMs}ms · {c.tags} 位号
                    {c.lastError ? <span className="text-rose-500 ml-2">{c.lastError.slice(0, 40)}</span> : null}
                  </span>
                </div>
                <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${barColor(ratio)}`} style={{ width: `${Math.max(2, ratio * 100)}%` }} />
                </div>
              </div>
            );
          })}
          {(!stats || stats.channels.length === 0) && (
            <div className="text-xs text-slate-400 py-6 text-center">暂无通道数据。</div>
          )}
        </div>
      </div>
    </div>
  );
}
