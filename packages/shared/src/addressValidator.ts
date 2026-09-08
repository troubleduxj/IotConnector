import type { Protocol } from './types';

/**
 * 协议地址在线校验（PRD FR-M2-12）：按协议规则校验位号地址语法。
 * P0 三协议完整规则；其余协议给出基础校验。
 */

export interface AddressValidation {
  ok: boolean;
  error?: string;
  hint?: string;
}

const PROTOCOL_HINTS: Partial<Record<Protocol, string>> = {
  'Modbus TCP': '4xxxx/3xxxx（保持/输入寄存器）或 0xxxx/1xxxx（线圈）',
  'Siemens Profinet': 'DB<n>.Real<k> / DB<n>.DInt<k> / DB<n>.DBX<k>.<b>',
  'OPC UA': 'ns=<ns>;s=<字符串ID> 或 ns=<ns>;i=<数字ID>',
  'Mitsubishi MELSEC': 'D<k> / M<k> / W<k> / R<k>',
  'Omron FINS': 'DM<k> / CIO<k>.<b> / W<k> / HR<k>',
  'EtherNet/IP (Rockwell)': '程序符号名（如 Motor_Speed）',
  'BACnet/IP': 'AI:<instance> / AO:<n> / AV:<n> / BI:<n> / BV:<n>',
  'IEC 60870-5-104': 'IOA:<地址>',
  'MQTT / Sparkplug B': '主题或 metric 名',
};

export function addressHint(protocol: Protocol): string {
  return PROTOCOL_HINTS[protocol] ?? '参考协议文档';
}

export function validateAddress(protocol: Protocol, address: string): AddressValidation {
  const addr = address.trim();
  if (!addr) return { ok: false, error: '地址不能为空', hint: addressHint(protocol) };

  switch (protocol) {
    case 'Modbus TCP': {
      if (!/^[0-4]\d{4}$/.test(addr)) {
        return { ok: false, error: 'Modbus 地址须为 0xxxx~3xxxx 五位数字（如 40001）', hint: addressHint(protocol) };
      }
      return { ok: true };
    }
    case 'Siemens Profinet': {
      const m = addr.match(/^DB(\d{1,4})\.(Real|DInt|Int|Word|DWord|Byte|DBW|DBD|DBB|DBX)(\d{1,5})(?:\.([0-7]))?$/i);
      if (!m) {
        return {
          ok: false,
          error: 'S7 地址格式：DB<号>.<类型><字节>（位地址再加 .<位>），如 DB301.Real10 / DB301.DBX20.0',
          hint: addressHint(protocol),
        };
      }
      if (m[2].toUpperCase() === 'DBX' && m[4] === undefined) {
        return { ok: false, error: 'DBX 位地址须带位号（如 DB301.DBX20.0）', hint: addressHint(protocol) };
      }
      if (m[2].toUpperCase() !== 'DBX' && m[4] !== undefined) {
        return { ok: false, error: '非位类型不接受位号后缀', hint: addressHint(protocol) };
      }
      return { ok: true };
    }
    case 'OPC UA': {
      const m = addr.match(/^ns=(\d+);(s=.+|i=\d+)$/i);
      if (!m) {
        return { ok: false, error: 'OPC UA NodeId 格式：ns=<命名空间>;s=<字符串> 或 ns=<命名空间>;i=<数字>', hint: addressHint(protocol) };
      }
      return { ok: true };
    }
    case 'Mitsubishi MELSEC': {
      if (/^[DRWM]\d{1,6}$/i.test(addr)) return { ok: true };
      return { ok: false, error: 'MELSEC 地址格式：D100 / M10 / W0 / R100', hint: addressHint(protocol) };
    }
    case 'Omron FINS': {
      if (/^(DM|CIO|W|HR|AR)\d{1,5}(\.\d{1,2})?$/i.test(addr)) return { ok: true };
      return { ok: false, error: 'FINS 地址格式：DM100 / CIO0.00 / W10 / HR00', hint: addressHint(protocol) };
    }
    case 'EtherNet/IP (Rockwell)': {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(addr) || /^[A-Za-z_][A-Za-z0-9_]*\[\d+\]$/.test(addr)) return { ok: true };
      return { ok: false, error: 'CIP 符号名仅允许字母/数字/下划线（可带数组下标）', hint: addressHint(protocol) };
    }
    case 'BACnet/IP': {
      if (/^(AI|AO|AV|BI|BO|BV|MSI):\d+$/i.test(addr)) return { ok: true };
      return { ok: false, error: 'BACnet 地址格式：AI:1 / AV:3 / BV:2', hint: addressHint(protocol) };
    }
    case 'IEC 60870-5-104': {
      if (/^IOA:\d+$/i.test(addr)) return { ok: true };
      return { ok: false, error: 'IEC104 地址格式：IOA:1001', hint: addressHint(protocol) };
    }
    case 'MQTT / Sparkplug B': {
      // 地址支持「主题#字段路径」；主题段不允许空白符与订阅通配符（+/#）
      const topic = addr.split('#')[0];
      if (!topic || /[\s+]/.test(topic)) {
        return { ok: false, error: 'MQTT 地址格式：主题#字段路径（如 factory/line1/status#temp；#后省略用通道缺省）', hint: addressHint(protocol) };
      }
      return { ok: true };
    }
    case 'SNMP': {
      if (/^\d+(\.\d+)+$/.test(addr) && addr.split('.').every((seg) => seg.length <= 10 && Number(seg) <= 4294967295)) return { ok: true };
      return { ok: false, error: 'SNMP 地址格式：点分数字 OID，如 1.3.6.1.4.1.9.9.13.1.3.1.3.1', hint: addressHint(protocol) };
    }
    default:
      return { ok: true };
  }
}
