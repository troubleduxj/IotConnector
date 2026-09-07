import React, { useEffect, useState } from 'react';
import { Database, Globe, Shield, Wifi, Save, Play, CheckCircle2, Bell, Loader2 } from 'lucide-react';
import { fetchAlarms, fetchAudit, fetchMe, fetchUsers, createUser, updateUser, deleteUser, saveNorthbound, fetchNorthbound, rebirthNorthbound, type AuditEntry, type ConsoleUser, type ManagedUser, type NorthboundConfig, type NorthboundStatus } from '../api';
import { useI18n } from '../i18n';

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
  const [northbound, setNorthbound] = useState<NorthboundConfig | null>(null);
  const [nbStatus, setNbStatus] = useState<NorthboundStatus | null>(null);
  const [nbBusy, setNbBusy] = useState(false);
  const { t } = useI18n();
  const showToastMsg = (msg: string): void => {
    window.dispatchEvent(new CustomEvent('fb-toast', { detail: { message: msg, ok: true } }));
  };

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
    const loadNb = (): void => {
      fetchNorthbound().then((d) => { setNorthbound(d.config); setNbStatus(d.status); }).catch(() => {});
    };
    loadNb();
    const timer = setInterval(loadNb, 5000);
    return () => clearInterval(timer);
  }, []);

  const saveNorthboundCfg = async (): Promise<void> => {
    if (!northbound) return;
    setNbBusy(true);
    try {
      const d = await saveNorthbound(northbound);
      setNorthbound(d.config);
      setNbStatus(d.status);
      showToastMsg(t('sys.nb.saved'));
    } finally {
      setNbBusy(false);
    }
  };

  const saveNotify = async (): Promise<void> => {
    await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notify),
    });
    setNotifyToast(t('sys.notify.saved'));
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
          <h2 className="text-lg font-bold text-slate-800">{t('sys.title')}</h2>
          <p className="text-sm text-slate-500 mt-1">{t('sys.subtitle')}</p>
        </div>
        <button className="flex items-center px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors shadow-sm">
          <Save className="w-4 h-4 mr-2" />
          {t('sys.saveAll')}
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
                <h3 className="font-bold text-slate-800">{t('sys.api.title')}</h3>
              </div>
              <Toggle enabled={apiEnabled} onChange={setApiEnabled} />
            </div>
            <div className={`p-6 space-y-4 ${apiEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div className="text-xs text-slate-500 mb-4">
                {t('sys.api.desc')}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.api.servicePort')}</label>
                <input type="text" defaultValue="8093" className="w-full max-w-xs px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.api.endpointPreview')}</label>
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
                <h3 className="font-bold text-slate-800">{t('sys.mqtt.title')}</h3>
              </div>
              <Toggle enabled={mqttEnabled} onChange={setMqttEnabled} />
            </div>
            <div className={`p-6 space-y-5 ${mqttEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.mqtt.brokerHost')}</label>
                  <input type="text" defaultValue="mqtt.factorybridge.local" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.mqtt.port')}</label>
                  <input type="text" defaultValue="1883" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.mqtt.groupTopic')}</label>
                <input type="text" defaultValue="industrial/realtime" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-mono text-indigo-700" />
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-slate-400" />
                    <span className="text-sm font-semibold text-slate-700">{t('sys.mqtt.enableAuth')}</span>
                  </div>
                  <Toggle enabled={mqttSecurity} onChange={setMqttSecurity} />
                </div>
                {mqttSecurity && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100 mb-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.mqtt.username')}</label>
                      <input type="text" defaultValue="admin" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.mqtt.password')}</label>
                      <input type="password" defaultValue="********" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                    </div>
                  </div>
                )}
                
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 mt-5">{t('sys.mqtt.advanced')}</h4>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors">
                    <div className="flex items-center h-5 pt-0.5">
                      <input type="checkbox" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-800">{t('sys.mqtt.deviceShadow')}</div>
                      <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">{t('sys.mqtt.deviceShadowDesc')}</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer p-3 border border-slate-200 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors">
                    <div className="flex items-center h-5 pt-0.5">
                      <input type="checkbox" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-slate-800">{t('sys.mqtt.reliableOutbox')}</div>
                      <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">{t('sys.mqtt.reliableOutboxDesc')}</div>
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
              <h3 className="font-bold text-slate-800">{t('sys.db.title')}</h3>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5" />
              {t('sys.db.connected')}
            </div>
          </div>
          
          <div className="p-6 space-y-5">
            <div className="text-xs text-slate-500 mb-2">
              {t('sys.db.desc')}
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.db.type')}</label>
              <select 
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50 font-medium text-slate-700"
                value={currentDb}
                onChange={(e) => handleDbChange(e.target.value)}
              >
                <option value="TDengine">{t('sys.db.tdengine')}</option>
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
                    {currentDb === 'TDengine' ? t('sys.db.restHost') : t('sys.db.sqlHost')}
                  </label>
                  <input type="text" defaultValue="127.0.0.1" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.db.port')}</label>
                  <input type="text" value={getDefaultPort()} readOnly className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-slate-50 text-slate-500" />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.db.name')}</label>
              <input type="text" defaultValue="factory_bridge_db" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
            </div>

            {currentDb !== 'SQLite' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.db.username')}</label>
                  <input type="text" defaultValue="postgres" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.db.password')}</label>
                  <input type="password" defaultValue="********" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                </div>
              </div>
            )}

            <div className="pt-4 border-t border-slate-100">
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                {currentDb === 'TDengine' ? t('sys.db.keepDays') : t('sys.db.retentionMonths')}
              </label>
              <div className="flex items-center gap-3">
                <input type="number" defaultValue={currentDb === 'TDengine' ? 180 : 6} min={1} className="w-24 px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
                <span className="text-sm text-slate-500">
                  {currentDb === 'TDengine' 
                    ? t('sys.db.keepDescTde')
                    : t('sys.db.keepDescGw')}
                </span>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pt-2">
              <input type="checkbox" id="localLogs" defaultChecked className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <label htmlFor="localLogs" className="text-sm text-slate-700">{t('sys.db.localLogs')}</label>
            </div>

            <div className="pt-6 flex items-center justify-end gap-3 border-t border-slate-100">
              <button className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors flex items-center gap-2 shadow-sm">
                <Play className="w-4 h-4 text-emerald-600" />
                {t('sys.db.testConn')}
              </button>
              <button className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors shadow-sm">
                {t('sys.db.createDb')}
              </button>
            </div>
          </div>
        </div>

        {/* 北向 MQTT/Sparkplug B（决策 D7） */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-teal-100 text-teal-600 rounded-lg"><Wifi className="w-5 h-5" /></div>
              <div>
                <h3 className="font-bold text-slate-800">{t('sys.nb.title')}</h3>
                <p className="text-[11px] text-slate-400">
                  {t('sys.nb.publishLine')}
                  {nbStatus && t('sys.nb.queueStatus', { queued: nbStatus.queued, published: nbStatus.published })}
                </p>
              </div>
            </div>
            <button
              onClick={() => setNorthbound((n) => (n ? { ...n, enabled: !n.enabled } : n))}
              className={`px-2.5 py-1 rounded-md text-xs font-bold border ${
                northbound?.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-slate-100 text-slate-500 border-slate-200'
              }`}
            >
              {northbound?.enabled ? t('sys.nb.enabled') : t('sys.nb.disabled')}
            </button>
          </div>
          {northbound && (
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.nb.brokerUrl')}</label>
                  <input
                    value={northbound.url}
                    onChange={(e) => setNorthbound({ ...northbound, url: e.target.value })}
                    placeholder="mqtt://broker.local:1883"
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.nb.groupId')}</label>
                  <input
                    value={northbound.groupId}
                    onChange={(e) => setNorthbound({ ...northbound, groupId: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.nb.edgeNodeId')}</label>
                  <input
                    value={northbound.edgeNodeId}
                    onChange={(e) => setNorthbound({ ...northbound, edgeNodeId: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-[11px] text-slate-400 font-mono">
                  {nbStatus?.connected ? t('sys.nb.connected') : nbStatus?.lastError ? t('sys.nb.error', { error: nbStatus.lastError }) : t('sys.nb.disconnected')}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void rebirthNorthbound().then(() => showToastMsg(t('sys.nb.rebirthToast')))}
                    className="px-3 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                  >
                    REBIRTH
                  </button>
                  <button
                    onClick={() => void saveNorthboundCfg()}
                    disabled={nbBusy}
                    className="flex items-center px-3.5 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {nbBusy ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} {t('sys.nb.saveApply')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Real-time Data Pipeline (Redis) */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-rose-100 text-rose-600 rounded-lg">
                <Database className="w-5 h-5" />
              </div>
              <h3 className="font-bold text-slate-800">{t('sys.redis.title')}</h3>
            </div>
            <Toggle enabled={true} onChange={() => {}} />
          </div>
          <div className="p-6 space-y-5">
            <p className="text-xs text-slate-500 leading-relaxed -mt-2 mb-4">
              {t('sys.redis.desc')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.redis.host')}</label>
                <input type="text" defaultValue="127.0.0.1" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.redis.port')}</label>
                <input type="text" defaultValue="6379" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('sys.redis.streamKey')}</label>
              <input type="text" defaultValue="edge:telemetry:stream" className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500" />
            </div>
          </div>
        </div>

        </div>

      </div>
    </div>
  );
}
