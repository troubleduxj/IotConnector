import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * 全局 Toast（UI 规范 §5.6）：监听 window 'fb-toast' 事件。
 * 用法：window.dispatchEvent(new CustomEvent('fb-toast', { detail: '消息' }))
 * 或带类型：{ message: string, ok?: boolean }
 */

interface ToastItem {
  id: number;
  message: string;
  ok: boolean;
}

let seq = 0;

export function Toaster(): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent).detail;
      const message = typeof detail === 'string' ? detail : String(detail?.message ?? detail);
      const ok = typeof detail === 'object' && detail !== null ? detail.ok !== false : true;
      const id = (seq += 1);
      setItems((prev) => [...prev, { id, message, ok }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3000);
    };
    window.addEventListener('fb-toast', handler);
    return () => window.removeEventListener('fb-toast', handler);
  }, []);

  if (items.length === 0) return <></>;

  return (
    <div className="fixed top-5 right-5 z-[60] space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="bg-slate-900 text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl border border-slate-700 flex items-center gap-2 max-w-sm"
        >
          {item.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <XCircle className="w-4 h-4 text-rose-400 shrink-0" />}
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

/** 便捷发送 */
export function toast(message: string, ok = true): void {
  window.dispatchEvent(new CustomEvent('fb-toast', { detail: { message, ok } }));
}
