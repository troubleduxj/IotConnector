/** 告警类型展示辅助：符号 / 配色（high 越上限、low 越下限、deviation 偏差、roc 变化率） */

export function alarmKindSymbol(kind: string): string {
  if (kind === 'high') return '>';
  if (kind === 'low') return '<';
  if (kind === 'deviation') return '|Δ|';
  return '|Δ|/s';
}

export function alarmKindColorCls(kind: string): string {
  if (kind === 'high') return 'text-rose-600';
  if (kind === 'low') return 'text-blue-600';
  if (kind === 'deviation') return 'text-violet-600';
  return 'text-amber-600';
}
