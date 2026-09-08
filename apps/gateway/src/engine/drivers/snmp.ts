import snmp, { ObjectType, type Session, type Varbind } from 'net-snmp';
import type { Driver, DriverContext } from '../driver';

/**
 * SNMP v1/v2c 轮询驱动：UPS / PDU / 环境传感器 / 网络设备 / 能耗表。
 * 位号地址 = 点分数字 OID；OctetString 优先转数字（失败回退字符串），Null → Uncertain。
 */
export class SnmpDriver implements Driver {
  private session?: Session;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    const p = this.ctx.channel.params as Record<string, unknown>;
    const version = String(p.snmpVersion ?? '2c') === '1' ? snmp.Version1 : snmp.Version2c;
    this.session = snmp.createSession(this.ctx.channel.host, String(p.community ?? 'public'), {
      port: this.ctx.channel.port,
      version,
      timeout: Math.max(200, Number(p.timeoutMs ?? 1500)),
      retries: Math.max(0, Number(p.retries ?? 1)),
    });

    this.session.on('error', (err) => {
      // 会话级错误（如端口不可达）：标记离线，下轮轮询自动恢复
      this.ctx.setStatus('offline', String(err.message ?? err));
    });

    await this.poll();
    const ms = Math.max(200, this.ctx.channel.pollIntervalMs);
    this.timer = setInterval(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    if (!this.session || this.busy || this.ctx.tags.length === 0) return;
    this.busy = true;
    const oids = this.ctx.tags.map((t) => t.address);
    this.session.get(oids, (err, varbinds) => {
      this.busy = false;
      if (err) {
        this.ctx.setStatus('offline', `get: ${err.message ?? err}`);
        return;
      }
      for (const vb of varbinds) {
        const tag = this.ctx.tags.find((t) => t.address === vb.oid);
        if (!tag) continue;
        const converted = this.convert(vb);
        if (converted === null) {
          this.ctx.publish(tag.id, 0, 'Uncertain'); // NoSuchObject / Null
          continue;
        }
        this.ctx.publish(tag.id, converted);
      }
      this.ctx.setStatus('online', `OK ${oids.length} OID`);
    });
  }

  private convert(vb: Varbind): number | string | boolean | null {
    switch (vb.type) {
      case ObjectType.Boolean:
        return Boolean(vb.value);
      case ObjectType.Integer:
      case ObjectType.Counter:
      case ObjectType.Gauge:
      case ObjectType.Counter64:
      case ObjectType.TimeTicks:
      case ObjectType.IpAddress:
        return typeof vb.value === 'number' ? vb.value : Number(vb.value);
      case ObjectType.OctetString: {
        const text = vb.value.toString();
        const n = Number(text);
        return Number.isNaN(n) ? text : n;
      }
      case ObjectType.Null:
      case ObjectType.NoSuchObject:
      case ObjectType.NoSuchInstance:
      case ObjectType.EndOfMibView:
        return null;
      default:
        return vb.value.toString();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.session?.close();
    this.session = undefined;
  }
}
