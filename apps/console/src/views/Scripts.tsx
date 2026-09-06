import React, { useState } from 'react';
import { Play, Save, Plus, Settings, Zap } from 'lucide-react';

export default function Scripts() {
  const [triggerType, setTriggerType] = useState('tag');
  const [scriptEnabled, setScriptEnabled] = useState(true);

  const code = `temperature = Read[R0021.Temperature]
pressure = Read[R0021.Pressure]

if temperature > 38.0:
    Write[R0021.alm1, True]
    print(f"High temperature alert: {temperature}")
else:
    Write[R0021.alm1, False]
`;

  return (
    <div className="space-y-6 flex flex-col h-[calc(100vh-140px)]">
      <div className="flex justify-between items-center shrink-0">
        <p className="text-sm text-slate-500">Edit and manage Python scripts for custom logic.</p>
        <div className="flex items-center space-x-3">
          <button className="flex items-center px-4 py-2 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded-md hover:bg-slate-50 transition-colors">
            <Save className="w-4 h-4 mr-2" />
            Save
          </button>
          <button className="flex items-center px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 transition-colors shadow-sm">
            <Play className="w-4 h-4 mr-2" />
            Run Script
          </button>
        </div>
      </div>

      <div className="flex flex-1 gap-6 min-h-0">
        {/* Scripts List (Left) */}
        <div className="w-64 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
            <h3 className="font-semibold text-slate-800 text-sm uppercase tracking-wider text-xs">Scripts</h3>
            <button className="p-1 hover:bg-slate-200 rounded text-indigo-600 transition-colors">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <ul className="overflow-auto py-2">
            <li>
              <button className="w-full text-left px-4 py-2 bg-indigo-50 text-indigo-700 border-l-2 border-indigo-600 text-sm font-medium">
                Temperature Monitor
              </button>
            </li>
            <li>
              <button className="w-full text-left px-4 py-2 hover:bg-slate-50 text-slate-600 border-l-2 border-transparent text-sm font-medium transition-colors">
                Data Logger
              </button>
            </li>
          </ul>
        </div>
        
        {/* Code Editor (Center) */}
        <div className="flex-1 bg-slate-900 rounded-xl shadow-inner border border-slate-700 flex flex-col overflow-hidden min-w-0">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center shrink-0">
            <div className="flex space-x-1.5 mr-4">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-amber-500"></div>
              <div className="w-3 h-3 rounded-full bg-emerald-500"></div>
            </div>
            <span className="text-xs text-slate-400 font-mono">monitor.py</span>
          </div>
          <div className="flex-1 p-4 overflow-auto">
            <pre className="font-mono text-sm text-slate-300">
              <code>
{code.split('\n').map((line, i) => (
  <div key={i} className="flex">
    <span className="w-8 text-slate-600 select-none text-right pr-4 shrink-0">{i + 1}</span>
    <span className="whitespace-pre">{line}</span>
  </div>
))}
              </code>
            </pre>
          </div>
        </div>

        {/* Script Settings (Right) */}
        <div className="w-80 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col shrink-0 overflow-hidden">
          <div className="px-4 py-4 border-b border-slate-200 bg-slate-50 flex items-center gap-2 shrink-0">
            <Settings className="w-4 h-4 text-indigo-600" />
            <h3 className="font-semibold text-slate-800 text-sm">Script Settings</h3>
          </div>
          
          <div className="p-5 space-y-6 overflow-y-auto">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Script Name</label>
                <input type="text" defaultValue="Temperature Monitor" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium text-slate-800" />
              </div>
              
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Description</label>
                <textarea rows={2} defaultValue="Monitors reactor temp and triggers high alarm." className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none text-slate-600"></textarea>
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="text-sm font-semibold text-slate-700">Enable Script</label>
                <button
                  type="button"
                  onClick={() => setScriptEnabled(!scriptEnabled)}
                  className={`${scriptEnabled ? 'bg-indigo-600' : 'bg-slate-200'} relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2`}
                >
                  <span className={`${scriptEnabled ? 'translate-x-4' : 'translate-x-0'} pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`} />
                </button>
              </div>
            </div>

            <div className="pt-5 border-t border-slate-100">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-amber-500" />
                <h4 className="font-semibold text-slate-800 text-sm">Execution Trigger</h4>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Trigger Type</label>
                  <select 
                    value={triggerType}
                    onChange={(e) => setTriggerType(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium text-slate-700"
                  >
                    <option value="tag">Bool Tag (Rising Edge)</option>
                    <option value="expression">Expression (False to True)</option>
                  </select>
                </div>

                {triggerType === 'tag' ? (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">Trigger Tag</label>
                    <input type="text" defaultValue="R0021.alm1" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-indigo-700" placeholder="e.g. Channel.TagName" />
                    <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                      Script executes only when this bool tag transitions from False to True.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">Expression</label>
                    <textarea rows={3} defaultValue="Read[R0021.Temperature] > 38.0" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none text-indigo-700" placeholder="e.g. Read[Channel.Tag] > 50"></textarea>
                    <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                      Script executes when expression dynamically evaluates from False to True.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
