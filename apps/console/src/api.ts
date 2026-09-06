/**
 * 网关 REST API 客户端（经 Vite 代理 /api → gateway）。
 */

export interface HistoryPoint {
  t: string;
  avg: number;
  min: number;
  max: number;
  n: number;
}

export interface HistoryStats {
  min: number | null;
  max: number | null;
  avg: number | null;
  stdDev: number | null;
  count: number;
}

export interface HistorySeries {
  tagId: string;
  name?: string;
  unit?: string;
  engMin?: number | null;
  engMax?: number | null;
  intervalSec?: number;
  points: HistoryPoint[];
  stats?: HistoryStats;
  error?: string;
}

export interface HistoryResponse {
  ok: boolean;
  start: number;
  end: number;
  intervalSec: number;
  series: HistorySeries[];
  error?: string;
}

export async function fetchHistory(
  tagIds: string[],
  start: number,
  end: number,
  intervalSec?: number,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  const params = new URLSearchParams({
    tagIds: tagIds.join(','),
    start: String(start),
    end: String(end),
  });
  if (intervalSec) params.set('interval', String(intervalSec));
  const res = await fetch(`/api/history?${params.toString()}`, { signal });
  const body = (await res.json()) as HistoryResponse;
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `history query failed (HTTP ${res.status})`);
  }
  return body;
}

// ===== 告警（PRD FR-M10-01）=====

export interface AlarmRule {
  id: string;
  tagId: string;
  kind: 'high' | 'low';
  threshold: number;
  hysteresis: number;
  enabled: boolean;
  message?: string;
}

export interface AlarmEvent {
  id: string;
  ruleId: string;
  tagId: string;
  tagName: string;
  channel: string;
  state: 'Active' | 'Cleared';
  kind: 'high' | 'low';
  threshold: number;
  value: number;
  ts: number;
  message?: string;
}

export interface AlarmsResponse {
  rules: AlarmRule[];
  active: AlarmEvent[];
  history: AlarmEvent[];
}

export async function fetchAlarms(): Promise<AlarmsResponse> {
  const res = await fetch('/api/alarms');
  return (await res.json()) as AlarmsResponse;
}

export async function createAlarm(rule: Omit<AlarmRule, 'id'>): Promise<AlarmRule> {
  const res = await fetch('/api/alarms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rule),
  });
  return (await res.json()) as AlarmRule;
}

export async function updateAlarm(id: string, patch: Partial<AlarmRule>): Promise<AlarmRule> {
  const res = await fetch(`/api/alarms/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return (await res.json()) as AlarmRule;
}

export async function deleteAlarm(id: string): Promise<void> {
  await fetch(`/api/alarms/${id}`, { method: 'DELETE' });
}

// ===== 配置 CRUD（PRD FR-M2-01）=====

export interface GatewayTag {
  id: string;
  channelId: string;
  name: string;
  address: string;
  dataType: string;
  unit: string;
  scale: number;
  offset: number;
  engMin?: number;
  engMax?: number;
  description?: string;
}

export async function fetchGatewayTags(): Promise<GatewayTag[]> {
  const res = await fetch('/api/tags');
  return (await res.json()) as GatewayTag[];
}

export async function writeTagValue(
  tagId: string,
  value: number | string | boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/tags/${encodeURIComponent(tagId)}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}
