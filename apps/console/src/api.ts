/**
 * 网关 REST API 客户端（经 Vite 代理 /api → gateway）。
 * 认证：令牌存 localStorage，全部请求自动附带 Authorization；401 触发全局登出事件。
 */

import type { AlarmEvent, NotificationConfig } from '@iotconnector/shared';
export type { AlarmEvent };

const TOKEN_KEY = 'fb_token';
export type ConsoleRole = 'admin' | 'engineer' | 'operator';
export interface ConsoleUser {
  id: string;
  username: string;
  role: ConsoleRole;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 401 时由 apiFetch 派发，App 捕获后切回登录页 */
export const AUTH_EXPIRED_EVENT = 'fb-auth-expired';

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 && getToken()) {
    setToken(null);
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  return res;
}

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
  /** Bool 位号 val 已编码 0/1，展示层解码为 false/true */
  dataType?: string;
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
  const res = await apiFetch(`/api/history?${params.toString()}`, { signal });
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
  /** high 越上限 / low 越下限 / deviation 偏差 |值-基准| / roc 变化率 |Δx|每秒 */
  kind: 'high' | 'low' | 'deviation' | 'roc';
  threshold: number;
  /** deviation 模式的基准值（设定点） */
  reference?: number;
  hysteresis: number;
  enabled: boolean;
  message?: string;
}

export interface AlarmsResponse {
  rules: AlarmRule[];
  active: AlarmEvent[];
  history: AlarmEvent[];
}

export async function fetchAlarms(): Promise<AlarmsResponse> {
  const res = await apiFetch('/api/alarms');
  return (await res.json()) as AlarmsResponse;
}

export async function createAlarm(rule: Omit<AlarmRule, 'id'>): Promise<AlarmRule> {
  const res = await apiFetch('/api/alarms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rule),
  });
  return (await res.json()) as AlarmRule;
}

export async function updateAlarm(id: string, patch: Partial<AlarmRule>): Promise<AlarmRule> {
  const res = await apiFetch(`/api/alarms/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return (await res.json()) as AlarmRule;
}

export async function deleteAlarm(id: string): Promise<void> {
  await apiFetch(`/api/alarms/${id}`, { method: 'DELETE' });
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
  const res = await apiFetch('/api/tags');
  return (await res.json()) as GatewayTag[];
}

/** #22 / FR-M9-04 设备影子：reported = 真实上报值，desired = 写管道期望值 */
export interface TagShadow {
  tagId: string;
  name: string;
  channel: string;
  reported?: { value: number | string | boolean; quality: string; ts: number };
  desired?: { value: number | string | boolean; ts: number; by: string };
  /** pending = 期望值与上报值不一致（待收敛） */
  state: 'reported' | 'pending';
}

export const fetchShadow = async (): Promise<{ shadows: TagShadow[]; pending: number }> =>
  (await apiFetch('/api/shadow')).json() as Promise<{ shadows: TagShadow[]; pending: number }>;

export async function writeTagValue(
  tagId: string,
  value: number | string | boolean,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/tags/${encodeURIComponent(tagId)}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

// ===== 通道 / 位号 配置 CRUD（PRD FR-M2-01）=====

export interface GatewayChannel {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  enabled: boolean;
  pollIntervalMs: number;
  params: Record<string, string | number | boolean>;
}

export interface GatewayConfigFull {
  channels: GatewayChannel[];
  tags: GatewayTag[];
  alarms: AlarmRule[];
  notifications: { enabled: boolean; webhookUrl: string };
}

export async function fetchConfig(): Promise<GatewayConfigFull> {
  const res = await apiFetch('/api/config');
  return (await res.json()) as GatewayConfigFull;
}

export async function createChannel(channel: Omit<GatewayChannel, 'id'>): Promise<GatewayChannel> {
  const res = await apiFetch('/api/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(channel),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'create channel failed');
  return (await res.json()) as GatewayChannel;
}

export async function updateChannel(id: string, patch: Partial<GatewayChannel>): Promise<GatewayChannel> {
  const res = await apiFetch(`/api/channels/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('update channel failed');
  return (await res.json()) as GatewayChannel;
}

export async function deleteChannel(id: string): Promise<void> {
  await apiFetch(`/api/channels/${id}`, { method: 'DELETE' });
}

/** 通道配置导出（FR-M2-05）：JSON 下载（含点位表），返回文件名 */
export async function exportChannelConfig(id: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(`/api/channels/${id}/export`);
  if (!res.ok) throw new Error('export channel failed');
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m?.[1] ?? `${fallbackName}.channel.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 通道配置导入（FR-M2-05）：服务端做协议参数 schema 校验 + 点位地址语法校验 */
export async function importChannelConfig(
  bundle: unknown,
): Promise<{ channel: GatewayChannel; importedTags: number }> {
  const res = await apiFetch('/api/channels/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    throw new Error([body.error, ...(body.details ?? []).slice(0, 5)].filter(Boolean).join('\n'));
  }
  return (await res.json()) as { channel: GatewayChannel; importedTags: number };
}

export async function createTag(tag: Omit<GatewayTag, 'id'>): Promise<GatewayTag> {
  const res = await apiFetch('/api/tags', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tag),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'create tag failed');
  return (await res.json()) as GatewayTag;
}

export async function updateTag(id: string, patch: Partial<GatewayTag>): Promise<GatewayTag> {
  const res = await apiFetch(`/api/tags/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('update tag failed');
  return (await res.json()) as GatewayTag;
}

export async function deleteTag(id: string): Promise<void> {
  await apiFetch(`/api/tags/${id}`, { method: 'DELETE' });
}


// ===== 认证（PRD FR-M10-02）=====

export async function login(username: string, password: string): Promise<{ token: string; user: ConsoleUser; mustChangePassword?: boolean }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { token?: string; user?: ConsoleUser; mustChangePassword?: boolean; error?: string };
  if (!res.ok || !body.token || !body.user) throw new Error(body.error ?? '登录失败');
  setToken(body.token);
  return { token: body.token, user: body.user, mustChangePassword: body.mustChangePassword };
}

