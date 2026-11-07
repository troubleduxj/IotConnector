import React, { useRef, useEffect, useState } from 'react';
import { Database, Globe, Wifi, Save, Play, CheckCircle2, Loader2, Users, Trash2, KeyRound, Plus, ScrollText, RefreshCw, Cpu, Download, Upload, RotateCcw, XCircle } from 'lucide-react';
import { fetchAudit, fetchMe, fetchUsers, createUser, updateUser, deleteUser, gatewayUrl, saveNorthbound, fetchNorthbound, rebirthNorthbound, fetchSystemInfo, testDbConnection, initDb, factoryReset, downloadConfigBackup, restoreConfigBackup, type AuditEntry, type ConsoleUser, type ManagedUser, type NorthboundConfig, type NorthboundStatus, type SystemInfo } from '../api';
import { useI18n } from '../i18n';
import { toast } from '../components/Toast';

/**
 * 系统配置（FR-M9-06/07）：全部卡片接真实数据源——
 *  WebAPI 服务状态（真实端口/端点清单/OpenAPI 下载）、TDengine 实测连接/建库、
 *  北向 MQTT/Sparkplug B（受控表单 + 队列状态）、网关基础信息（运行时长/诊断导出/恢复出厂）。
 * 无后端支撑的关系库/Redis/设备影子选项按 PRD 决策 D6/D7 收敛，不再展示假表单。
 */

