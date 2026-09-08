import { describe, it, expect } from 'vitest';
import { resolveTagValue } from '../src/engine/drivers/mqtt-subscriber';
import { convertVarbind } from '../src/engine/drivers/snmp';
import { ObjectType, type Varbind } from 'net-snmp';
import { coerceBacnetValue } from '../src/engine/drivers/bacnet';
import { ApplicationTags } from 'bacstack/lib/enum';

const P = (s: string): Buffer => Buffer.from(s, 'utf-8');
const jsonParams = { payloadMode: 'json', jsonPath: 'value' } as Record<string, unknown>;
const rawParams = { payloadMode: 'raw' } as Record<string, unknown>;

describe('MQTT 订阅值解析（topic#path）', () => {
  it('JSON 字段路径取数', () => {
    expect(resolveTagValue('factory/line1/status#temp', 'factory/line1/status', P('{"temp":42.5,"speed":1200}'), jsonParams)).toBe(42.5);
    expect(resolveTagValue('factory/line1/status#running', 'factory/line1/status', P('{"running":true}'), jsonParams)).toBe(true);
  });

  it('多层路径与缺失字段', () => {
    expect(resolveTagValue('a/b#data.temp', 'a/b', P('{"data":{"temp":3.3}}'), jsonParams)).toBe(3.3);
    expect(resolveTagValue('a/b#data.missing', 'a/b', P('{"data":{"temp":1}}'), jsonParams)).toBeUndefined();
  });

  it('# 空路径 = payload 整体标量（raw 与 json 双模式）', () => {
    expect(resolveTagValue('factory/counter#', 'factory/counter', P('1234'), rawParams)).toBe(1234);
    expect(resolveTagValue('factory/counter#', 'factory/counter', P('1234'), jsonParams)).toBe(1234);
  });

  it('raw 模式布尔与字符串', () => {
    expect(resolveTagValue('t/b', 't/b', P('true'), rawParams)).toBe(true);
    expect(resolveTagValue('t/b', 't/b', P('hello'), rawParams)).toBe('hello');
  });

  it('主题不匹配返回 undefined；JSON 非法返回 undefined', () => {
    expect(resolveTagValue('other#x', 'factory/x', P('{"x":1}'), jsonParams)).toBeUndefined();
    expect(resolveTagValue('t/x#v', 't/x', P('not-json'), jsonParams)).toBeUndefined();
  });

  it('未带 # 用通道级 jsonPath 缺省', () => {
    expect(resolveTagValue('factory/line1/status', 'factory/line1/status', P('{"value":7}'), jsonParams)).toBe(7);
  });
});

describe('SNMP Varbind 转换', () => {
  const vb = (type: ObjectType, value: unknown): Varbind => ({ oid: '1.3.6.1.4.1.99999.1.1.0', type, value }) as Varbind;

  it('数值类型原样/数值化', () => {
    expect(convertVarbind(vb(ObjectType.Integer, 42))).toBe(42);
    expect(convertVarbind(vb(ObjectType.TimeTicks, 12345))).toBe(12345);
    expect(convertVarbind(vb(ObjectType.IpAddress, '192.168.1.1'))).toBe('192.168.1.1');
  });

  it('OctetString 优先转数字，失败回退字符串', () => {
    expect(convertVarbind(vb(ObjectType.OctetString, Buffer.from('22.5')))).toBe(22.5);
    expect(convertVarbind(vb(ObjectType.OctetString, Buffer.from('Rack-A 1')))).toBe('Rack-A 1');
  });

  it('Boolean / Null / NoSuchObject', () => {
    expect(convertVarbind(vb(ObjectType.Boolean, true))).toBe(true);
    expect(convertVarbind(vb(ObjectType.Null, null))).toBeNull();
    expect(convertVarbind(vb(ObjectType.NoSuchObject, null))).toBeNull();
  });
});

describe('BACnet 值 coerce', () => {
  const T = ApplicationTags as Record<string, number>;
  it('REAL/UNSIGNED/DOUBLE → 数字', () => {
    expect(coerceBacnetValue(T.REAL, 22.5)).toBe(22.5);
    expect(coerceBacnetValue(T.UNSIGNED_INTEGER, 123)).toBe(123);
  });
  it('BOOLEAN / CHARACTER_STRING', () => {
    expect(coerceBacnetValue(T.BOOLEAN, true)).toBe(true);
    expect(coerceBacnetValue(T.CHARACTER_STRING, 'text')).toBe('text');
  });
});
