import { describe, expect, it } from 'vitest';
import {
  encodePayload, decodePayload, spbTopic, tagToMetric, SPARKPLUG_DATATYPE,
} from '../src/northbound/sparkplug';

describe('Sparkplug B 编码器', () => {
  it('主题构造符合 spBv1.0 规范', () => {
    expect(spbTopic('Plant', 'NBIRTH', 'GW01')).toBe('spBv1.0/Plant/NBIRTH/GW01');
    expect(spbTopic('Plant', 'DBIRTH', 'GW01', 'R0021_S7_1500')).toBe('spBv1.0/Plant/DBIRTH/GW01/R0021_S7_1500');
  });

  it('编码/解码 round-trip：seq 与 metric 名', () => {
    const payload = {
      timestamp: 1788672941923,
      metrics: [
        tagToMetric({ id: '1', name: 'R0021.pH', dataType: 'Float' }, 7.15, 1788672941923),
        tagToMetric({ id: '4', name: 'R0021.alm1', dataType: 'Bool' }, true, 1788672941923),
        tagToMetric({ id: '5', name: 'R0022.Speed', dataType: 'Int16' }, 1200, 1788672941923),
        tagToMetric({ id: '9', name: 'R0022.Status', dataType: 'String' }, 'Running', 1788672941923),
      ],
      seq: 42,
    };
    const bytes = encodePayload(payload);
    expect(bytes.length).toBeGreaterThan(10);
    const decoded = decodePayload(bytes);
    expect(decoded.seq).toBe(42);
    expect(decoded.metricNames).toEqual(['R0021.pH', 'R0021.alm1', 'R0022.Speed', 'R0022.Status']);
  });

  it('datatype 映射符合 Sparkplug B 枚举', () => {
    expect(tagToMetric({ id: 'x', name: 'b', dataType: 'Bool' }, false, 0).datatype).toBe(SPARKPLUG_DATATYPE.BOOLEAN);
    expect(tagToMetric({ id: 'x', name: 'f', dataType: 'Float' }, 0, 0).datatype).toBe(SPARKPLUG_DATATYPE.FLOAT);
    expect(tagToMetric({ id: 'x', name: 's', dataType: 'String' }, '', 0).datatype).toBe(SPARKPLUG_DATATYPE.STRING);
  });

  it('负数 int 值可编码（varint 64 位补码）', () => {
    const payload = {
      timestamp: 1,
      metrics: [{ name: 'n', timestamp: 1, datatype: SPARKPLUG_DATATYPE.INT32, value: -5 }],
      seq: 1,
    };
    const bytes = encodePayload(payload);
    expect(bytes.length).toBeGreaterThan(0); // 不抛异常即可
  });
});
