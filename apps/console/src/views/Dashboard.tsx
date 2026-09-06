import React, { useEffect } from 'react';
import { mockTags } from '../data';
import { useRuntime } from '../store/runtime';
import { Server, Activity, AlertTriangle, CheckCircle } from 'lucide-react';

/** 按数据类型格式化：整数不带小数，浮点 2 位（UI 规范 §3.3） */
function formatValue(v: number | string | boolean): string {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return String(v);
}

export default function Dashboard() {
  const { liveValues, channels, status, lastUpdateTs, connect } = useRuntime();
  useEffect(() => {
    connect();
  }, [connect]);

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
          <div className={`text-3xl font-bold ${warnings > 0 ? 'text-amber-500' : ''}`}>{warnings}</div>
          <div className="text-amber-600/80 text-xs mt-2">Requires review</div>
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
              const channelState = channels[mockChannelId(tag.channel)]?.state;
              return (
                <div key={tag.id} className="p-4 rounded-lg border border-slate-100 bg-slate-50 flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-slate-400">{tag.channel}</span>
                    {live && (
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isBad ? 'bg-rose-500' : channelState === 'online' ? 'bg-green-500' : 'bg-amber-400'
                        }`}
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

/** mock channel 名 → 网关通道 id（PoC 种子：sim-01 / mb-01） */
function mockChannelId(channelName: string): string {
  if (channelName === 'R0021_S7_1500') return 'sim-01';
  if (channelName === 'R0022_Modbus_Drive') return 'mb-01';
  return channelName;
}
