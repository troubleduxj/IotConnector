import type { Protocol } from './types';

/**
 * 协议参数声明式 Schema（PRD §2.2「一份 schema 三处使用」）：
 *   1. 网关侧参数校验
 *   2. 控制台动态表单渲染（替代手写 per-protocol if/else）
 *   3. 配置导入导出校验
 * P0 阶段覆盖首发三协议；其余协议随 Phase 2/3 补充。
 */

export interface ParamFieldOption {
  value: string;
  label: string;
}

export interface ParamField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select' | 'boolean';
  options?: ParamFieldOption[];
  min?: number;
  max?: number;
  step?: number;
  default: string | number | boolean;
  help?: string;
  required?: boolean;
}

export const PROTOCOL_PARAM_SCHEMAS: Partial<Record<Protocol, ParamField[]>> = {
  'Modbus TCP': [
    { key: 'slaveId', label: 'Slave / Unit ID', type: 'number', min: 1, max: 247, default: 1, required: true },
    {
      key: 'byteOrder32',
      label: '32-bit Byte Order',
      type: 'select',
      default: 'CDAB',
      options: [
        { value: 'ABCD', label: 'ABCD (Big-Endian)' },
        { value: 'CDAB', label: 'CDAB (Word Swap)' },
        { value: 'DCBA', label: 'DCBA (Little-Endian)' },
        { value: 'BADC', label: 'BADC (Byte Swap)' },
      ],
      help: 'Float/DInt 寄存器字节序',
    },
    {
      key: 'addressingModel',
      label: 'Addressing Base',
      type: 'select',
      default: '1',
      options: [
        { value: '1', label: '1-based (40001 → offset 0)' },
        { value: '0', label: '0-based (40000 → offset 0)' },
      ],
    },
    { key: 'maxHoldingRegisters', label: 'Max Read Registers', type: 'number', min: 1, max: 125, default: 120 },
  ],

  'Siemens Profinet': [
    {
      key: 's7Model',
      label: 'PLC Family',
      type: 'select',
      default: 'S7-1500',
      options: [
        { value: 'S7-1500', label: 'S7-1500' },
        { value: 'S7-1200', label: 'S7-1200' },
        { value: 'S7-300', label: 'S7-300' },
        { value: 'S7-400', label: 'S7-400' },
        { value: 'S7-200 SMART', label: 'S7-200 SMART' },
      ],
    },
    { key: 'rack', label: 'Rack Number', type: 'number', min: 0, max: 7, default: 0 },
    { key: 'slot', label: 'CPU Slot', type: 'number', min: 0, max: 31, default: 1 },
    {
      key: 's7ConnectionType',
      label: 'Connection Type',
      type: 'select',
      default: 'OP',
      options: [
        { value: 'OP', label: 'OP (Visualization)' },
        { value: 'PG', label: 'PG (Engineering)' },
        { value: 'Basic', label: 'Basic (S7-1200/1500)' },
      ],
    },
    {
      key: 'pduSize',
      label: 'Negotiated PDU Size (Bytes)',
      type: 'select',
      default: 480,
      options: [
        { value: '240', label: '240' },
        { value: '480', label: '480' },
        { value: '960', label: '960 (S7-1500)' },
      ],
    },
  ],

  'OPC UA': [
    { key: 'endpointUrl', label: 'Endpoint URL', type: 'text', default: 'opc.tcp://127.0.0.1:4840/', required: true },
    {
      key: 'securityMode',
      label: 'Security Mode',
      type: 'select',
      default: 'SignAndEncrypt',
      options: [
        { value: 'None', label: 'None' },
        { value: 'Sign', label: 'Sign' },
        { value: 'SignAndEncrypt', label: 'SignAndEncrypt' },
      ],
    },
    {
      key: 'securityPolicy',
      label: 'Security Policy',
      type: 'select',
      default: 'Basic256Sha256',
      options: [
        { value: 'None', label: 'None' },
        { value: 'Basic128Rsa15', label: 'Basic128Rsa15' },
        { value: 'Basic256', label: 'Basic256' },
        { value: 'Basic256Sha256', label: 'Basic256Sha256' },
        { value: 'Aes128_Sha256_RsaOaep', label: 'Aes128_Sha256_RsaOaep' },
      ],
    },
    {
      key: 'authType',
      label: 'Authentication',
      type: 'select',
      default: 'Anonymous',
      options: [
        { value: 'Anonymous', label: 'Anonymous' },
        { value: 'Username', label: 'Username / Password' },
        { value: 'Certificate', label: 'X.509 Certificate' },
      ],
    },
    { key: 'publishInterval', label: 'Publish Interval (ms)', type: 'number', min: 50, max: 60000, default: 250 },
  ],

  // ===== 南向采集：MQTT 订阅（把发布 JSON/原始值的传感器/网关桥接进采集引擎） =====
  'MQTT / Sparkplug B': [
    {
      key: 'brokerUrl',
      label: 'Broker URL',
      type: 'text',
      default: 'mqtt://127.0.0.1:1883',
      required: true,
      help: '源 MQTT Broker 地址（位号地址 = 订阅主题）',
    },
    {
      key: 'payloadMode',
      label: 'Payload 解析',
      type: 'select',
      default: 'json',
      options: [
        { value: 'json', label: 'JSON（按 jsonPath 取字段）' },
        { value: 'raw', label: '原始值（数字/布尔/字符串）' },
      ],
    },
    {
      key: 'jsonPath',
      label: 'JSON 字段路径',
      type: 'text',
      default: 'value',
      help: '点分路径，如 value 或 data.temp；payloadMode=json 时生效',
    },
    { key: 'qos', label: 'QoS', type: 'select', default: '0', options: [{ value: '0', label: '0 (至多一次)' }, { value: '1', label: '1 (至少一次)' }] },
    { key: 'username', label: 'Username', type: 'text', default: '' },
    { key: 'password', label: 'Password', type: 'text', default: '' },
  ],

  // ===== 南向采集：SNMP 轮询（UPS/PDU/环动/能耗表） =====
  'SNMP': [
    {
      key: 'snmpVersion',
      label: 'SNMP 版本',
      type: 'select',
      default: '2c',
      options: [
        { value: '2c', label: 'v2c' },
        { value: '1', label: 'v1' },
      ],
      required: true,
    },
    { key: 'community', label: 'Community', type: 'text', default: 'public', required: true },
    { key: 'timeoutMs', label: '超时 (ms)', type: 'number', min: 200, max: 10000, default: 1500 },
    { key: 'retries', label: '重试次数', type: 'number', min: 0, max: 5, default: 1 },
  ],
};

