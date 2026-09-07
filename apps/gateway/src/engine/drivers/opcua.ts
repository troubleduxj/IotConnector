import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  DataValue,
  DataType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  Variant,
  type ClientSession,
} from 'node-opcua';
import type { Quality, Tag } from '@iotconnector/shared';
import type { Driver, DriverContext } from '../driver';
import { bumpRx } from '../stats';

const RECONNECT_MS = 5000;

function securityModeOf(name: string): MessageSecurityMode {
  switch (name) {
    case 'Sign':
      return MessageSecurityMode.Sign;
    case 'SignAndEncrypt':
      return MessageSecurityMode.SignAndEncrypt;
    default:
      return MessageSecurityMode.None;
  }
}

function securityPolicyOf(name: string): SecurityPolicy {
  switch (name) {
    case 'Basic128Rsa15':
      return SecurityPolicy.Basic128Rsa15;
    case 'Basic256':
      return SecurityPolicy.Basic256;
    case 'Basic256Sha256':
      return SecurityPolicy.Basic256Sha256;
    case 'Aes128_Sha256_RsaOaep':
      return SecurityPolicy.Aes128_Sha256_RsaOaep;
    default:
      return SecurityPolicy.None;
  }
}

/** 位号 dataType → OPC UA Variant 类型 */
function variantType(dataType: Tag['dataType']): DataType {
  switch (dataType) {
    case 'Bool':
      return DataType.Boolean;
    case 'Int16':
      return DataType.Int16;
    case 'UInt16':
      return DataType.UInt16;
    case 'Int32':
      return DataType.Int32;
    case 'Float':
      return DataType.Float;
    case 'Double':
      return DataType.Double;
    default:
      return DataType.String;
  }
}

/** OPC UA StatusCode → 平台质量 */
function qualityOf(statusCode: { isGoodish?: () => boolean; isUncertain?: () => boolean; value: number }): Quality {
  if (typeof statusCode.isGoodish === 'function' && statusCode.isGoodish()) return 'Good';
  if (typeof statusCode.isUncertain === 'function' && statusCode.isUncertain()) return 'Uncertain';
  return statusCode.value === 0 ? 'Good' : 'Bad';
}

/**
 * OPC UA 驱动（node-opcua 实现）：
 * Session + Subscription/MonitoredItem 订阅式采集，服务端数据变化即推送，
 * 采样/发布间隔取通道 params.publishInterval（ms）。位号 address 为标准 NodeId 字符串
 * （如 `ns=2;s=Temperature_Sensor_01`）。
 */
export class OpcUaDriver implements Driver {
  private client?: OPCUAClient;
  private session?: ClientSession;
  private subscription?: ClientSubscription;
  private stopped = false;

  constructor(private ctx: DriverContext) {}

  async start(): Promise<void> {
    this.ctx.setStatus('connecting');
    const p = this.ctx.channel.params;
    const endpointUrl = String(p.endpointUrl ?? `opc.tcp://${this.ctx.channel.host}:${this.ctx.channel.port}`);
    const securityMode = securityModeOf(String(p.securityMode ?? 'None'));
    const securityPolicy = securityPolicyOf(String(p.securityPolicy ?? 'None'));
    const publishInterval = Number(p.publishInterval ?? 500);

    try {
      this.client = OPCUAClient.create({
        endpointMustExist: false,
        securityMode,
        securityPolicy,
        connectionStrategy: { initialDelay: 1000, maxRetry: 3 },
      });
      this.client.on('connection_lost', () => {
        if (!this.stopped) this.ctx.setStatus('offline', 'OPC UA connection lost, reconnecting…');
      });

      await this.client.connect(endpointUrl);
      this.session = await this.client.createSession();
      this.ctx.setStatus('online', `Session created (${securityPolicy})`);

      this.subscription = await this.session.createSubscription2({
        requestedPublishingInterval: publishInterval,
        requestedLifetimeCount: 600,
        requestedMaxKeepAliveCount: 20,
        maxNotificationsPerPublish: 1000,
        publishingEnabled: true,
        priority: 10,
      });

      for (const tag of this.ctx.tags) {
        const item: ClientMonitoredItem = await this.subscription.monitor(
          { nodeId: tag.address, attributeId: AttributeIds.Value },
          { samplingInterval: publishInterval, discardOldest: true, queueSize: 10 },
          TimestampsToReturn.Both,
        );
        item.on('changed', (dataValue) => {
          const raw = dataValue.value?.value;
          if (raw === null || raw === undefined) return;
          // FR-M2-07：订阅式只计 RX（无逐请求报文）
          bumpRx(this.ctx.channel.id);
          const q = qualityOf(dataValue.statusCode);
          if (tag.dataType === 'Bool') {
            this.ctx.publish(tag.id, Boolean(raw), q);
          } else if (tag.dataType === 'String') {
            this.ctx.publish(tag.id, String(raw), q);
          } else {
            this.ctx.publish(tag.id, Number(raw), q);
          }
        });
        item.on('err', (err) => {
          this.ctx.setStatus('error', `monitor ${tag.address}: ${String(err)}`);
        });
      }

      this.ctx.setStatus('online', `${this.ctx.tags.length} monitored items @ ${publishInterval}ms`);
    } catch (e) {
      if (this.stopped) return;
      this.ctx.setStatus('offline', `connect failed: ${String(e)}`);
      await this.teardown();
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
  }

  async write(tag: Tag, rawValue: number | string | boolean): Promise<void> {
    if (!this.session) throw new Error('OPC UA session not connected');
    const results = await this.session.write([
      {
        nodeId: tag.address,
        attributeId: AttributeIds.Value,
        value: new DataValue(new Variant({ dataType: variantType(tag.dataType), value: rawValue })),
      },
    ]);
    if (!results[0]?.equals(StatusCodes.Good)) {
      throw new Error(`write ${tag.address} failed: ${results[0]?.toString() ?? 'no result'}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => {
      if (!this.stopped) void this.start();
    }, RECONNECT_MS);
  }

  private async teardown(): Promise<void> {
    try {
      await this.subscription?.terminate();
    } catch {
      /* ignore */
    }
    this.subscription = undefined;
    try {
      await this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = undefined;
    try {
      await this.client?.disconnect();
    } catch {
      /* ignore */
    }
    this.client = undefined;
  }
}
