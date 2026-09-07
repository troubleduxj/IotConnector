import React, { useEffect, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { useI18n } from '../i18n';

/**
 * 应用内确认/输入对话框（#24 Toast 统一的配套：替代 window.confirm/prompt）。
 * 用法（promise 风格，调用方 async）：
 *   const ok = await confirmDialog({ title: '确认删除？', danger: true });
 *   const name = await promptDialog({ title: '输入名称', defaultValue: 'x' }); // 取消返回 null
 * 需在 App 挂载一次 <DialogHost />。
 */

export interface ConfirmOptions {
  title: string;
  /** 详细说明（可多行） */
  message?: string;
  /** 危险操作：确认按钮红色 */
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export interface PromptOptions {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
}

interface PendingDialog {
  kind: 'confirm' | 'prompt';
  confirm?: ConfirmOptions;
  prompt?: PromptOptions;
  resolve: (v: boolean | string | null) => void;
}

let seq = 0;
const EVT = 'fb-dialog';

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { id: (seq += 1), kind: 'confirm', confirm: opts, resolve } }));
  });
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { id: (seq += 1), kind: 'prompt', prompt: opts, resolve } }));
  });
}

export function DialogHost(): React.JSX.Element {
  const { t } = useI18n();
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    const handler = (e: Event): void => {
      const d = (e as CustomEvent).detail as PendingDialog;
      if (d.kind === 'prompt') setInput(d.prompt?.defaultValue ?? '');
      setPending(d);
    };
    window.addEventListener(EVT, handler);
    return () => window.removeEventListener(EVT, handler);
  }, []);

  if (!pending) return <></>;

  const done = (v: boolean | string | null): void => {
    pending.resolve(v);
    setPending(null);
  };

  const isPrompt = pending.kind === 'prompt';
  const danger = pending.confirm?.danger;
  const confirmLabel = (isPrompt ? pending.prompt?.confirmText : pending.confirm?.confirmText) ?? t('common.ok');
  const cancelLabel = pending.confirm?.cancelText ?? t('common.cancel');

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/30 backdrop-blur-[2px] flex items-center justify-center" onClick={() => done(false)}>
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-sm overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 flex items-start gap-3">
          {danger ? (
            <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
          ) : (
            <HelpCircle className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-800">{isPrompt ? pending.prompt?.title : pending.confirm?.title}</div>
            {pending.confirm?.message && (
              <div className="text-xs text-slate-500 mt-1.5 whitespace-pre-line leading-relaxed">{pending.confirm.message}</div>
            )}
          </div>
        </div>
        {isPrompt && (
          <div className="px-5 pb-3">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={pending.prompt?.placeholder}
              onKeyDown={(e) => {
                if (e.key === 'Enter') done(input.trim() || null);
                if (e.key === 'Escape') done(null);
              }}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>
        )}
        <div className="px-5 py-3 bg-slate-50 flex justify-end gap-2">
          <button onClick={() => done(false)} className="px-3.5 py-1.5 text-xs font-bold text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-100">
            {cancelLabel}
          </button>
          <button
            autoFocus={!isPrompt}
            onClick={() => done(isPrompt ? (input.trim() || null) : true)}
            className={`px-3.5 py-1.5 text-xs font-bold text-white rounded-md ${
              danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
