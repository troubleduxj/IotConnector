# -*- coding: utf-8 -*-
"""Console patches: api.ts additions + SystemConfiguration card removal"""

# ===== api.ts =====
p = 'api.ts'
src = open(p, encoding='utf-8').read()

addition = '''
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
'''

anchor = "const TOKEN_KEY = 'fb_token';"
assert anchor in src, 'api token anchor'
src = src.replace(anchor, "import type { NotificationConfig } from '@iotconnector/shared';\n\n" + anchor, 1)
src += addition
open(p, 'w', encoding='utf-8').write(src)
print('api.ts extended')

# ===== SystemConfiguration.tsx: 移除旧 webhook 卡片 =====
p = 'SystemConfiguration.tsx'
src = open(p, encoding='utf-8').read()
i = src.find('        {/* 告警通知（PRD FR-M10-04 MVP：Webhook） */}')
j = src.find('        {/* Real-time Data Pipeline (Redis) */}')
assert i > 0 and j > i, 'card anchors'
src = src[:i] + src[j:]
# 移除随之失效的通知状态/加载逻辑（保留无引用会报 TS6133? 未开启 noUnusedLocals，不影响编译，但清理干净）
open(p, 'w', encoding='utf-8').write(src)
print('SystemConfiguration card removed')
