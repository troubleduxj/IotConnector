import type { Driver, DriverContext } from '../driver';
import type { Tag } from '@iotconnector/shared';

/** 内置模拟驱动：无需真实设备即可演示全链路，同时用于离线开发 */
export class SimulationDriver implements Driver {
  private timer?: NodeJS.Timeout;
  private t = 0;
  private overrides = new Map<string, number | string | boolean>();

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('online', 'Simulated PLC (internal driver)');
    this.timer = setInterval(() => this.tick(), Math.max(200, this.ctx.channel.pollIntervalMs));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    this.overrides.set(tag.id, rawValue);
  }

  private tick(): void {
    this.t += 1;
    for (const tag of this.ctx.tags) {
      if (this.overrides.has(tag.id)) {
        this.ctx.publish(tag.id, this.overrides.get(tag.id)!);
        continue;
      }
      if (tag.dataType === 'Bool') {
        this.ctx.publish(tag.id, this.t % 40 === 0);
        continue;
      }
      if (tag.dataType === 'String') {
        this.ctx.publish(tag.id, 'Running');
        continue;
      }
      const base = baseFor(tag);
      const wave = Math.sin(this.t / 8 + tag.name.length) * base * 0.05;
      const noise = (Math.random() - 0.5) * base * 0.02;
      this.ctx.publish(tag.id, Number((base + wave + noise).toFixed(3)));
    }
  }
}

function baseFor(tag: Tag): number {
  if (tag.engMin != null && tag.engMax != null) return (tag.engMin + tag.engMax) / 2;
  const n = tag.name.toLowerCase();
  if (n.includes('ph')) return 7.2;
  if (n.includes('temp')) return 35.5;
  if (n.includes('pressure')) return 1.2;
  if (n.includes('speed')) return 1200;
  if (n.includes('current')) return 24.8;
  return 50;
}
