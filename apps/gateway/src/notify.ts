import nodemailer from 'nodemailer';
import { createHmac } from 'node:crypto';
import type { AlarmEvent, NotificationConfig } from '@iotconnector/shared';

/**
 * 告警通知分发器：仅活动告警推送，按渠道开关分发到
 * 通用 Webhook / 钉钉机器人（支持加签）/ 企业微信机器人 / SMTP 邮件。
 */

function fmtMessage(event: AlarmEvent): string {
  return `[FactoryBridge 告警] ${event.tagName} ${event.kind === 'high' ? '高于' : '低于'} ${event.threshold}，当前 ${event.value}`;
}

async function postJson(url: string, body: unknown, label: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
}

async function sendWebhook(cfg: NotificationConfig, event: AlarmEvent): Promise<string> {
  await postJson(cfg.webhookUrl, {
    event: event.state,
    tagName: event.tagName,
    channel: event.channel,
    kind: event.kind,
    value: event.value,
    threshold: event.threshold,
    ts: event.ts,
    message: fmtMessage(event),
  }, 'webhook');
  return 'webhook';
}

async function sendDingTalk(cfg: NotificationConfig, event: AlarmEvent): Promise<string> {
  let url = cfg.dingtalk.webhookUrl;
  if (cfg.dingtalk.secret) {
    const ts = Date.now();
    const sign = createHmac('sha256', cfg.dingtalk.secret).update(`${ts}\n${cfg.dingtalk.secret}`).digest('base64');
    url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  const text = fmtMessage(event);
  await postJson(url, {
    msgtype: 'markdown',
    markdown: {
      title: 'FactoryBridge 告警',
      text: `### FactoryBridge 告警\n\n- **位号**: ${event.tagName}\n- **事件**: ${event.state === 'Active' ? '触发' : '恢复'}（${event.kind === 'high' ? '越上限' : '越下限'}）\n- **当前值**: ${event.value}\n- **阈值**: ${event.threshold}\n\n> ${event.message ?? ''}`,
    },
  }, 'dingtalk');
  void text;
  return 'dingtalk';
}

async function sendWecom(cfg: NotificationConfig, event: AlarmEvent): Promise<string> {
  await postJson(cfg.wecom.webhookUrl, {
    msgtype: 'markdown',
    markdown: {
      content: `**FactoryBridge 告警**\n> 位号: <font color="warning">${event.tagName}</font>\n> 当前值: **${event.value}**（阈值 ${event.threshold}）\n> 状态: ${event.state === 'Active' ? '触发' : '恢复'}`,
    },
  }, 'wecom');
  return 'wecom';
}

async function sendEmail(cfg: NotificationConfig, event: AlarmEvent): Promise<string> {
  const email = cfg.email;
  const transporter = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.secure,
    auth: { user: email.username, pass: email.password },
    connectionTimeout: 8000,
  });
  await transporter.sendMail({
    from: email.username,
    to: email.to,
    subject: `[FactoryBridge 告警] ${event.tagName} ${event.state}`,
    text: `${fmtMessage(event)}\n\n时间: ${new Date(event.ts).toLocaleString()}\n通道: ${event.channel}\n`,
  });
  return 'email';
}

/** 分发活动告警到全部启用渠道；返回各渠道结果（错误不中断其他渠道） */
export async function dispatchAlarm(cfg: NotificationConfig, event: AlarmEvent): Promise<Array<{ channel: string; ok: boolean; error?: string }>> {
  if (!cfg.enabled || event.state !== 'Active') return [];
  const jobs: Array<{ channel: string; run: () => Promise<string> }> = [];
  if (cfg.webhookUrl) jobs.push({ channel: 'webhook', run: () => sendWebhook(cfg, event) });
  if (cfg.dingtalk.enabled && cfg.dingtalk.webhookUrl) jobs.push({ channel: 'dingtalk', run: () => sendDingTalk(cfg, event) });
  if (cfg.wecom.enabled && cfg.wecom.webhookUrl) jobs.push({ channel: 'wecom', run: () => sendWecom(cfg, event) });
  if (cfg.email.enabled && cfg.email.host && cfg.email.to) jobs.push({ channel: 'email', run: () => sendEmail(cfg, event) });

  const results = await Promise.all(
    jobs.map(async (j) => {
      try {
        await j.run();
        return { channel: j.channel, ok: true };
      } catch (e) {
        console.error(`[notify] ${j.channel}:`, String(e));
        return { channel: j.channel, ok: false, error: String(e) };
      }
    }),
  );
  return results;
}

/** 发送指定渠道的测试消息（返回实际使用的适配器） */
export async function sendTestMessage(cfg: NotificationConfig, channel: string): Promise<string> {
  const event: AlarmEvent = {
    id: `test_${Date.now()}`,
    ruleId: 'test',
    tagId: 'test',
    tagName: 'Test.Point',
    channel: 'test',
    state: 'Active',
    kind: 'high',
    threshold: 100,
    value: 123.45,
    ts: Date.now(),
    message: '通知渠道测试消息',
  };
  switch (channel) {
    case 'webhook':
      if (!cfg.webhookUrl) throw new Error('Webhook 地址未配置');
      return sendWebhook(cfg, event);
    case 'dingtalk':
      if (!cfg.dingtalk.enabled || !cfg.dingtalk.webhookUrl) throw new Error('钉钉渠道未启用或未配置');
      return sendDingTalk(cfg, event);
    case 'wecom':
      if (!cfg.wecom.enabled || !cfg.wecom.webhookUrl) throw new Error('企业微信渠道未启用或未配置');
      return sendWecom(cfg, event);
    case 'email':
      if (!cfg.email.enabled || !cfg.email.host || !cfg.email.to) throw new Error('邮件渠道未启用或未配置');
      return sendEmail(cfg, event);
    default:
      throw new Error(`unknown channel: ${channel}`);
  }
}
