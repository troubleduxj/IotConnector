import type { Driver, DriverContext } from '../driver';

/** Phase 0 尚未实现的协议统一走此驱动，明确上报状态而非静默失败 */
export class UnsupportedDriver implements Driver {
  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('error', `Protocol "${this.ctx.channel.protocol}" driver lands in Phase 2/3 (see PRD §4.2).`);
  }

  async stop(): Promise<void> {}
}
