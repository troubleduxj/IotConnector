import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { changePassword } from '../api';

/** 首登强制改密（种子弱口令 → 个人口令） */
export default function ForceChangePassword({ onDone }: { onDone: () => void }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (newPassword.length < 6) {
      setError('新口令至少 6 位');
      return;
    }
    if (newPassword !== confirm) {
      setError('两次输入的新口令不一致');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await changePassword(oldPassword, newPassword);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? '修改失败');
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
          <h1 className="text-lg font-bold text-slate-900">请修改初始口令</h1>
        </div>
        <div className="px-8 pb-2 text-xs text-slate-500">安全要求：首次登录必须修改预置口令后才能继续使用控制台。</div>
        <div className="p-8 pt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">当前口令</label>
            <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">新口令（≥6 位）</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={field} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">确认新口令</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          </div>
          {error && <div className="px-3 py-2 rounded-md bg-rose-50 text-rose-700 text-xs">{error}</div>}
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-md hover:bg-indigo-700 disabled:opacity-60 flex items-center justify-center"
          >
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} 修改并继续
          </button>
        </div>
      </div>
    </div>
  );
}
