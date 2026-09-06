/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Activity, FileSpreadsheet, LineChart, Code, Server, Settings, Database, Timer,
  Menu, X, Bell, LogOut, Languages,
} from 'lucide-react';
import Dashboard from './views/Dashboard';
import DeviceManagement from './views/DeviceManagement';
import Diagnostics from './views/Diagnostics';
import Recipes from './views/Recipes';
import Historian from './views/Historian';
import Scripts from './views/Scripts';
import SystemConfiguration from './views/SystemConfiguration';
import DataStorage from './views/DataStorage';
import AcquisitionScheduler from './views/AcquisitionScheduler';
import AlarmCenter from './views/AlarmCenter';
import Login from './views/Login';
import ForceChangePassword from './views/ForceChangePassword';
import { fetchMe, logout, type ConsoleUser } from './api';
import { AUTH_EXPIRED_EVENT } from './api';
import { useRuntime } from './store/runtime';
import { I18nProvider, useI18n, type Lang } from './i18n';
import { Toaster } from './components/Toast';

type View = 'dashboard' | 'devices' | 'scheduler' | 'storage' | 'diagnostics' | 'recipes' | 'historian' | 'alarms' | 'scripts' | 'settings';

const ROLE_LABEL: Record<string, string> = { admin: '管理员', engineer: '工程师', operator: '操作员' };

export default function App(): React.JSX.Element {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}

/** 认证门卫：会话有效进主界面，否则登录页 */
function Shell(): React.JSX.Element {
  const [user, setUser] = useState<ConsoleUser | 'loading'>('loading');
  const [mustChange, setMustChange] = useState(false);

  useEffect(() => {
    fetchMe().then((u) => setUser(u)).catch(() => setUser(null));
    const onExpired = (): void => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  if (user === 'loading') {
    return <div className="min-h-screen bg-slate-900" />;
  }
  if (user === null) {
    return <Login onLogin={(u, mc) => { setUser(u); setMustChange(Boolean(mc)); }} />;
  }
  if (mustChange) {
    return <ForceChangePassword onDone={() => setMustChange(false)} />;
  }
  return <Console user={user} onLogout={() => setUser(null)} />;
}

function Console({ user, onLogout }: { user: ConsoleUser; onLogout: () => void }): React.JSX.Element {
  const { t, lang, setLang } = useI18n();
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [dbType, setDbType] = useState('TDengine'); // Default to TDengine to showcase the integration
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navigation = [
    { id: 'dashboard', name: t('nav.dashboard'), icon: LayoutDashboard },
    { id: 'devices', name: t('nav.devices'), icon: Server },
    { id: 'scheduler', name: t('nav.scheduler'), icon: Timer },
    { id: 'storage', name: t('nav.storage'), icon: Database },
    { id: 'diagnostics', name: t('nav.diagnose'), icon: Activity },
    { id: 'recipes', name: t('nav.recipes'), icon: FileSpreadsheet },
    { id: 'historian', name: t('nav.historian'), icon: LineChart },
    { id: 'alarms', name: t('nav.alarms'), icon: Bell },
    { id: 'scripts', name: t('nav.scripts'), icon: Code },
    { id: 'settings', name: t('nav.settings'), icon: Settings },
  ] as const;

  const doLogout = async (): Promise<void> => {
    await logout();
    onLogout();
  };

  const renderView = (): React.JSX.Element => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard />;
      case 'devices':
        return <DeviceManagement />;
      case 'scheduler':
        return <AcquisitionScheduler />;
      case 'storage':
        return <DataStorage />;
      case 'diagnostics':
        return <Diagnostics />;
      case 'recipes':
        return <Recipes />;
      case 'historian':
        return <Historian />;
      case 'alarms':
        return <AlarmCenter />;
      case 'scripts':
        return <Scripts />;
      case 'settings':
        return <SystemConfiguration dbType={dbType} setDbType={setDbType} />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex font-sans text-slate-900 overflow-hidden relative">
      <Toaster />
      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 z-40 md:hidden backdrop-blur-sm"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 flex flex-col shrink-0 transform transition-transform duration-300 md:relative md:translate-x-0 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-6 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-500 rounded flex items-center justify-center shrink-0">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-white text-lg tracking-tight">FactoryBridge</span>
          </div>
          <button
            className="md:hidden text-slate-400 hover:text-white"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-6 px-4 space-y-1 scrollbar-hide">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 mb-2">{t('nav.group')}</div>
          {navigation.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setCurrentView(item.id);
                  setIsMobileMenuOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-left ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="font-medium text-sm">{item.name}</span>
              </button>
            );
          })}
        </nav>
        <div className="p-4 bg-slate-800 m-4 rounded-lg">
          <div className="text-xs text-slate-400 mb-1">Sync Health</div>
          <div className="w-full bg-slate-700 h-1.5 rounded-full mb-2">
            <div className="bg-green-500 w-[94%] h-full rounded-full"></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-300">
            <span>94% Nominal</span>
            <span>v2.4.1</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 shrink-0 z-10">
          <div className="flex items-center gap-3 md:gap-4">
            <button
              className="md:hidden p-2 -ml-2 text-slate-500 hover:bg-slate-100 rounded-md"
              onClick={() => setIsMobileMenuOpen(true)}
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold text-slate-800">
              {navigation.find((item) => item.id === currentView)?.name}
            </h1>
            <GatewayStatusBadge />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
              className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-bold text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-md hover:border-indigo-300 transition-colors"
              title="切换语言 / Switch language"
            >
              <Languages className="w-4 h-4" />
              {t('header.lang')}
            </button>
            <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xs">
                {user.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="hidden sm:block leading-tight">
                <div className="text-xs font-bold text-slate-800">{user.username}</div>
                <div className="text-[10px] text-slate-400">{ROLE_LABEL[user.role] ?? user.role}</div>
              </div>
              <button
                onClick={() => void doLogout()}
                className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                title={t('header.logout')}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-8">
          <div className="max-w-7xl mx-auto flex flex-col gap-6">
            {renderView()}
          </div>
        </div>
      </main>
    </div>
  );
}

/** 顶栏网关连接状态徽章（真实反映 WS 连接状态） */
function GatewayStatusBadge() {
  const { status } = useRuntime();
  const { t } = useI18n();

  const config =
    status === 'live'
      ? { cls: 'bg-green-100 text-green-700 border-green-200', label: t('header.live') }
      : status === 'connecting'
        ? { cls: 'bg-amber-100 text-amber-700 border-amber-200', label: t('header.connecting') }
        : { cls: 'bg-rose-100 text-rose-700 border-rose-200', label: t('header.offline') };

  return (
    <span
      className={`hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border font-medium ${config.cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'live' ? 'bg-green-500 animate-pulse' : status === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-rose-500'}`} />
      {config.label}
    </span>
  );
}
