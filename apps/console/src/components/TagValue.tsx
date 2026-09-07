import React, { useEffect, useRef, useState } from 'react';

/**
 * 统一实时值组件（UI 规范 §3.3 + PRD 统一 <TagValue>）：
 * - 浮点按位号精度（默认 2 位）；布尔/字符串原样
 * - 值变化时背景高亮 400ms 淡出（transition-colors）
 * - 质量灯：Good 绿 / Bad 红 / 无数据灰
 */

const FLASH_MS = 400;

export interface TagValueData {
  /** 当前值；undefined = 尚无数据（显示 —） */
  value?: number | string | boolean;
  quality?: string;
  ts?: number;
  /** 数值显示精度（tag.precision，默认 2） */
  precision?: number;
  /** 附加单位（text-slate-500，与数值基线对齐） */
  unit?: string;
}

function formatValue(v: TagValueData['value'], precision?: number): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(precision ?? 2);
  return String(v);
}

export default function TagValue({ value, quality, ts, precision, unit }: TagValueData): React.JSX.Element {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef<number | string | boolean | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    // 首次到达数据不闪烁；仅真实值变化时高亮
    if (prev !== undefined && prev !== value) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), FLASH_MS);
      return () => clearTimeout(timer);
    }
  }, [value]);

  const hasData = value !== undefined && value !== null;
  const isBad = quality === 'Bad';
  return (
    <span
      className="inline-flex items-baseline gap-1.5"
      title={hasData && ts ? `${quality} · ${new Date(ts).toLocaleTimeString()}` : undefined}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full self-center shrink-0 transition-colors duration-300 ${
          hasData ? (isBad ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'
        }`}
      />
      <span
        className={`font-mono font-bold tabular-nums px-1 rounded transition-colors duration-400 ${
          !hasData ? 'text-slate-300' : isBad ? 'text-slate-400' : 'text-slate-800'
        } ${flash ? 'bg-amber-100' : 'bg-transparent'}`}
      >
        {hasData ? formatValue(value, precision) : '—'}
      </span>
      {unit && <span className="text-sm text-slate-500 font-normal">{unit}</span>}
    </span>
  );
}
