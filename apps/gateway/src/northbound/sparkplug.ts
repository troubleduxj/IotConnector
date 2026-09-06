/**
 * Sparkplug B 载荷编码器（手写 protobuf wire format，无第三方依赖）。
 * 覆盖 PoC 所需子集：Metric {name, timestamp, datatype, value(oneof:
 * double/float/int/boolean/string)} 与 Payload {timestamp, metrics, seq}。
 * 消息类型常量与主题构造（spBv1.0/…）。
 */

export const SPARKPLUG_DATATYPE = {
  UNKNOWN: 1,
  INT16: 3,
  INT32: 4,
  UINT16: 7,
  FLOAT: 10,
  DOUBLE: 11,
  BOOLEAN: 12,
  STRING: 13,
} as const;

export interface SpbMetric {
  name: string;
  timestamp: number;
  datatype: number;
  value: number | string | boolean;
}

export interface SpbPayload {
  timestamp: number;
  metrics: SpbMetric[];
  seq: number;
}

// ===== protobuf 原语 =====

function varint(value: bigint | number): number[] {
  let v = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function tag(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

function lenDelimited(field: number, bytes: Uint8Array | number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}

// ===== Metric =====

export function encodeMetric(m: SpbMetric): number[] {
  const out: number[] = [];
  out.push(...lenDelimited(1, Buffer.from(m.name, 'utf-8'))); // name
  out.push(...tag(3, 0), ...varint(BigInt(m.timestamp))); // timestamp
  out.push(...tag(4, 0), ...varint(m.datatype)); // datatype

  if (typeof m.value === 'number') {
    if (m.datatype === SPARKPLUG_DATATYPE.FLOAT) {
      const b = Buffer.alloc(4);
      b.writeFloatLE(m.value);
      out.push(...tag(10, 5), ...b); // float_value (fixed32)
    } else if (m.datatype === SPARKPLUG_DATATYPE.DOUBLE) {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(m.value);
      out.push(...tag(9, 1), ...b); // double_value (fixed64)
    } else {
      out.push(...tag(11, 0), ...varint(BigInt(Math.round(m.value)))); // int_value (int64)
    }
  } else if (typeof m.value === 'boolean') {
    out.push(...tag(13, 0), ...varint(m.value ? 1n : 0n)); // boolean_value
  } else {
    out.push(...lenDelimited(14, Buffer.from(m.value, 'utf-8'))); // string_value
  }
  return out;
}

// ===== Payload =====

export function encodePayload(payload: SpbPayload): Uint8Array {
  const out: number[] = [];
  out.push(...tag(1, 0), ...varint(BigInt(payload.timestamp))); // timestamp
  for (const m of payload.metrics) {
    out.push(...lenDelimited(2, encodeMetric(m)));
  }
  out.push(...tag(3, 0), ...varint(BigInt(payload.seq))); // seq
  return new Uint8Array(out);
}

// ===== 主题与类型 =====

export type MessageType = 'NBIRTH' | 'NDATA' | 'NDEATH' | 'DBIRTH' | 'DDATA' | 'DDEATH';

export function spbTopic(groupId: string, type: MessageType, edgeNodeId: string, deviceId?: string): string {
  const base = `spBv1.0/${groupId}/${type}/${edgeNodeId}`;
  return deviceId ? `${base}/${deviceId}` : base;
}

export function dataTypeFor(tagDataType: string): number {
  switch (tagDataType) {
    case 'Bool':
      return SPARKPLUG_DATATYPE.BOOLEAN;
    case 'String':
      return SPARKPLUG_DATATYPE.STRING;
    case 'Double':
      return SPARKPLUG_DATATYPE.DOUBLE;
    case 'Float':
      return SPARKPLUG_DATATYPE.FLOAT;
    case 'Int32':
      return SPARKPLUG_DATATYPE.INT32;
    case 'UInt16':
      return SPARKPLUG_DATATYPE.UINT16;
    case 'Int16':
      return SPARKPLUG_DATATYPE.INT16;
    default:
      return SPARKPLUG_DATATYPE.UNKNOWN;
  }
}

export function tagToMetric(tag: { id: string; name: string; dataType: string }, value: number | string | boolean, timestamp: number): SpbMetric {
  return {
    name: tag.name,
    timestamp,
    datatype: dataTypeFor(tag.dataType),
    value,
  };
}

// ===== 简单解码（仅用于测试/调试：提取 seq 与 metric 名/值）=====

function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (true) {
    const b = buf[p];
    result |= BigInt(b & 0x7f) << shift;
    p += 1;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, next: p };
}

export function decodePayload(buf: Uint8Array): { seq?: number; metricNames: string[] } {
  let p = 0;
  let seq: number | undefined;
  const metricNames: string[] = [];
  while (p < buf.length) {
    const key = readVarint(buf, p);
    p = key.next;
    const field = Number(key.value >> 3n);
    const wt = Number(key.value & 7n);
    if (wt === 0) {
      const v = readVarint(buf, p);
      p = v.next;
      if (field === 3) seq = Number(v.value);
    } else if (wt === 2) {
      const len = readVarint(buf, p);
      p = len.next;
      const bytes = Buffer.from(buf.subarray(p, p + Number(len.value)));
      if (field === 2) {
        // Metric：提取 name（field 1）
        let mp = 0;
        const metricBytes = bytes;
        while (mp < metricBytes.length) {
          const mk = readVarint(metricBytes, mp);
          mp = mk.next;
          const mf = Number(mk.value >> 3n);
          const mwt = Number(mk.value & 7n);
          if (mwt === 0) {
            const v = readVarint(metricBytes, mp);
            mp = v.next;
          } else if (mwt === 5) {
            mp += 4;
          } else if (mwt === 1) {
            mp += 8;
          } else {
            const l = readVarint(metricBytes, mp);
            mp = l.next;
            if (mf === 1) metricNames.push(Buffer.from(metricBytes.subarray(mp, mp + Number(l.value))).toString('utf-8'));
            mp += Number(l.value);
          }
        }
      }
      p += Number(len.value);
    } else if (wt === 5) {
      p += 4;
    } else if (wt === 1) {
      p += 8;
    }
  }
  return { seq, metricNames };
}
