import type { Driver, DriverContext } from '../driver';

/**
 * Siemens S7 驱动（Phase 0 桩）。
 * 落地路径（PRD Phase 0 步骤 ③）：
 *   - 首选 node-snap7（native snap7，Linux/Windows 均有预编译包，需双平台验证）
 *   - 备选：自研 ISO-on-TCP (RFC1006) + S7comm 帧实现（纯 JS，覆盖 Read/Write DB）
 * 本桩保持驱动接口与状态上报契约，接入真实库时不改引擎代码。
 */
export class S7Driver implements Driver {
  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus(
      'error',
      'S7 driver not implemented in Phase 0 skeleton (plan: node-snap7). Use params.driver="simulation" for demo.',
    );
  }

  async stop(): Promise<void> {}
}
