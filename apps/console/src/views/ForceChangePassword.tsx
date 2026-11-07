import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { changePassword } from '../api';
import { useI18n } from '../i18n';

/** 首登强制改密（种子弱口令 → 个人口令） */
export default function ForceChangePassword({ onDone }: { onDone: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const submit = async (): Promise<void> => {
    if (newPassword.length < 12) {
      setError(t('fcp.error.tooShort'));
      return;
    }
    if (newPassword !== confirm) {
      setError(t('fcp.error.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await changePassword(oldPassword, newPassword);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? t('fcp.error.failed'));
      return;
    }
    onDone();
  };

  const field = 'w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500';

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="px-8 pt-7 pb-2 flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-indigo-600" />
          <h1 className="text-lg font-bold text-slate-900">{t('fcp.title')}</h1>
        </div>
        <div className="px-8 pb-2 text-xs text-slate-500">{t('fcp.subtitle')}</div>
        <div className="p-8 pt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('fcp.currentPassword')}</label>
            <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('fcp.newPassword')}</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">{t('fcp.confirmPassword')}</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          </div>
          {error && <div className="px-3 py-2 rounded-md bg-rose-50 text-rose-700 text-xs">{error}</div>}
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60 flex items-center justify-center"
          >
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} {t('fcp.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
