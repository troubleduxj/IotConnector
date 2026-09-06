import React, { useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { login } from '../api';
import type { ConsoleUser } from '../api';
import { useI18n } from '../i18n';

/** 登录页（PRD FR-M10-02）：本地账号 + 会话令牌 */
export default function Login({ onLogin }: { onLogin: (user: ConsoleUser, mustChange: boolean) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password);
      onLogin(result.user, Boolean(result.mustChangePassword));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 bg-indigo-500 rounded-lg flex items-center justify-center">
            <Activity className="w-6 h-6 text-white" />
          </div>
          <span className="font-bold text-white text-2xl tracking-tight">FactoryBridge</span>
        </div>

        <div className="bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
          <div className="px-8 pt-7 pb-2">
            <h1 className="text-lg font-bold text-slate-900">{t('login.title')}</h1>
            <p className="text-xs text-slate-500 mt-1">{t('login.subtitle')}</p>
          </div>
          <div className="p-8 pt-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('login.username')}</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                autoFocus
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('login.password')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              />
            </div>
            {error && (
              <div className="px-3 py-2 rounded-md bg-rose-50 text-rose-700 text-xs">{t('login.error')}</div>
            )}
            <button
              onClick={() => void submit()}
              disabled={busy || !username || !password}
              className="w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60 flex items-center justify-center transition-colors"
            >
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {t('login.submit')}
            </button>
            <p className="text-[11px] text-slate-400 text-center">{t('login.hint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