export async function fetchMe(): Promise<(ConsoleUser & { mustChangePassword?: boolean }) | null> {
  if (!getToken()) return null;
  const res = await apiFetch('/api/auth/me');
  if (!res.ok) {
    setToken(null);
    return null;
  }
  return (await res.json()) as ConsoleUser & { mustChangePassword?: boolean };
}

export async function logout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    setToken(null);
  }
}

// ===== 用户管理（admin）=====

export interface ManagedUser {
  id: string;
  username: string;
  role: ConsoleRole;
  createdAt?: number;
  mustChangePassword?: boolean;
}

export async function fetchUsers(): Promise<ManagedUser[]> {
  return (await (await apiFetch('/api/users')).json()) as ManagedUser[];
}

export async function createUser(username: string, password: string, role: ConsoleRole): Promise<ManagedUser> {
  const res = await apiFetch('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? '创建失败');
  return (await res.json()) as ManagedUser;
}

export async function updateUser(id: string, patch: { password?: string; role?: ConsoleRole }): Promise<Response> {
  return apiFetch(`/api/users/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteUser(id: string): Promise<Response> {
  return apiFetch(`/api/users/${id}`, { method: 'DELETE' });
}

// ===== 审计日志（admin）=====

export interface AuditEntry {
  ts: number;
  user: string;
  role: string;
  action: string;
  detail: string;
}

export async function fetchAudit(): Promise<AuditEntry[]> {
  const res = await apiFetch('/api/audit');
  const body = (await res.json()) as { events: AuditEntry[] };
  return body.events ?? [];
}

// ===== 告警历史（TDengine 持久化）=====

export interface AlarmHistoryEvent {
  ts: number;
  eventId: string;
  ruleId: string;
  tagId: string;
  tagName: string;
  channel: string;
  state: string;
  kind: string;
  threshold: number;
  value: number;
  message?: string;
}

export interface AlarmHistoryResponse {
  ok: boolean;
  total: number;
  limit: number;
  offset: number;
  events: AlarmHistoryEvent[];
  error?: string;
}

export async function fetchAlarmHistory(
  filters: { tagId?: string; state?: string; start?: number; end?: number; limit?: number; offset?: number },
): Promise<AlarmHistoryResponse> {
  const params = new URLSearchParams();
  if (filters.tagId) params.set('tagId', filters.tagId);
  if (filters.state) params.set('state', filters.state);
  if (filters.start) params.set('start', String(filters.start));
  if (filters.end) params.set('end', String(filters.end));
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));
  const res = await apiFetch(`/api/alarms/history?${params.toString()}`);
  return (await res.json()) as AlarmHistoryResponse;
}

// ===== 通道连接测试（FR-M2-04 真实握手）=====

export interface TestStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ChannelTestResult {
  ok: boolean;
  rttMs: number;
  steps: TestStep[];
  error?: string;
}

export async function testChannelConnection(id: string): Promise<ChannelTestResult> {
  const res = await apiFetch(`/api/channels/${id}/test`, { method: 'POST' });
  return (await res.json()) as ChannelTestResult;
}

// ===== 通知渠道（钉钉/企微/邮件/Webhook）=====

export async function saveNotifications(cfg: NotificationConfig): Promise<NotificationConfig> {
  const res = await apiFetch('/api/notifications/v2', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  return (await res.json()) as NotificationConfig;
}

export async function testNotificationChannel(channel: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch('/api/notifications/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel }),
  });
  return (await res.json()) as { ok: boolean; error?: string };
}

// ===== 存储任务 / 配方 / 脚本 / 调度 / 确认（Phase 1 收尾）=====

export interface StorageTrigger {
  mode: 'cycle' | 'deadband' | 'edge' | 'expression';
  intervalMs?: number;
  tagId?: string;
  deadband?: number;
  edge?: 'rising' | 'falling';
  /** mode === 'expression' 时的触发条件（位号按名引用，如 `温度1 > 80 && 电机运行 == true`） */
  expression?: string;
}

export interface StorageTask {
  id: string;
  name: string;
  enabled: boolean;
  tableName: string;
  trigger: StorageTrigger;
  mappings: Array<{ column: string; tagId: string }>;
}

export interface RecipeItem { tagId: string; value: number | string | boolean }
export interface Recipe {
  id: string;
  name: string;
  description: string;
  items: RecipeItem[];
  updatedAt: number;
  /** FR-M6-03 版本号 */
  version?: number;
}

/** FR-M6-04 配方下发记录 */
export interface RecipeDownloadRecord {
  id: string;
  recipeId: string;
  recipeName: string;
  version: number;
  at: number;
  by: string;
  ok: boolean;
  okCount: number;
  totalCount: number;
}

export interface ScriptTrigger {
  type: 'interval' | 'tagChange' | 'manual';
  intervalMs?: number;
  tagId?: string;
}

export interface GatewayScript {
  id: string;
  name: string;
  description: string;
  code: string;
  trigger: ScriptTrigger;
  enabled: boolean;
  output?: string[];
  /** FR-M8-06 运行监控 */
  stats?: {
    runs: number;
    lastRunAt?: number;
    lastDurationMs?: number;
    errors: number;
    lastError?: string;
    consecutiveErrors: number;
    autoDisabled?: boolean;
  };
}

export interface SchedulerChannel {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  state: string;
  pollIntervalMs: number;
  tags: number;
  samples: number;
  rateHz: number;
  lastError?: string;
  /** FR-M2-07 通道级通讯统计 */
  tx: number;
  rx: number;
  err: number;
  timeoutRate: number;
  lastCommAt?: number;
  /** FR-M3-04 平均采集周期延迟（订阅式驱动无此值） */
  avgCycleMs?: number;
}

export interface SchedulerStats {
  uptimeSec: number;
  totalSamples: number;
  rateHz: number;
  onlineChannels: number;
  avgCycleMs?: number;
  channels: SchedulerChannel[];
}

const jsonPut = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchStorageTasks = async (): Promise<StorageTask[]> =>
  (await apiFetch('/api/storage-tasks')).json() as Promise<StorageTask[]>;

/** FR-M4-06 任务运行状态（/api/storage-tasks/stats，按任务 id 索引） */
export interface StorageTaskRuntime {
  writes: number;
  lastWriteAt?: number;
  errors: number;
  lastError?: string;
  ratePerMin: number;
}

export const fetchStorageTaskStats = async (): Promise<Record<string, StorageTaskRuntime>> =>
  (await apiFetch('/api/storage-tasks/stats')).json() as Promise<Record<string, StorageTaskRuntime>>;

export const createStorageTask = async (task: Omit<StorageTask, 'id'>): Promise<StorageTask> => {
  const res = await apiFetch('/api/storage-tasks', jsonPost(task));
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? '创建失败');
  return (await res.json()) as StorageTask;
};

export const updateStorageTask = async (id: string, patch: Partial<StorageTask>): Promise<StorageTask> => {
  return (await (await apiFetch(`/api/storage-tasks/${id}`, jsonPut(patch))).json()) as StorageTask;
};

export const deleteStorageTask = async (id: string): Promise<void> => {
  await apiFetch(`/api/storage-tasks/${id}`, { method: 'DELETE' });
};

export const fetchRecipes = async (): Promise<Recipe[]> =>
  (await apiFetch('/api/recipes')).json() as Promise<Recipe[]>;

export const createRecipe = async (recipe: Omit<Recipe, 'id' | 'updatedAt'>): Promise<Recipe> => {
  return (await (await apiFetch('/api/recipes', jsonPost(recipe))).json()) as Recipe;
};

export const updateRecipe = async (id: string, patch: Partial<Recipe>): Promise<Recipe> => {
  return (await (await apiFetch(`/api/recipes/${id}`, jsonPut(patch))).json()) as Recipe;
};

export const deleteRecipe = async (id: string): Promise<void> => {
  await apiFetch(`/api/recipes/${id}`, { method: 'DELETE' });
};

export interface DownloadResultItem { tagId: string; name?: string; value: unknown; ok: boolean; error?: string }

export const downloadRecipe = async (id: string): Promise<{ ok: boolean; results: DownloadResultItem[] }> => {
  return (await (await apiFetch(`/api/recipes/${id}/download`, { method: 'POST' })).json()) as { ok: boolean; results: DownloadResultItem[] };
};

/** FR-M6-04 下发记录（新→旧） */
export const fetchRecipeDownloads = async (): Promise<RecipeDownloadRecord[]> =>
  (await apiFetch('/api/recipes/downloads')).json() as Promise<RecipeDownloadRecord[]>;

/** FR-M6-04 复制配方 */
export const duplicateRecipe = async (id: string): Promise<Recipe> =>
  (await (await apiFetch(`/api/recipes/${id}/duplicate`, { method: 'POST' })).json()) as Recipe;

/** FR-M6-04 配方导出：JSON 文件下载（含 content-disposition 文件名） */
export async function exportRecipe(id: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(`/api/recipes/${id}/export`);
  if (!res.ok) throw new Error('export recipe failed');
  const blob = await res.blob();
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m?.[1] ?? `${fallbackName}.recipe.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** FR-M6-04 配方导入：重名 409、位号匹配失败返回中文明细 */
export async function importRecipe(bundle: unknown): Promise<Recipe> {
  const res = await apiFetch('/api/recipes/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: string[] };
    throw new Error([body.error, ...(body.details ?? []).slice(0, 5)].filter(Boolean).join('\n'));
  }
  return (await res.json()) as Recipe;
}

export const fetchScripts = async (): Promise<GatewayScript[]> =>
  (await apiFetch('/api/scripts')).json() as Promise<GatewayScript[]>;

export const createScript = async (script: Omit<GatewayScript, 'id' | 'output'>): Promise<GatewayScript> => {
  return (await (await apiFetch('/api/scripts', jsonPost(script))).json()) as GatewayScript;
};

export const updateScript = async (id: string, patch: Partial<GatewayScript>): Promise<GatewayScript> => {
  return (await (await apiFetch(`/api/scripts/${id}`, jsonPut(patch))).json()) as GatewayScript;
};

export const deleteScript = async (id: string): Promise<void> => {
  await apiFetch(`/api/scripts/${id}`, { method: 'DELETE' });
};

export const runScript = async (id: string): Promise<{ ok: boolean; outputs: string[]; error?: string }> => {
  return (await (await apiFetch(`/api/scripts/${id}/run`, { method: 'POST' })).json()) as { ok: boolean; outputs: string[]; error?: string };
};

export const fetchScheduler = async (): Promise<SchedulerStats> =>
  (await apiFetch('/api/scheduler')).json() as Promise<SchedulerStats>;

/** FR-M3-03 动态重均衡：相位错开重启全部启用通道的采集驱动 */
export const rebalanceScheduler = async (): Promise<{ ok: boolean; reloaded: number }> =>
  (await apiFetch('/api/scheduler/rebalance', { method: 'POST' })).json() as Promise<{ ok: boolean; reloaded: number }>;

export const ackAlarm = async (eventId: string, note?: string): Promise<AlarmEvent> => {
  return (await (await apiFetch(`/api/alarms/events/${eventId}/ack`, jsonPost({ note }))).json()) as AlarmEvent;
};

export const changePassword = async (oldPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> => {
  return (await (await apiFetch('/api/auth/change-password', jsonPost({ oldPassword, newPassword }))).json()) as { ok: boolean; error?: string };
};


// ===== 报文诊断（FR-M2-20）=====

export interface CapturedFrame {
  ts: number;
  dir: 'TX' | 'RX';
  hex: string;
  bytes: number;
  note?: string;
}

export async function fetchChannelFrames(channelId: string): Promise<{ ok: boolean; frames: CapturedFrame[] }> {
  return (await apiFetch(`/api/channels/${channelId}/frames?limit=200`)).json() as Promise<{ ok: boolean; frames: CapturedFrame[] }>;
}

// ===== 北向 MQTT/Sparkplug B（决策 D7）=====

export interface NorthboundConfig {
  enabled: boolean;
  url: string;
  username?: string;
  password?: string;
  groupId: string;
  edgeNodeId: string;
  dataFlushMs: number;
}

export interface NorthboundStatus {
  connected: boolean;
  bdSeq: number;
  seq: number;
  queued: number;
  dropped: number;
  published: number;
  lastPublishAt?: number;
  lastError?: string;
}

/** 系统级信息（FR-M9-06/07）：运行状态 / TDengine 连接 / 计数 */
export interface SystemInfo {
  name: string;
  version: string;
  startedAt: number;
  uptimeSec: number;
  node: string;
  platform: string;
  port: number;
  storage: { url: string; db: string; state: string; queued?: number; written?: number; dropped?: number };
  counts: { channels: number; tags: number; alarms: number; storageTasks: number; recipes: number; scripts: number };
}

export const fetchSystemInfo = async (): Promise<SystemInfo> =>
  (await apiFetch('/api/system/info')).json() as Promise<SystemInfo>;

export const testDbConnection = async (): Promise<{ ok: boolean; version?: string; latencyMs?: number; error?: string }> =>
  (await apiFetch('/api/system/db-test', { method: 'POST' })).json() as Promise<{ ok: boolean; version?: string; latencyMs?: number; error?: string }>;

export const initDb = async (): Promise<{ ok: boolean; code?: number; error?: string }> =>
  (await apiFetch('/api/system/db-init', { method: 'POST' })).json() as Promise<{ ok: boolean; code?: number; error?: string }>;

export const factoryReset = async (purgeStorage = false): Promise<Response> =>
  apiFetch('/api/system/factory-reset', jsonPost({ confirm: 'RESET', purgeStorage }));

export const fetchNorthbound = async (): Promise<{ config: NorthboundConfig; status: NorthboundStatus }> =>
  (await apiFetch('/api/northbound')).json() as Promise<{ config: NorthboundConfig; status: NorthboundStatus }>;

export const saveNorthbound = async (config: NorthboundConfig): Promise<{ config: NorthboundConfig; status: NorthboundStatus }> => {
  const res = await apiFetch('/api/northbound', jsonPut(config));
  return (await res.json()) as { config: NorthboundConfig; status: NorthboundStatus };
};

export const rebirthNorthbound = async (): Promise<void> => {
  await apiFetch('/api/northbound/rebirth', { method: 'POST' });
};
