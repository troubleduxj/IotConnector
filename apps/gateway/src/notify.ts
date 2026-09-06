import type { AlarmEvent, NotificationConfig } from '@iotconnector/shared';

/** 告警通知器（MVP：通用 Webhook POST，兼容钉钉/企微的自定义机器人可通过消息体适配层扩展） */
export class WebhookNotifier {
  constructor(private getConfig: () => NotificationConfig | undefined) {}

  async send(event: AlarmEvent): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg?.enabled || !cfg.webhookUrl || event.state !== 'Active') return; // 仅活动告警推送
    const body = {
      event: event.state,
      tagName: event.tagName,
      channel: event.channel,
      kind: event.kind,
      value: event.value,
      threshold: event.threshold,
      ts: event.ts,
      message: `[FactoryBridge] ${event.message ?? ''} 当前值 ${event.value}（阈值 ${event.threshold}）`,
    };
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error(`[notify] webhook HTTP ${res.status}`);
    } catch (e) {
      console.error('[notify] webhook failed:', String(e));
    }
  }
}
