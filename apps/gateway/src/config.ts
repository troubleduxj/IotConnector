import fs from 'node:fs';
import path from 'node:path';
import type { AlarmRule, Channel, NotificationConfig, Tag } from '@iotconnector/shared';
import { hashPassword, type User } from './auth';

export interface GatewayConfig {
  channels: Channel[];
  tags: Tag[];
  alarms: AlarmRule[];
  notifications?: NotificationConfig;
  users?: User[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/**
 * PoC 种子配置：位号 id 与控制台原型 mockTags 的 id 对齐（'1'..'20' 中的活跃子集），
 * 便于 Dashboard 直接用实时值覆盖 mock 展示。
 * 三条通道均为真实协议栈：S7comm（s7-sim.ts:10102）、Modbus TCP（modbus-sim.ts:15020）、
 * OPC UA 订阅（opcua-sim-node.ts:4840）。真机交付时仅需改 host/端口与 rack/slot。
 */
function seedConfig(): GatewayConfig {
  return {
    channels: [
      {
        id: 's7-01',
        name: 'R0021_S7_1500',
        protocol: 'Siemens Profinet',
        host: '127.0.0.1',
        port: 10102, // 本地模拟器端口（scripts/s7-sim.ts），真机时改为 102
        enabled: true,
        pollIntervalMs: 500,
        params: { s7Model: 'S7-1500', rack: 0, slot: 1, pduSize: 480 },
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
      {
        id: 'opc-01',
        name: 'OPC_UA_Server',
        protocol: 'OPC UA',
        host: 'localhost',
        port: 4840,
        enabled: true,
        pollIntervalMs: 1000,
        params: {
          // node-opcua 版模拟器端点（scripts/opcua-sim-node.ts）。
          // 注意：gopcua 版模拟器（ProDB opcua-simulator）公告的是无路径端点
          // opc.tcp://127.0.0.1:4840，但该服务端当前在 OPN 阶段断开外部协议栈。
          endpointUrl: 'opc.tcp://127.0.0.1:4840',
          securityMode: 'None',
          securityPolicy: 'None',
          authType: 'Anonymous',
          publishInterval: 250,
        },
      },
    ],
    tags: [
      { id: '1', channelId: 's7-01', name: 'R0021.pH', address: 'DB301.Real10', dataType: 'Float', unit: 'pH', scale: 1, offset: 0, engMin: 0, engMax: 14, description: 'Reactor pH level' },
      { id: '2', channelId: 's7-01', name: 'R0021.Temperature', address: 'DB301.Real14', dataType: 'Float', unit: '°C', scale: 1, offset: 0, engMin: 20, engMax: 50, description: 'Reactor Temp' },
      { id: '3', channelId: 's7-01', name: 'R0021.Pressure', address: 'DB301.Real18', dataType: 'Float', unit: 'bar', scale: 1, offset: 0, engMin: 0, engMax: 3, description: 'Reactor Pressure' },
      { id: '4', channelId: 's7-01', name: 'R0021.alm1', address: 'DB301.DBX20.0', dataType: 'Bool', unit: '', scale: 1, offset: 0, description: 'Alarm 1 Status' },
      { id: '5', channelId: 'mb-01', name: 'R0022.Speed', address: '40001', dataType: 'Int16', unit: 'RPM', scale: 1, offset: 0, engMin: 0, engMax: 1500, description: 'Motor Speed' },
      { id: '6', channelId: 'mb-01', name: 'R0022.Status', address: '40002', dataType: 'Int16', unit: '', scale: 1, offset: 0, description: 'Running Status' },
      { id: '7', channelId: 'mb-01', name: 'R0022.Current', address: '40003', dataType: 'Float', unit: 'A', scale: 0.1, offset: 0, engMin: 0, engMax: 40, description: 'Inverter output current' },
      { id: '8', channelId: 'opc-01', name: 'Main.Pressure', address: 'ns=2;s=Pressure_Sensor_01', dataType: 'Float', unit: 'bar', scale: 1, offset: 0, engMin: 0, engMax: 10, description: 'Main line pressure' },
      { id: '9', channelId: 'opc-01', name: 'Main.FlowRate', address: 'ns=2;s=Flow_Sensor_01', dataType: 'Float', unit: 'L/min', scale: 1, offset: 0, engMin: 0, engMax: 100, description: 'Coolant flow rate' },
      { id: '15', channelId: 'opc-01', name: 'Welder.Voltage', address: 'ns=2;s=Welder_001_WeldingVoltage', dataType: 'Float', unit: 'V', scale: 1, offset: 0, engMin: 0, engMax: 50, description: 'Arc Voltage Feedback' },
      { id: '18', channelId: 'opc-01', name: 'Robot.CycleProgress', address: 'ns=2;s=Valve_01_Opening', dataType: 'Float', unit: '%', scale: 1, offset: 0, engMin: 0, engMax: 100, description: 'Motion Execution Progress' },
    ],
    alarms: [
      { id: 'alm-1', tagId: '2', kind: 'high', threshold: 36.2, hysteresis: 0.3, enabled: true, message: 'Reactor temperature high' },
      { id: 'alm-2', tagId: '7', kind: 'high', threshold: 25.8, hysteresis: 0.4, enabled: true, message: 'Inverter current high' },
      { id: 'alm-3', tagId: '1', kind: 'low', threshold: 6.9, hysteresis: 0.1, enabled: true, message: 'Reactor pH low' },
    ],
    notifications: { enabled: false, webhookUrl: '' },
    // 种子账号（首次启动生成；正式交付时首登强制改密为后续任务）
    users: [
      { id: 'u_admin', username: 'admin', passwordHash: hashPassword('admin123'), role: 'admin', createdAt: Date.now() },
      { id: 'u_engineer', username: 'engineer', passwordHash: hashPassword('engineer123'), role: 'engineer', createdAt: Date.now() },
      { id: 'u_operator', username: 'operator', passwordHash: hashPassword('operator123'), role: 'operator', createdAt: Date.now() },
    ],
  };
}

export function loadConfig(): GatewayConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as GatewayConfig;
      parsed.alarms = parsed.alarms ?? []; // 旧版本配置迁移
      parsed.notifications = parsed.notifications ?? { enabled: false, webhookUrl: '' };
      parsed.users = parsed.users ?? [];
      return parsed;
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
