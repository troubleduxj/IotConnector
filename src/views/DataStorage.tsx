import React, { useState } from 'react';
import { Database, Plus, Save, Clock, Zap, TableProperties, Settings2, Trash2, Code2 } from 'lucide-react';

interface ColumnMapping {
  id: string;
  dbColumn: string;
  mappedTag: string;
  dataType: string;
}

interface StorageTask {
  id: string;
  name: string;
  tableName: string;
  enabled: boolean;
  useTimeScale: boolean;
  triggerMode: 'Consecutive' | 'RisingEdge';
  cycleTime?: number;
  useExpression: boolean;
  triggerCondition: string;
  batchTag: string;
  mappings: ColumnMapping[];
}

const mockTasks: StorageTask[] = [
  {
    id: 't1',
    name: 'Reactor 1 Logging',
    tableName: 'ProcessData_R1',
    enabled: true,
    useTimeScale: false,
    triggerMode: 'Consecutive',
    cycleTime: 1000,
    useExpression: false,
    triggerCondition: 'R0021.EnableLogging',
    batchTag: 'R0021.pkg_BatchID',
    mappings: [
      { id: 'm1', dbColumn: 'Temperature', mappedTag: 'R0021.Temperature', dataType: 'Float' },
      { id: 'm2', dbColumn: 'pH_Value', mappedTag: 'R0021.pH', dataType: 'Float' },
      { id: 'm3', dbColumn: 'Alarm_Status', mappedTag: 'R0021.alm1', dataType: 'Bool' },
    ]
  },
  {
    id: 't2',
    name: 'Critical Event Capture',
    tableName: 'tb_au_pubHisvalues',
    enabled: true,
    useTimeScale: true,
    triggerMode: 'RisingEdge',
    useExpression: true,
    triggerCondition: 'Read[R0021.Pressure] > 2.5',
    batchTag: '',
    mappings: []
  }
];

