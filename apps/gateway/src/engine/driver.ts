import type { Channel, ChannelState, Quality, Tag } from '@iotconnector/shared';
import { ModbusTcpDriver } from './drivers/modbus-tcp';
import { MelsecDriver } from './drivers/melsec';
import { FinsDriver } from './drivers/fins';
import { EnipDriver } from './drivers/enip';
import { SimulationDriver } from './drivers/simulation';
import { S7Driver } from './drivers/s7';
import { OpcUaDriver } from './drivers/opcua';
import { UnsupportedDriver } from './drivers/unsupported';

/** 驱动宿主环境：由 Engine 注入，驱动只通过它上报数据与状态 */
export interface DriverContext {
  channel: Channel;
  tags: Tag[];
  /** 上报原始值（未做标度变换），Engine 统一应用 scale/offset */
  publish(tagId: string, rawValue: number | string | boolean, quality?: Quality): void;
  setStatus(state: ChannelState, detail?: string): void;
}

export interface Driver {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 下发原始值（ diagnostics 写入用，可选实现） */
  write?(tag: Tag, rawValue: number | string | boolean): Promise<void>;
}

export function createDriver(channel: Channel, ctx: DriverContext): Driver {
  if (channel.params.driver === 'simulation') return new SimulationDriver(ctx);
  switch (channel.protocol) {
    case 'Modbus TCP':
      return new ModbusTcpDriver(ctx);
    case 'Siemens Profinet':
      return new S7Driver(ctx);
    case 'Mitsubishi MELSEC':
      return new MelsecDriver(ctx);
    case 'Omron FINS':
      return new FinsDriver(ctx);
    case 'EtherNet/IP (Rockwell)':
      return new EnipDriver(ctx);
    case 'OPC UA':
      return new OpcUaDriver(ctx);
    default:
      return new UnsupportedDriver(ctx);
  }
}