/** 取协议参数 schema（未定义协议返回空数组，向后兼容） */
export function getParamSchema(protocol: Protocol): ParamField[] {
  return PROTOCOL_PARAM_SCHEMAS[protocol] ?? [];
}

/**
 * 按协议参数 schema 校验通道 params（FR-M2-05 导入校验 / 通道创建共用）。
 * schema 未覆盖的协议（如 MELSEC/FINS/ENIP 驱动仅消费 host/port）返回 ok。
 */
export function validateChannelParams(
  protocol: Protocol,
  params: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const schema = getParamSchema(protocol);
  for (const field of schema) {
    const v = params[field.key];
    if (field.required && (v === undefined || v === null || v === '')) {
      errors.push(`${field.label}: 必填`);
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    if (field.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) errors.push(`${field.label}: 须为数字（当前 ${String(v)}）`);
      else {
        if (field.min !== undefined && n < field.min) errors.push(`${field.label}: 不得小于 ${field.min}`);
        if (field.max !== undefined && n > field.max) errors.push(`${field.label}: 不得大于 ${field.max}`);
      }
    } else if (field.type === 'select' && field.options && !field.options.some((o) => o.value === String(v))) {
      errors.push(`${field.label}: 非法选项 ${String(v)}（可选 ${field.options.map((o) => o.value).join('/')}）`);
    } else if (field.type === 'boolean' && typeof v !== 'boolean') {
      errors.push(`${field.label}: 须为布尔值`);
    }
  }
  return { ok: errors.length === 0, errors };
}