export default function SystemConfiguration(_props: { dbType?: string, setDbType?: (val: string) => void }) {
  const [me, setMe] = useState<ConsoleUser | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState('');
  const [tab, setTab] = useState<'config' | 'users' | 'audit'>('config');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'operator' as ConsoleUser['role'] });
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [userBusy, setUserBusy] = useState(false);
  const [northbound, setNorthbound] = useState<NorthboundConfig | null>(null);
  const [nbStatus, setNbStatus] = useState<NorthboundStatus | null>(null);
  const [nbBusy, setNbBusy] = useState(false);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [dbTesting, setDbTesting] = useState(false);
  const [dbIniting, setDbIniting] = useState(false);
  const [dbResult, setDbResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetPurge, setResetPurge] = useState(false);
  const { t } = useI18n();
  useEffect(() => {
    fetchMe().then(async (u) => {
      if (u?.role !== 'admin') return;
      setMe(u);
      setUsers(await fetchUsers().catch(() => []));
    });
    const loadNb = (): void => {
      fetchNorthbound().then((d) => { setNorthbound(d.config); setNbStatus(d.status); }).catch(() => {});
    };
    loadNb();
    const timer = setInterval(loadNb, 5000);
    // 系统信息（真实运行状态，10s 轮询）
    const loadInfo = (): void => {
      fetchSystemInfo().then(setSysInfo).catch(() => {});
    };
    loadInfo();
    const infoTimer = setInterval(loadInfo, 10000);
    return () => { clearInterval(timer); clearInterval(infoTimer); };
  }, []);

  // 审计日志（admin）：进入审计 TAB 才加载并 15s 轮询
  useEffect(() => {
    if (me?.role !== 'admin' || tab !== 'audit') return;
    const load = (): void => {
      void fetchAudit().then(setAudit).catch(() => {});
    };
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [me?.role, tab]);

  // 带鉴权的文件下载（OpenAPI 文档 / 诊断包）
  const downloadFile = async (url: string, fallback: string): Promise<void> => {
    const res = await fetch(gatewayUrl(url), { headers: { Authorization: `Bearer ${localStorage.getItem('fb_token') ?? ''}` } });
    if (!res.ok) { toast(t('sys.info.downloadFail'), false); return; }
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m?.[1] ?? fallback;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runDbTest = async (): Promise<void> => {
    setDbTesting(true);
    try {
      const r = await testDbConnection();
      setDbResult({ ok: r.ok, text: r.ok ? t('sys.db.testOk', { version: r.version ?? '', ms: r.latencyMs ?? 0 }) : t('sys.db.testFail', { error: r.error ?? '' }) });
    } finally {
      setDbTesting(false);
    }
  };

  const runDbInit = async (): Promise<void> => {
    setDbIniting(true);
    try {
      const r = await initDb();
      setDbResult({ ok: r.ok, text: r.ok ? t('sys.db.initOk') : t('sys.db.testFail', { error: r.error ?? `code ${r.code}` }) });
    } finally {
      setDbIniting(false);
    }
  };

  const runFactoryReset = async (): Promise<void> => {
    setResetBusy(true);
    try {
      const res = await factoryReset(resetPurge);
      if (!res.ok) {
        const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        toast(err ?? t('sys.info.resetFail'), false);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { storagePurged?: boolean; storagePurgeError?: string };
      if (resetPurge && body.storagePurged) toast(t('sys.info.resetDonePurge'));
      else if (resetPurge && !body.storagePurged) toast(`${t('sys.info.resetDone')} (${t('sys.info.purgeFail')}: ${body.storagePurgeError ?? '?'})`, false);
      else toast(t('sys.info.resetDone'));
      setResetConfirm('');
      setResetPurge(false);
    } finally {
      setResetBusy(false);
    }
  };

  const restoreInputRef = useRef<HTMLInputElement>(null);

  const doRestoreBackup = async (file: File): Promise<void> => {
    try {
      const bundle = JSON.parse(await file.text()) as { format?: string; config?: unknown };
      if (bundle.format !== 'factorybridge-config@1') { toast(t('sys.info.restoreBadFormat'), false); return; }
      const r = await restoreConfigBackup(bundle);
      toast(t('sys.info.restoreDone', { n: r.counts?.channels ?? 0 }));
      fetchSystemInfo().then(setSysInfo).catch(() => {});
      void refreshUsers();
    } catch (e) {
      toast(`${t('sys.info.restoreFail')}: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  const saveNorthboundCfg = async (): Promise<void> => {
    if (!northbound) return;
    setNbBusy(true);
    try {
      const d = await saveNorthbound(northbound);
      setNorthbound(d.config);
      setNbStatus(d.status);
      toast(t('sys.nb.saved'));
    } finally {
      setNbBusy(false);
    }
  };

  // ===== 用户管理（admin）：新建/重置密码 → 该用户下次登录强制改密 =====
  const refreshUsers = (): void => {
    void fetchUsers().then(setUsers).catch(() => {});
  };
  const apiError = async (res: Response): Promise<string> => {
    return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? t('sys.users.failed');
  };
  const changeUserRole = async (u: ManagedUser, role: ConsoleUser['role']): Promise<void> => {
    const res = await updateUser(u.id, { role });
    if (!res.ok) { toast(await apiError(res), false); refreshUsers(); return; }
    toast(t('sys.users.saved'));
    refreshUsers();
  };
  const applyReset = async (u: ManagedUser): Promise<void> => {
    const res = await updateUser(u.id, { password: resetPw });
    if (!res.ok) { toast(await apiError(res), false); return; }
    toast(t('sys.users.resetDone', { name: u.username }));
    setResetTarget(null);
    setResetPw('');
    refreshUsers();
  };
  const removeUser = async (u: ManagedUser): Promise<void> => {
    const res = await deleteUser(u.id);
    if (!res.ok) { toast(await apiError(res), false); return; }
    toast(t('sys.users.deleted', { name: u.username }));
    refreshUsers();
  };
  const addUser = async (): Promise<void> => {
    setUserBusy(true);
    try {
      await createUser(newUser.username, newUser.password, newUser.role);
      toast(t('sys.users.addDone', { name: newUser.username }));
      setNewUser({ username: '', password: '', role: 'operator' });
      refreshUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('sys.users.failed'), false);
    } finally {
      setUserBusy(false);
    }
  };

  // ===== 审计日志展示辅助 =====
  const auditFiltered = audit.filter((e) => {
    const f = auditFilter.trim().toLowerCase();
    if (!f) return true;
    return `${e.user} ${e.action} ${e.detail}`.toLowerCase().includes(f);
  });
  const actionChipCls = (a: string): string => {
    if (a.startsWith('tag.write') || a.startsWith('alarm.')) {
      return 'bg-amber-50 text-amber-700 border-amber-200';
    }
    if (a.startsWith('login') || a.startsWith('logout')) {
      return 'bg-slate-100 text-slate-500 border-slate-200';
    }
    return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  };

  const fmtUptime = (sec: number): string => {
    if (sec < 60) return t('sys.info.uptimeSec', { s: sec });
    if (sec < 3600) return t('sys.info.uptimeMin', { m: Math.floor(sec / 60), s: sec % 60 });
    return t('sys.info.uptimeHour', { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60) });
  };

  const storageOk = sysInfo?.storage.state === 'online';

  return (
    <div className="space-y-6 pb-12">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-bold text-slate-800">{t('sys.title')}</h2>
          <p className="text-sm text-slate-500 mt-1">{t('sys.subtitle')}</p>
        </div>
      </div>

      {/* TAB：系统配置 / 用户管理 / 审计日志（admin） */}
      <div className="flex gap-1 border-b border-slate-200">
        <button
          onClick={() => setTab('config')}
          className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${
            tab === 'config' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
          }`}
        >
          {t('sys.title')}
        </button>
        {me?.role === 'admin' && (
          <button
            onClick={() => setTab('users')}
            className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${
              tab === 'users' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {t('sys.users.title')}
          </button>
        )}
        {me?.role === 'admin' && (
          <button
            onClick={() => setTab('audit')}
            className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${
              tab === 'audit' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {t('sys.audit.title')}
          </button>
        )}
      </div>

      {tab === 'config' && (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">

          {/* WebAPI 服务状态（真实：监听端口/端点清单/OpenAPI 下载） */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 text-blue-600 rounded-lg"><Globe className="w-5 h-5" /></div>
                <h3 className="font-bold text-slate-800">{t('sys.api.title')}</h3>
              </div>
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {t('sys.api.running')}
              </span>
            </div>
            <div className="p-6 space-y-4">
              <div className="text-xs text-slate-500">{t('sys.api.desc')}</div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.api.realPort')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo ? `:${sysInfo.port}` : '—'}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.api.authMode')}</div>
                  <div className="font-mono font-semibold text-slate-800">Bearer JWT</div>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">{t('sys.api.endpoints')}</div>
                <div className="px-3 py-2 bg-slate-900 rounded-md text-[11px] font-mono text-slate-300 space-y-0.5">
                  <div>GET&nbsp;&nbsp;/api/tags/live</div>
                  <div>GET&nbsp;&nbsp;/api/history</div>
                  <div>POST&nbsp;/api/tags/{'{id}'}/write</div>
                  <div>WS&nbsp;&nbsp;&nbsp;/ws</div>
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  onClick={() => void downloadFile('/api/system/openapi.json', 'openapi.json')}
                  className="flex items-center px-3.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" /> {t('sys.api.openapi')}
                </button>
              </div>
            </div>
          </div>

          {/* 北向 MQTT/Sparkplug B（决策 D7，真实受控表单） */}
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
                    {nbStatus?.connected
                      ? t('sys.nb.connected')
                      : nbStatus?.lastError
                        ? t('sys.nb.error', { error: nbStatus.lastError })
                        : t('sys.nb.disconnected')}
                    {nbStatus?.lastPublishAt ? ` · ${t('sys.nb.lastPublish')} ${new Date(nbStatus.lastPublishAt).toLocaleTimeString()}` : ''}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void rebirthNorthbound().then(() => toast(t('sys.nb.rebirthToast')))}
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
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          {/* TDengine 存储（决策 D6 锁定默认）：真实连接状态 + 实测/建库 */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-100 text-emerald-600 rounded-lg"><Database className="w-5 h-5" /></div>
                <h3 className="font-bold text-slate-800">{t('sys.db.title')}</h3>
              </div>
              <div className={`flex items-center gap-2 text-xs font-medium px-2 py-1 rounded-full border ${
                storageOk ? 'text-emerald-600 bg-emerald-50 border-emerald-200' : 'text-rose-600 bg-rose-50 border-rose-200'
              }`}>
                {storageOk ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {storageOk ? t('sys.db.connected') : t('sys.db.disconnected')}
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="text-xs text-slate-500">{t('sys.db.desc')}</div>

              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="col-span-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.db.restEndpoint')}</div>
                  <div className="font-mono font-semibold text-slate-800 truncate" title={sysInfo?.storage.url}>{sysInfo?.storage.url || '—'}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.db.name')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo?.storage.db ?? '—'}</div>
                </div>
              </div>

              {/* #存储优化：管道运行计数（写入/排队/丢弃） */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="px-3 py-2 bg-emerald-50/60 border border-emerald-100 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.db.written')}</div>
                  <div className="font-mono font-bold text-emerald-700">{(sysInfo?.storage.written ?? 0).toLocaleString()}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.db.queued')}</div>
                  <div className="font-mono font-bold text-slate-700">{sysInfo?.storage.queued ?? 0}</div>
                </div>
                <div className={`px-3 py-2 rounded-md border ${(sysInfo?.storage.dropped ?? 0) > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.db.dropped')}</div>
                  <div className={`font-mono font-bold ${(sysInfo?.storage.dropped ?? 0) > 0 ? 'text-rose-700' : 'text-slate-700'}`}>{sysInfo?.storage.dropped ?? 0}</div>
                </div>
              </div>

              {dbResult && (
                <div className={`px-3 py-2 rounded-md text-xs font-medium border ${
                  dbResult.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}>
                  {dbResult.text}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-100">
                <button
                  onClick={() => void runDbTest()}
                  disabled={dbTesting}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors flex items-center gap-2 shadow-sm disabled:opacity-60"
                >
                  {dbTesting ? <Loader2 className="w-4 h-4 animate-spin text-emerald-600" /> : <Play className="w-4 h-4 text-emerald-600" />}
                  {t('sys.db.testConn')}
                </button>
                <button
                  onClick={() => void runDbInit()}
                  disabled={dbIniting}
                  className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-60"
                >
                  {dbIniting ? t('sys.db.creating') : t('sys.db.createDb')}
                </button>
              </div>
            </div>
          </div>

          {/* 网关基础信息（FR-M9-07）：运行状态 / 诊断导出 / 恢复出厂 */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-200 text-slate-600 rounded-lg"><Cpu className="w-5 h-5" /></div>
                <div>
                  <h3 className="font-bold text-slate-800">{t('sys.info.title')}</h3>
                  <p className="text-[11px] text-slate-400">{t('sys.info.desc')}</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.info.version')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo?.version ?? '—'}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.info.uptime')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo ? fmtUptime(sysInfo.uptimeSec) : '—'}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.info.runtime')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo ? `Node ${sysInfo.node}` : '—'}</div>
                </div>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('sys.info.platform')}</div>
                  <div className="font-mono font-semibold text-slate-800">{sysInfo?.platform ?? '—'}</div>
                </div>
              </div>
              {sysInfo && (
                <div className="text-[11px] text-slate-400 font-mono">
                  {t('sys.info.counts', { ...sysInfo.counts })}
                </div>
              )}
              {me?.role === 'admin' && (
                <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                  <button
                    onClick={() => void downloadFile('/api/system/diag', 'factorybridge-diag.json')}
                    className="flex items-center px-3.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5" /> {t('sys.info.diag')}
                  </button>
                </div>
              )}
              {/* 运维区（admin）：全量备份下载 / 恢复（B6，灾备；与恢复出厂对称） */}
              {me?.role === 'admin' && (
                <div className="pt-3 border-t border-slate-100">
                  <div className="text-xs font-bold text-slate-500 mb-2">{t('sys.info.ops')}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => { void downloadConfigBackup().then(() => toast(t('sys.info.backupDone'))).catch(() => toast(t('sys.info.backupFail'), false)); }}
                      className="flex items-center px-3.5 py-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <Download className="w-3.5 h-3.5 mr-1.5" /> {t('sys.info.backup')}
                    </button>
                    <input
                      ref={restoreInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void doRestoreBackup(f);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => restoreInputRef.current?.click()}
                      className="flex items-center px-3.5 py-1.5 text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <Upload className="w-3.5 h-3.5 mr-1.5" /> {t('sys.info.restore')}
                    </button>
                    <span className="text-[11px] text-slate-400">{t('sys.info.opsHint')}</span>
                  </div>
                </div>
              )}
              {/* 危险区：恢复出厂（admin） */}
              {me?.role === 'admin' && (
                <div className="pt-3 border-t border-rose-100">
                  <div className="text-xs font-bold text-rose-600 mb-2">{t('sys.info.danger')}</div>
                  {resetConfirm === '' ? (
                    <button
                      onClick={() => setResetConfirm('pending')}
                      className="flex items-center px-3.5 py-1.5 text-xs font-bold text-rose-600 bg-white border border-rose-300 rounded-md hover:bg-rose-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> {t('sys.info.reset')}
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={resetConfirm === 'pending' ? '' : resetConfirm}
                        onChange={(e) => setResetConfirm(e.target.value)}
                        placeholder={t('sys.info.resetPlaceholder')}
                        className="w-36 px-3 py-1.5 border border-rose-300 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-rose-500/20"
                      />
                      <button
                        onClick={() => void runFactoryReset()}
                        disabled={resetConfirm !== 'RESET' || resetBusy}
                        className="px-3 py-1.5 text-xs font-bold text-white bg-rose-600 rounded-md hover:bg-rose-700 disabled:opacity-50"
                      >
                        {resetBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('sys.info.confirmReset')}
                      </button>
                      <button
                        onClick={() => setResetConfirm('')}
                        className="px-3 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                      >
                        {t('sys.users.cancel')}
                      </button>
                      <label className="flex items-center gap-1.5 w-full text-[11px] text-slate-600 cursor-pointer select-none">
                        <input type="checkbox" checked={resetPurge} onChange={(e) => setResetPurge(e.target.checked)} className="accent-rose-600" />
                        {t('sys.info.purgeStorage')}
                      </label>
                      <span className="w-full text-[11px] text-rose-500">{t('sys.info.resetWarn')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* 用户管理（admin）：新建 / 重置密码 → 下次登录强制改密（FR-M10-02） */}
      {tab === 'users' && me?.role === 'admin' && (
        <div className="max-w-3xl">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-100 text-indigo-600 rounded-lg"><Users className="w-5 h-5" /></div>
                <div>
                  <h3 className="font-bold text-slate-800">{t('sys.users.title')}</h3>
                  <p className="text-[11px] text-slate-400">{t('sys.users.desc')}</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-2">
              {users.map((u) => (
                <div key={u.id} className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                  <div className="flex items-center gap-2.5 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-800 truncate">{u.username}</span>
                        {u.mustChangePassword && (
                          <span className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                            {t('sys.users.mustBadge')}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {t('sys.users.createdAt')}: {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                      </div>
                    </div>
                    <select
                      value={u.role}
                      onChange={(e) => void changeUserRole(u, e.target.value as ConsoleUser['role'])}
                      className="shrink-0 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    >
                      <option value="admin">{t('role.admin')}</option>
                      <option value="engineer">{t('role.engineer')}</option>
                      <option value="operator">{t('role.operator')}</option>
                    <option value="viewer">{t('role.viewer')}</option>
                      <option value="viewer">{t('role.viewer')}</option>
                    </select>
                    <button
                      onClick={() => { setResetTarget(resetTarget === u.id ? null : u.id); setResetPw(''); }}
                      className="shrink-0 flex items-center px-2.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                    >
                      <KeyRound className="w-3.5 h-3.5 mr-1" /> {t('sys.users.reset')}
                    </button>
                    <button
                      onClick={() => void removeUser(u)}
                      disabled={u.id === me.id}
                      title={u.id === me.id ? t('sys.users.cannotDeleteSelf') : undefined}
                      className="shrink-0 p-1.5 text-slate-400 border border-slate-200 rounded-md hover:text-rose-600 hover:border-rose-200 disabled:opacity-40 disabled:hover:text-slate-400 disabled:hover:border-slate-200"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {resetTarget === u.id && (
                    <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50">
                      <input
                        type="password"
                        value={resetPw}
                        onChange={(e) => setResetPw(e.target.value)}
                        placeholder={t('sys.users.newPassword')}
                        className="flex-1 min-w-0 px-3 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                      />
                      <button
                        onClick={() => void applyReset(u)}
                        disabled={resetPw.length < 12}
                        className="shrink-0 px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-md hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {t('sys.users.apply')}
                      </button>
                      <button
                        onClick={() => setResetTarget(null)}
                        className="shrink-0 px-3 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                      >
                        {t('sys.users.cancel')}
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {/* 新建用户 */}
              <div className="border-t border-slate-100 pt-4 mt-3">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">{t('sys.users.add')}</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <input
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                    placeholder={t('sys.users.username')}
                    className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                  <input
                    type="password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    placeholder={t('sys.users.initialPassword')}
                    className="px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                  <select
                    value={newUser.role}
                    onChange={(e) => setNewUser({ ...newUser, role: e.target.value as ConsoleUser['role'] })}
                    className="px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  >
                    <option value="admin">{t('role.admin')}</option>
                    <option value="engineer">{t('role.engineer')}</option>
                    <option value="operator">{t('role.operator')}</option>
                  </select>
                  <button
                    onClick={() => void addUser()}
                    disabled={!newUser.username || newUser.password.length < 12 || userBusy}
                    className="flex items-center justify-center px-3 py-2 bg-indigo-600 text-white text-sm font-bold rounded-md hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {userBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Plus className="w-4 h-4 mr-1.5" />}
                    {t('sys.users.add')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 审计日志（FR-M10-03，admin）：配置变更/写操作/下发/登录全量留痕 */}
      {tab === 'audit' && me?.role === 'admin' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-slate-200 text-slate-600 rounded-lg"><ScrollText className="w-5 h-5" /></div>
              <div>
                <h3 className="font-bold text-slate-800">{t('sys.audit.title')}</h3>
                <p className="text-[11px] text-slate-400">{t('sys.audit.desc')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={auditFilter}
                onChange={(e) => setAuditFilter(e.target.value)}
                placeholder={t('sys.audit.filterPlaceholder')}
                className="w-56 px-3 py-1.5 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
              <button
                onClick={() => void fetchAudit().then(setAudit).catch(() => {})}
                className="flex items-center px-2.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> {t('sys.audit.refresh')}
              </button>
            </div>
          </div>
          <div className="max-h-[420px] overflow-auto">
            {auditFiltered.length === 0 ? (
              <div className="px-6 py-8 text-center text-xs text-slate-400">{t('sys.audit.empty')}</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {auditFiltered.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 px-6 py-2 text-xs">
                    <span className="shrink-0 w-[152px] pt-0.5 font-mono text-slate-400">
                      {new Date(e.ts).toLocaleString()}
                    </span>
                    <span className="shrink-0 w-20 pt-0.5 font-bold text-slate-700 truncate" title={e.user}>
                      {e.user}
                    </span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded font-bold border ${actionChipCls(e.action)}`}>
                      {e.action}
                    </span>
                    <span className="flex-1 pt-0.5 text-slate-600 break-all" title={e.detail}>
                      {e.detail}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