export default function DataStorage({ dbType = 'TDengine' }: { dbType?: string }) {
  const [tasks, setTasks] = useState<StorageTask[]>(mockTasks);
  const [activeTaskId, setActiveTaskId] = useState<string>(mockTasks[0].id);

  const activeTask = tasks.find(t => t.id === activeTaskId) || tasks[0];
  const isTDengine = dbType === 'TDengine';

  const Toggle = ({ enabled, onChange }: { enabled: boolean, onChange: (val: boolean) => void }) => (
    <button
      type="button"
      className={`${
        enabled ? 'bg-indigo-600' : 'bg-slate-200'
      } relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2`}
      onClick={() => onChange(!enabled)}
    >
      <span
        aria-hidden="true"
        className={`${
          enabled ? 'translate-x-4' : 'translate-x-0'
        } pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
      />
    </button>
  );

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-auto lg:h-[calc(100vh-140px)]">
      {/* Task List Sidebar */}
      <div className="w-full lg:w-72 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col shrink-0">
        <div className="px-4 py-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
          <h3 className="font-semibold text-slate-800 text-sm uppercase tracking-wider">Storage Tasks</h3>
          <button className="p-1.5 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-md transition-colors" title="Add Task">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tasks.map(task => (
            <button
              key={task.id}
              onClick={() => setActiveTaskId(task.id)}
              className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all ${
                activeTaskId === task.id 
                  ? 'bg-indigo-50 border-indigo-200 shadow-sm' 
                  : 'bg-white border-transparent hover:border-slate-200 hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center gap-3 w-full">
                <div className={`w-2 h-2 rounded-full shrink-0 ${task.enabled ? 'bg-green-500' : 'bg-slate-300'}`}></div>
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-bold truncate ${activeTaskId === task.id ? 'text-indigo-900' : 'text-slate-700'}`}>
                    {task.name}
                  </div>
                  <div className="text-[11px] text-slate-500 font-medium mt-0.5 truncate flex items-center gap-1">
                    <Database className="w-3 h-3" />
                    {task.useTimeScale ? 'System Time Scale Table' : task.tableName}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Configuration Main Pane */}
      <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg">
              <TableProperties className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800 leading-tight">{activeTask.name}</h2>
              <p className="text-xs text-slate-500 font-medium">Configure acquisition rules and table mappings</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 mr-2">
              <span className="text-sm font-semibold text-slate-600">Enable Task</span>
              <Toggle enabled={activeTask.enabled} onChange={() => {}} />
            </div>
            <button className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-sm">
              <Save className="w-4 h-4" />
              Save Settings
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-8">
            
            {/* Storage Info */}
            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Storage Destination</h3>
              
              {isTDengine ? (
                <div className="bg-indigo-50/50 border border-indigo-100 rounded-lg p-4 flex items-start gap-4">
                  <div className="p-2 bg-indigo-100 text-indigo-600 rounded-md shrink-0">
                    <Database className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-indigo-900 text-sm mb-1.5">Super Table (STable) Architecture</h4>
                    <p className="text-xs text-indigo-700/80 leading-relaxed mb-4">
                      Because TDengine is selected as the underlying database, traditional fixed tables are disabled. The gateway automatically provisions a Super Table and creates dynamic sub-tables for each device.
                    </p>
                    <div className="flex flex-col gap-3">
                      <div>
                        <label className="block text-[10px] font-bold text-indigo-400 uppercase tracking-wider mb-1">Target Super Table</label>
                        <input type="text" defaultValue="st_factory_equipment" className="w-full max-w-xs px-3 py-1.5 border border-indigo-200 rounded text-sm text-indigo-900 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono" />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1.5">Target Database Table</label>
                    <input 
                      type="text" 
                      value={activeTask.tableName}
                      disabled={activeTask.useTimeScale}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-400 font-mono"
                      onChange={() => {}}
                    />
                  </div>
                  <div className="flex flex-col justify-center pt-5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={activeTask.useTimeScale} onChange={() => {}} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                      <span className="text-sm font-semibold text-slate-700">Use Built-in Time Scale Table (tb_au_pubHisvalues)</span>
                    </label>
                    <p className="text-[11px] text-slate-500 mt-1 ml-6">If checked, custom columns are ignored and data is flattened into the system table.</p>
                  </div>
                </div>
              )}
            </div>

            {/* Trigger Rules */}
            <div>
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Acquisition Rules</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                
                <div className="space-y-4">
                  <label className="block text-xs font-semibold text-slate-600">Trigger Mode</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 flex-1 hover:border-indigo-300 transition-colors">
                      <input type="radio" name="triggerMode" checked={activeTask.triggerMode === 'Consecutive'} onChange={() => {}} className="text-indigo-600 focus:ring-indigo-500" />
                      <div>
                        <div className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><Clock className="w-4 h-4 text-indigo-600"/> Consecutive</div>
                        <div className="text-[10px] text-slate-500">Cyclic polling while enabled</div>
                      </div>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 flex-1 hover:border-indigo-300 transition-colors">
                      <input type="radio" name="triggerMode" checked={activeTask.triggerMode === 'RisingEdge'} onChange={() => {}} className="text-indigo-600 focus:ring-indigo-500" />
                      <div>
                        <div className="text-sm font-semibold text-slate-800 flex items-center gap-1.5"><Zap className="w-4 h-4 text-amber-500"/> Rising Edge</div>
                        <div className="text-[10px] text-slate-500">Event-driven on status change</div>
                      </div>
                    </label>
                  </div>

                  {activeTask.triggerMode === 'Consecutive' && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Acquisition Cycle (ms)</label>
                      <input type="number" value={activeTask.cycleTime} className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono" onChange={() => {}} />
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-600">Trigger Condition / Expression</label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={activeTask.useExpression} onChange={() => {}} className="rounded text-indigo-600 focus:ring-indigo-500 border-slate-300" />
                      <span className="text-xs text-slate-500 font-medium">Use Expression Builder</span>
                    </label>
                  </div>
                  
                  {activeTask.useExpression ? (
                    <div className="relative">
                      <textarea 
                        rows={3} 
                        value={activeTask.triggerCondition} 
                        className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none text-indigo-700 bg-indigo-50/30" 
                        onChange={() => {}} 
                      />
                      <button className="absolute bottom-2 right-2 p-1.5 bg-white border border-slate-200 rounded text-slate-600 hover:text-indigo-600 hover:border-indigo-200 shadow-sm transition-colors" title="Open Expression Editor">
                        <Code2 className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <input 
                      type="text" 
                      value={activeTask.triggerCondition} 
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" 
                      placeholder="e.g. Channel.TagName"
                      onChange={() => {}} 
                    />
                  )}
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Condition must evaluate to True for the acquisition to occur.
                  </p>
                </div>

              </div>
            </div>

            {/* Traceability */}
            <div>
               <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Production Traceability</h3>
               <div className="w-1/2 pr-4">
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Batch / Work Order Tag (Optional)</label>
                  <input 
                    type="text" 
                    value={activeTask.batchTag} 
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" 
                    placeholder="e.g. R0021.CurrentBatchID"
                    onChange={() => {}} 
                  />
                  <p className="text-[11px] text-slate-500 mt-1">If provided, the system will inject the string value of this tag into the WO field for every record.</p>
               </div>
            </div>

            {/* Column Mappings */}
            {isTDengine ? (
              <div>
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 border-b border-slate-100 pb-2">Data Schema & Tags</h3>
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-5">
                   <div className="flex items-center gap-2 mb-3">
                     <Code2 className="w-4 h-4 text-slate-400" />
                     <h4 className="font-semibold text-slate-700 text-sm">Schemaless Ingestion Active</h4>
                   </div>
                   <p className="text-xs text-slate-500 leading-relaxed mb-4">
                     Traditional column mapping is not required. The gateway writes data directly using Schemaless Line Protocol. Tags are automatically attached for high-performance querying.
                   </p>
                   
                   <div className="flex flex-wrap gap-2">
                     <span className="px-2.5 py-1 bg-white rounded-md text-xs font-semibold text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1">
                       <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> Timestamp (ts)
                     </span>
                     <span className="px-2.5 py-1 bg-white rounded-md text-xs font-semibold text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1">
                       <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Value (val)
                     </span>
                     <span className="px-2.5 py-1 bg-indigo-600 rounded-md text-xs font-semibold text-white shadow-sm flex items-center gap-1">
                       <span className="w-1.5 h-1.5 rounded-full bg-indigo-300"></span> TAG: Channel
                     </span>
                     <span className="px-2.5 py-1 bg-indigo-600 rounded-md text-xs font-semibold text-white shadow-sm flex items-center gap-1">
                       <span className="w-1.5 h-1.5 rounded-full bg-indigo-300"></span> TAG: TagName
                     </span>
                     {activeTask.batchTag && (
                       <span className="px-2.5 py-1 bg-indigo-600 rounded-md text-xs font-semibold text-white shadow-sm flex items-center gap-1 transition-all">
                         <span className="w-1.5 h-1.5 rounded-full bg-indigo-300"></span> TAG: BatchID
                       </span>
                     )}
                   </div>
                </div>
              </div>
            ) : (!activeTask.useTimeScale && (
              <div>
                <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-2">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Custom Column Mapping</h3>
                  <button className="px-3 py-1.5 text-xs font-semibold text-indigo-600 bg-indigo-50 rounded shadow-sm hover:bg-indigo-100 transition-colors flex items-center gap-1.5 border border-indigo-100">
                    <Plus className="w-3.5 h-3.5" /> Add Mapping
                  </button>
                </div>

                <div className="border border-slate-200 rounded-lg overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[500px]">
                    <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase font-bold tracking-wider">
                      <tr>
                        <th className="px-4 py-3 border-b border-slate-200">Database Column</th>
                        <th className="px-4 py-3 border-b border-slate-200">PLC Tag (Data Source)</th>
                        <th className="px-4 py-3 border-b border-slate-200">Data Type</th>
                        <th className="px-4 py-3 border-b border-slate-200 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm text-slate-600">
                      {activeTask.mappings.map(map => (
                        <tr key={map.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-3 font-semibold text-slate-800">{map.dbColumn}</td>
                          <td className="px-4 py-3 font-mono text-indigo-600">{map.mappedTag}</td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-semibold border border-slate-200">
                              {map.dataType}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button className="text-slate-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {activeTask.mappings.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-4 py-8 text-center text-slate-500 text-sm">
                            No custom columns mapped.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            
          </div>
        </div>
      </div>
    </div>
  );
}
