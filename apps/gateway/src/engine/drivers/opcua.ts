import type { Driver, DriverContext } from '../driver';

/**
 * OPC UA 驱动（Phase 0 桩）。
 * 落地路径：node-opcua（纯 JS，Linux/Windows 均可），实现 Subscription/MonitoredItem
 * 订阅式采集（publishInterval 参数已就绪），安全策略按 paramSchemas 配置。
 * 本桩保持驱动接口与状态上报契约，接入真实库时不改引擎代码。
 */
export class OpcUaDriver implements Driver {
  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus(
      'error',
      'OPC UA driver not implemented in Phase 0 skeleton (plan: node-opcua). Use params.driver="simulation" for demo.',
    );
  }

  async stop(): Promise<void> {}
}
