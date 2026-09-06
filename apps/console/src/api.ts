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
