import React, { useState } from 'react';
import { Timer, Cpu, Network, Combine, Settings2, Activity, PlayCircle, BarChart3, ArrowRight } from 'lucide-react';

const timeSlices = [
  { id: 'T0', time: '0ms', load: 45, count: 12 },
  { id: 'T1', time: '100ms', load: 20, count: 5 },
  { id: 'T2', time: '200ms', load: 65, count: 18 },
  { id: 'T3', time: '300ms', load: 30, count: 8 },
  { id: 'T4', time: '400ms', load: 85, count: 24 }, // Peak
  { id: 'T5', time: '500ms', load: 15, count: 4 },
  { id: 'T6', time: '600ms', load: 40, count: 10 },
  { id: 'T7', time: '700ms', load: 55, count: 15 },
  { id: 'T8', time: '800ms', load: 25, count: 6 },
  { id: 'T9', time: '900ms', load: 10, count: 3 },
];

export default function AcquisitionScheduler() {
  const [dynamicSlicing, setDynamicSlicing] = useState(true);

  const Toggle = ({ enabled, onChange }: { enabled: boolean, onChange: (val: boolean) => void }) => (
    <button
      type="button"
      className={`${
        enabled ? 'bg-indigo-600' : 'bg-slate-200'
      } relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2`}
      onClick={() => onChange(!enabled)}
    >
      <span
        className={`${
          enabled ? 'translate-x-4' : 'translate-x-0'
        } pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
      />
    </button>
  );

  return (
    <div className="space-y-6 pb-12">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Acquisition Scheduler</h2>
          <p className="text-sm text-slate-500 mt-1">Time-slice allocation and protocol-level read plan aggregation engine.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-600 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Scheduler Active
          </span>
          <button className="flex items-center px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded-md hover:bg-slate-50 transition-colors shadow-sm ml-4">
            <Settings2 className="w-4 h-4 mr-2" />
            Global Settings
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg"><Combine className="w-6 h-6" /></div>
          <div>
            <div className="text-2xl font-bold text-slate-800">84%</div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">Read Plan Compression</div>
          </div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg"><Activity className="w-6 h-6" /></div>
          <div>
            <div className="text-2xl font-bold text-slate-800">10</div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">Active Time Slices</div>
          </div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-lg"><Network className="w-6 h-6" /></div>
          <div>
            <div className="text-2xl font-bold text-slate-800">32 / 16</div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">IO / CPU Workers</div>
          </div>
        </div>
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg"><Timer className="w-6 h-6" /></div>
          <div>
            <div className="text-2xl font-bold text-slate-800">42ms</div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-0.5">Avg Cycle Latency</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Time Slice Load Balancer */}
        <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg"><BarChart3 className="w-5 h-5" /></div>
              <div>
                <h3 className="font-bold text-slate-800">Time Slice Load Distribution</h3>
                <p className="text-[11px] text-slate-500 font-medium">1000ms major cycle divided into 100ms buckets</p>
              </div>
            </div>
            <div className="flex items-center gap-2 bg-white px-3 py-1.5 border border-slate-200 rounded-md shadow-sm">
              <span className="text-xs font-semibold text-slate-600">Dynamic Rebalancing</span>
              <Toggle enabled={dynamicSlicing} onChange={setDynamicSlicing} />
            </div>
          </div>
          
          <div className="p-8 flex-1 flex flex-col justify-end">
            <div className="flex items-end justify-between gap-2 h-48 mb-4">
              {timeSlices.map((slice) => (
                <div key={slice.id} className="flex-1 flex flex-col items-center gap-2 group relative">
                  {/* Tooltip */}
                  <div className="absolute -top-12 bg-slate-800 text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                    {slice.count} payloads ({slice.load}% load)
                  </div>
                  {/* Bar */}
                  <div className="w-full bg-slate-100 rounded-t-md overflow-hidden relative flex flex-col justify-end h-full">
                    <div 
                      className={`w-full rounded-t-md transition-all duration-500 ${
                        slice.load > 80 ? 'bg-rose-500' : slice.load > 50 ? 'bg-amber-400' : 'bg-indigo-500'
                      }`}
                      style={{ height: `${slice.load}%` }}
                    ></div>
                  </div>
                  {/* Label */}
                  <div className="text-xs font-bold text-slate-600 text-center">{slice.id}</div>
                  <div className="text-[10px] text-slate-400 font-mono">{slice.time}</div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-center gap-6 pt-4 border-t border-slate-100">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <span className="w-3 h-3 rounded bg-indigo-500"></span> Optimal (&lt;50%)
              </div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <span className="w-3 h-3 rounded bg-amber-400"></span> Moderate (50-80%)
              </div>
              <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
                <span className="w-3 h-3 rounded bg-rose-500"></span> Heavy (&gt;80%)
              </div>
            </div>
          </div>
        </div>

        {/* Protocol Aggregation Rules */}
        <div className="space-y-6">
          
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50">
              <div className="p-1.5 bg-emerald-100 text-emerald-600 rounded-md"><Combine className="w-4 h-4" /></div>
              <h3 className="font-bold text-slate-800 text-sm">Protocol Read Plan Tuning</h3>
            </div>
            <div className="p-5 space-y-5">
              <p className="text-xs text-slate-500 leading-relaxed -mt-1">
                The dispatcher automatically merges contiguous addresses into single bulk read requests to minimize network overhead.
              </p>
              
              <div>
                <div className="flex justify-between items-end mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">Modbus Max PDU Size</label>
                  <span className="text-[10px] font-mono text-slate-400">120 Registers</span>
                </div>
                <input type="range" min="10" max="120" defaultValue="100" className="w-full accent-indigo-600" />
              </div>
              
              <div>
                <div className="flex justify-between items-end mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">Siemens S7 Max PDU</label>
                  <span className="text-[10px] font-mono text-slate-400">480 Bytes</span>
                </div>
                <input type="range" min="64" max="960" step="32" defaultValue="480" className="w-full accent-cyan-600" />
              </div>

              <div>
                <div className="flex justify-between items-end mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">Rockwell CIP Multiple Service Packet</label>
                  <span className="text-[10px] font-mono text-slate-400">500 Bytes (Class 3)</span>
                </div>
                <input type="range" min="200" max="1984" step="64" defaultValue="500" className="w-full accent-rose-600" />
              </div>

              <div>
                <div className="flex justify-between items-end mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">Mitsubishi MC 3E Bulk Words</label>
                  <span className="text-[10px] font-mono text-slate-400">960 Words</span>
                </div>
                <input type="range" min="64" max="960" step="32" defaultValue="960" className="w-full accent-red-600" />
              </div>

              <div className="pt-4 border-t border-slate-100">
                <h4 className="text-xs font-bold text-slate-800 mb-3">Live Aggregation Example</h4>
                <div className="flex items-center justify-between bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200 text-slate-600">40001 (Speed)</span>
                    <span className="text-[10px] font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200 text-slate-600">40002 (Status)</span>
                    <span className="text-[10px] font-mono bg-white px-1.5 py-0.5 rounded border border-slate-200 text-slate-600">40003 (Temp)</span>
                  </div>
                  <ArrowRight className="w-4 h-4 text-indigo-400" />
                  <div className="bg-indigo-50 border border-indigo-200 px-3 py-2 rounded text-center">
                    <div className="text-xs font-bold text-indigo-700">1 Bulk Frame</div>
                    <div className="text-[10px] text-indigo-500 font-mono mt-0.5">Read [40001, len=3]</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50">
              <div className="p-1.5 bg-blue-100 text-blue-600 rounded-md"><Cpu className="w-4 h-4" /></div>
              <h3 className="font-bold text-slate-800 text-sm">Thread Pool Decoupling</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-500 leading-relaxed -mt-1 mb-2">
                Separate thread pools for I/O bounds (Collection) and CPU bounds (Processing).
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Collection (Network IO)</label>
                  <input type="number" defaultValue={32} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Processing (Data Calc)</label>
                  <input type="number" defaultValue={16} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
