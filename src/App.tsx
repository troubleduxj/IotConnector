/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { LayoutDashboard, Activity, FileSpreadsheet, LineChart, Code, Server, Settings, Database, Timer, Menu, X } from 'lucide-react';
import Dashboard from './views/Dashboard';
import DeviceManagement from './views/DeviceManagement';
import Diagnostics from './views/Diagnostics';
import Recipes from './views/Recipes';
import Historian from './views/Historian';
import Scripts from './views/Scripts';
import SystemConfiguration from './views/SystemConfiguration';
import DataStorage from './views/DataStorage';
import AcquisitionScheduler from './views/AcquisitionScheduler';

type View = 'dashboard' | 'devices' | 'scheduler' | 'storage' | 'diagnostics' | 'recipes' | 'historian' | 'scripts' | 'settings';

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [dbType, setDbType] = useState('TDengine'); // Default to TDengine to showcase the integration
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navigation = [
    { id: 'dashboard', name: 'Dashboard', icon: LayoutDashboard },
    { id: 'devices', name: 'Device Management', icon: Server },
    { id: 'scheduler', name: 'Acquisition Scheduler', icon: Timer },
    { id: 'storage', name: 'Data Storage Rules', icon: Database },
    { id: 'diagnostics', name: 'Parameter Diagnose', icon: Activity },
    { id: 'recipes', name: 'Recipe Management', icon: FileSpreadsheet },
    { id: 'historian', name: 'Historian Query', icon: LineChart },
    { id: 'scripts', name: 'Python Scripts', icon: Code },
    { id: 'settings', name: 'System Config', icon: Settings },
  ] as const;

  const renderView = () => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard />;
      case 'devices':
        return <DeviceManagement />;
      case 'scheduler':
        return <AcquisitionScheduler />;
      case 'storage':
        return <DataStorage dbType={dbType} />;
      case 'diagnostics':
        return <Diagnostics />;
      case 'recipes':
        return <Recipes />;
      case 'historian':
        return <Historian />;
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
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 mb-2">Core Systems</div>
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
            <span className="hidden sm:inline-block bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full border border-green-200 font-medium">
              Live System
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold text-xs">
              AT
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

