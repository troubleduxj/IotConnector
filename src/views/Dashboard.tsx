import React from 'react';
import { mockTags } from '../data';
import { Server, Activity, AlertTriangle, CheckCircle } from 'lucide-react';

export default function Dashboard() {
  const activeTags = mockTags.length;
  const goodQualityTags = mockTags.filter(t => t.quality === 'Good').length;
  const warnings = mockTags.filter(t => t.quality !== 'Good').length;

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
          <div className="text-3xl font-bold text-amber-500">{warnings > 9 ? warnings : `0${warnings}`}</div>
          <div className="text-amber-600/80 text-xs mt-2">Requires review</div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
          <h3 className="font-semibold text-slate-800 flex items-center">
            <Activity className="w-5 h-5 mr-2 text-slate-500" />
            Live Equipment Status
          </h3>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {mockTags.map(tag => (
              <div key={tag.id} className="p-4 rounded-lg border border-slate-100 bg-slate-50 flex flex-col">
                <span className="text-xs font-semibold text-slate-400 mb-1">{tag.channel}</span>
                <span className="font-medium text-slate-700 truncate" title={tag.name}>{tag.name.split('.')[1] || tag.name}</span>
                <div className="mt-2 text-2xl font-bold text-slate-900 flex items-baseline">
                  {typeof tag.value === 'number' ? tag.value.toFixed(2) : String(tag.value)}
                  {tag.type === 'number' && tag.name.includes('Temperature') && <span className="ml-1 text-sm text-slate-500 font-normal">°C</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
