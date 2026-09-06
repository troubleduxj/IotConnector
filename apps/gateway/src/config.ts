import fs from 'node:fs';
import path from 'node:path';
import type { Channel, Tag } from '@iotconnector/shared';

export interface GatewayConfig {
  channels: Channel[];
  tags: Tag[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/**
 * PoC 种子配置：位号 id 与控制台原型 mockTags 的 id 对齐（'1'..'7'），
 * 便于 Dashboard 直接用实时值覆盖 mock 展示。
 * 通道 sim-01 为内置模拟驱动；mb-01 指向本地 Modbus 模拟器（pnpm dev:modbus-sim）。
 */
function seedConfig(): GatewayConfig {
  return {
    channels: [
      {
        id: 'sim-01',
        name: 'SIM_R0021_Reactor',
        protocol: 'Siemens Profinet',
        host: '127.0.0.1',
        port: 102,
        enabled: true,
        pollIntervalMs: 500,
        params: { driver: 'simulation', s7Model: 'S7-1500', rack: 0, slot: 1, pduSize: 480 },
      },
      {
        id: 'mb-01',
        name: 'R0022_Modbus_Drive',
        protocol: 'Modbus TCP',
        host: '127.0.0.1',
        port: 15020, // 本地模拟器端口（scripts/modbus-sim.ts），真机时改为 502
        enabled: true,
        pollIntervalMs: 1000,
        params: { slaveId: 1, byteOrder32: 'CDAB', addressingModel: '1', maxHoldingRegisters: 120 },
      },
    ],
    tags: [
      { id: '1', channelId: 'sim-01', name: 'R0021.pH', address: 'DB301.Real10', dataType: 'Float', unit: 'pH', scale: 1, offset: 0, engMin: 0, engMax: 14, description: 'Reactor pH level' },
      { id: '2', channelId: 'sim-01', name: 'R0021.Temperature', address: 'DB301.Real14', dataType: 'Float', unit: '°C', scale: 1, offset: 0, engMin: 20, engMax: 50, description: 'Reactor Temp' },
      { id: '3', channelId: 'sim-01', name: 'R0021.Pressure', address: 'DB301.Real18', dataType: 'Float', unit: 'bar', scale: 1, offset: 0, engMin: 0, engMax: 3, description: 'Reactor Pressure' },
      { id: '4', channelId: 'sim-01', name: 'R0021.alm1', address: 'DB301.DBX20.0', dataType: 'Bool', unit: '', scale: 1, offset: 0, description: 'Alarm 1 Status' },
      { id: '5', channelId: 'mb-01', name: 'R0022.Speed', address: '40001', dataType: 'Int16', unit: 'RPM', scale: 1, offset: 0, engMin: 0, engMax: 1500, description: 'Motor Speed' },
      { id: '6', channelId: 'mb-01', name: 'R0022.Status', address: '40002', dataType: 'Int16', unit: '', scale: 1, offset: 0, description: 'Running Status' },
      { id: '7', channelId: 'mb-01', name: 'R0022.Current', address: '40003', dataType: 'Float', unit: 'A', scale: 0.1, offset: 0, engMin: 0, engMax: 40, description: 'Inverter output current' },
    ],
  };
}

export function loadConfig(): GatewayConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as GatewayConfig;
    }
  } catch (e) {
    console.error('[config] load failed, falling back to seed:', e);
  }
  const cfg = seedConfig();
  saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: GatewayConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
