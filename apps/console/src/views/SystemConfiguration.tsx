import React, { useEffect, useState } from 'react';
import { Database, Globe, Shield, Wifi, Save, Play, CheckCircle2, Bell } from 'lucide-react';
import { fetchAlarms, fetchAudit, fetchMe, fetchUsers, createUser, updateUser, deleteUser, type AuditEntry, type ConsoleUser, type ManagedUser } from '../api';

interface NotificationConfig {
  enabled: boolean;
  webhookUrl: string;
}

export default function SystemConfiguration({ dbType = 'TDengine', setDbType }: { dbType?: string, setDbType?: (val: string) => void }) {
  const [mqttEnabled, setMqttEnabled] = useState(true);
  const [mqttSecurity, setMqttSecurity] = useState(true);
  const [apiEnabled, setApiEnabled] = useState(true);
  const [notify, setNotify] = useState<NotificationConfig>({ enabled: false, webhookUrl: '' });
  const [notifyToast, setNotifyToast] = useState<string | null>(null);
  const [me, setMe] = useState<ConsoleUser | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' as ConsoleUser['role'] });

  useEffect(() => {
    fetch('/api/notifications')
      .then((r) => r.json())
      .then(setNotify)
      .catch(() => {});
    fetchMe().then(async (u) => {
      if (u?.role !== 'admin') return;
      setMe(u);
      setUsers(await fetchUsers().catch(() => []));
      setAudit(await fetchAudit().catch(() => []));
    });
  }, []);

  const saveNotify = async (): Promise<void> => {
    await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notify),
    });
    setNotifyToast('通知配置已保存。');
    setTimeout(() => setNotifyToast(null), 2500);
  };

  // Fallback for isolated preview
  const [localDbType, setLocalDbType] = useState(dbType);
  const currentDb = setDbType ? dbType : localDbType;

  const handleDbChange = (val: string) => {
    if (setDbType) setDbType(val);
    setLocalDbType(val);
  };

  const getDefaultPort = () => {
    switch (currentDb) {
      case 'PostgreSQL': return '5432';
      case 'MySQL': return '3306';
      case 'TDengine': return '6041';
      default: return '1433'; // SQL Server
    }
  };

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
    <div className="space-y-6 pb-12">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">System Configuration</h2>
          <p className="text-sm text-slate-500 mt-1">Configure database persistence, WebAPI, and MQTT broker settings.</p>
        </div>
        <button className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors shadow-sm">
          <Save className="w-4 h-4 mr-2" />
          Save All Changes
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          
          {/* WebAPI Configuration */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 text-blue-600 rounded-lg"><Globe className="w-5 h-5" /></div>
                <h3 className="font-bold text-slate-800">WebAPI Configuration</h3>
              </div>
              <Toggle enabled={apiEnabled} onChange={setApiEnabled} />
            </div>
            <div className={`p-6 space-y-4 ${apiEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div className="text-xs text-slate-500 mb-4">
                Third-party IT software can access real-time data of the data acquisition channel through the HTTP WebAPI.
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Service Port</label>
                <input type="text" defaultValue="8093" className="w-full max-w-xs px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Endpoint URL Preview</label>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-sm text-slate-600 font-mono">
                  http://127.0.0.1:8093/api/Data/GetRealtimeValues
                </div>
              </div>
            </div>
          </div>

          {/* MQTT Configuration */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 text-amber-600 rounded-lg"><Wifi className="w-5 h-5" /></div>
                <h3 className="font-bold text-slate-800">MQTT Configuration</h3>
              </div>
              <Toggle enabled={mqttEnabled} onChange={setMqttEnabled} />
            </div>
            <div className={`p-6 space-y-5 ${mqttEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Broker Host</label>
                  <input type="text" defaultValue="mqtt.factorybridge.local" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Port</label>
                  <input type="text" defaultValue="1883" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Group Subscription Topic</label>
                <input type="text" defaultValue="industrial/realtime" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono text-indigo-700" />
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-slate-400" />
                    <span className="text-sm font-semibold text-slate-700">Enable Authentication Security</span>
                  </div>
                  <Toggle enabled={mqttSecurity} onChange={setMqttSecurity} />
                </div>
                {mqttSecurity && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100 mb-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Username</label>
                      <input type="text" defaultValue="admin" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">Password</label>
                      <input type="password" defaultValue="********" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                    </div>
                  </div>
                )}
                
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 mt-5">Advanced Edge Capabilities</h4>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors">
                    <div className="flex items-center h-5 pt-0.5">
                      <input type="checkbox" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-800">Enable Device Shadow</div>
                      <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">Maintain a local JSON state representation of device telemetry before cloud sync.</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors">
                    <div className="flex items-center h-5 pt-0.5">
                      <input type="checkbox" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-800">Reliable Outbox (Offline Sync)</div>
                      <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">Buffer telemetry payloads locally during network outages and flush when connection restores.</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* Database Configuration */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-100 text-emerald-600 rounded-lg"><Database className="w-5 h-5" /></div>
              <h3 className="font-bold text-slate-800">Database Configuration</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Connected
            </div>
          </div>
          
          <div className="p-6 space-y-5">
            <div className="text-xs text-slate-500 mb-2">
              Select the target relational database for historical data storage. Data older than the retention period will be automatically cleaned up.
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Database Type</label>
              <select 
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50 font-medium text-slate-700"
                value={currentDb}
                onChange={(e) => handleDbChange(e.target.value)}
              >
                <option value="TDengine">TDengine (Time-Series)</option>
                <option value="PostgreSQL">PostgreSQL</option>
                <option value="Microsoft SQL Server">Microsoft SQL Server</option>
                <option value="MySQL">MySQL</option>
                <option value="SQLite">SQLite</option>
              </select>
            </div>

            {currentDb !== 'SQLite' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    {currentDb === 'TDengine' ? 'REST API Host' : 'SQL Host'}
                  </label>
                  <input type="text" defaultValue="127.0.0.1" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Port</label>
                  <input type="text" value={getDefaultPort()} readOnly className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50 text-slate-500" />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Database Name</label>
              <input type="text" defaultValue="factory_bridge_db" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
            </div>

            {currentDb !== 'SQLite' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Username</label>
                  <input type="text" defaultValue="postgres" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">Password</label>
                  <input type="password" defaultValue="********" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-slate-100">
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                {currentDb === 'TDengine' ? 'Retention Policy (KEEP Days)' : 'Data Retention Time (Months)'}
              </label>
              <div className="flex items-center gap-3">
                <input type="number" defaultValue={currentDb === 'TDengine' ? 180 : 6} min={1} className="w-24 px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                <span className="text-sm text-slate-500">
                  {currentDb === 'TDengine' 
                    ? 'TDengine will automatically drop data older than this many days natively.'
                    : 'Data older than this period will be automatically deleted by the gateway.'}
                </span>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pt-2">
              <input type="checkbox" id="localLogs" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <label htmlFor="localLogs" className="text-sm text-slate-700">Enable Local Diagnostic Logs</label>
            </div>

            <div className="pt-6 flex items-center justify-end gap-3 border-t border-slate-100">
              <button className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors flex items-center gap-2 shadow-sm">
                <Play className="w-4 h-4 text-emerald-600" />
                Test Connection
              </button>
              <button className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors shadow-sm">
                Create DB
              </button>
            </div>
          </div>
        </div>

        {/* 告警通知（PRD FR-M10-04 MVP：Webhook） */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-violet-100 text-violet-600 rounded-lg"><Bell className="w-5 h-5" /></div>
              <div>
                <h3 className="font-bold text-slate-800">告警通知（Webhook）</h3>
                <p className="text-[11px] text-slate-400">活动告警触发时 POST JSON 到指定地址</p>
              </div>
            </div>
            <button
              onClick={() => setNotify({ ...notify, enabled: !notify.enabled })}
              className={`px-2.5 py-1 rounded-md text-xs font-bold border transition-colors ${
                notify.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'
              }`}
            >
              {notify.enabled ? '已启用' : '已停用'}
            </button>
          </div>
          <div className={`p-6 space-y-4 ${notify.enabled ? '' : 'opacity-50'}`}>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Webhook 地址</label>
              <input
                value={notify.webhookUrl}
                onChange={(e) => setNotify({ ...notify, webhookUrl: e.target.value })}
                placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 或自建接收端"
                disabled={!notify.enabled}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 disabled:bg-slate-50"
              />
              <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                推送体：&#123; event, tagName, channel, kind, value, threshold, message &#125;；
                钉钉/企微机器人需在中转层适配其消息格式。
              </p>
            </div>
            {notifyToast && (
              <div className="px-3 py-2 rounded-md bg-emerald-50 text-emerald-700 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5" /> {notifyToast}
              </div>
            )}
            <div className="flex justify-end">
              <button
                onClick={() => void saveNotify()}
                className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700"
              >
                <Save className="w-3.5 h-3.5 mr-1.5" /> 保存通知配置
              </button>
            </div>
          </div>
        </div>

        {/* 用户与审计（PRD FR-M10-02，仅管理员） */}
        {me?.role === 'admin' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-3">
              <div className="p-2 bg-slate-200 text-slate-600 rounded-lg"><Shield className="w-5 h-5" /></div>
              <h3 className="font-bold text-slate-800">用户与审计</h3>
              <span className="ml-auto text-[11px] text-slate-400 font-mono">管理员 {me.username}</span>
            </div>
            <div className="p-6 space-y-5">
              <div className="overflow-x-auto border border-slate-100 rounded-lg">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-[10px] uppercase font-bold border-b border-slate-200">
                      <th className="px-4 py-2">用户名</th>
                      <th className="px-4 py-2">角色</th>
                      <th className="px-4 py-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {users.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50/80">
                        <td className="px-4 py-2 font-mono font-bold text-slate-800">{u.username}</td>
                        <td className="px-4 py-2">
                          <select
                            value={u.role}
                            disabled={u.id === me.id}
                            onChange={async (e) => { await updateUser(u.id, { role: e.target.value as ConsoleUser['role'] }); setUsers(await fetchUsers()); }}
                            className="px-2 py-1 border border-slate-300 rounded text-[11px] font-medium disabled:opacity-50"
                          >
                            <option value="admin">管理员</option>
                            <option value="engineer">工程师</option>
                            <option value="operator">操作员</option>
                          </select>
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={async () => {
                              const pwd = window.prompt(`为 ${u.username} 设置新口令：`);
                              if (pwd) { await updateUser(u.id, { password: pwd }); }
                            }}
                            className="text-indigo-600 hover:text-indigo-800 text-[11px] font-bold mr-3"
                          >
                            改密
                          </button>
                          <button
                            onClick={async () => { if (u.id !== me.id && window.confirm(`确认删除用户 ${u.username}？`)) { await deleteUser(u.id); setUsers(await fetchUsers()); } }}
                            disabled={u.id === me.id}
                            className="text-rose-600 hover:text-rose-800 text-[11px] font-bold disabled:opacity-40"
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-2">
                <input
                  placeholder="用户名"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  className="w-32 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                />
                <input
                  placeholder="口令"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="w-32 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono"
                />
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as ConsoleUser['role'] })}
                  className="px-2 py-1.5 border border-slate-300 rounded-md text-xs font-medium"
                >
                  <option value="operator">操作员</option>
                  <option value="engineer">工程师</option>
                  <option value="admin">管理员</option>
                </select>
                <button
                  onClick={async () => {
                    if (!newUser.username || !newUser.password) return;
                    try {
                      await createUser(newUser.username, newUser.password, newUser.role);
                      setUsers(await fetchUsers());
                      setNewUser({ username: '', password: '', role: 'operator' });
                    } catch (e) {
                      window.alert(String(e));
                    }
                  }}
                  className="px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700"
                >
                  新增用户
                </button>
              </div>

              <div className="pt-3 border-t border-slate-100">
                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">审计日志（最近 200 条）</div>
                <div className="max-h-40 overflow-y-auto font-mono text-[10px] space-y-1">
                  {audit.map((a, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-slate-500">
                      <span className="text-slate-400">{new Date(a.ts).toLocaleString()}</span>
                      <span className="font-bold text-slate-700">{a.user}</span>
                      <span className="px-1.5 py-0.5 bg-slate-100 rounded">{a.action}</span>
                      <span className="truncate">{a.detail}</span>
                    </div>
                  ))}
                  {audit.length === 0 && <div className="text-slate-400">暂无记录</div>}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Real-time Data Pipeline (Redis) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-rose-100 text-rose-600 rounded-lg">
                <Database className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-slate-800">Redis Stream Pipeline</h3>
            </div>
            <Toggle enabled={true} onChange={() => {}} />
          </div>
          <div className="p-6 space-y-5">
            <p className="text-xs text-slate-500 leading-relaxed -mt-2 mb-4">
              Use Redis Stream as an ultra-fast, decoupled real-time bus for clean telemetry data before routing to Historian or Cloud.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Redis Host</label>
                <input type="text" defaultValue="127.0.0.1" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Port</label>
                <input type="text" defaultValue="6379" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Telemetry Stream Key</label>
              <input type="text" defaultValue="edge:telemetry:stream" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
            </div>
          </div>
        </div>

        </div>

      </div>
    </div>
  );
}
