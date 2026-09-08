import { describe, it, expect } from 'vitest';
import {
  encodePayload, encodeMetric, decodeCommandMetrics, SPARKPLUG_DATATYPE,
} from '../src/northbound/sparkplug';

const enc = (name: string, datatype: number, value: number | string | boolean): Uint8Array =>
  encodePayload({ timestamp: Date.now(), seq: 1, metrics: [{ name, timestamp: Date.now(), datatype, value }] });

describe('Sparkplug CMD 载荷解码（B5 北向下发）', () => {
  it('FLOAT / DOUBLE / INT / BOOLEAN / STRING 值还原', () => {
    expect(decodeCommandMetrics(enc('R0021.pH', SPARKPLUG_DATATYPE.FLOAT, 7.5))[0]).toMatchObject({ name: 'R0021.pH', value: 7.5 });
    expect(decodeCommandMetrics(enc('R0021.Temp', SPARKPLUG_DATATYPE.DOUBLE, 36.25))[0].value).toBeCloseTo(36.25, 3);
    expect(decodeCommandMetrics(enc('Robot.Cycle', SPARKPLUG_DATATYPE.INT32, 42))[0].value).toBe(42);
    expect(decodeCommandMetrics(enc('Packer.Alarm', SPARKPLUG_DATATYPE.BOOLEAN, true))[0].value).toBe(true);
    expect(decodeCommandMetrics(enc('M1.Note', SPARKPLUG_DATATYPE.STRING, 'hello'))[0].value).toBe('hello');
  });

  it('多 metric 一载荷', () => {
    const buf = encodePayload({
      timestamp: Date.now(), seq: 2,
      metrics: [
        { name: 'A', timestamp: Date.now(), datatype: SPARKPLUG_DATATYPE.FLOAT, value: 1.5 },
        { name: 'B', timestamp: Date.now(), datatype: SPARKPLUG_DATATYPE.BOOLEAN, value: false },
      ],
    });
    const ms = decodeCommandMetrics(buf);
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ name: 'A', value: 1.5 });
    expect(ms[1]).toMatchObject({ name: 'B', value: false });
  });

  it('编码器单测参照（encodeMetric 直接往返）', () => {
    const m = { name: 'X.Y', timestamp: 1, datatype: SPARKPLUG_DATATYPE.FLOAT, value: 3.14 };
    const payload = encodePayload({ timestamp: 1, metrics: [m], seq: 0 });
    const out = decodeCommandMetrics(payload)[0];
    expect(out.name).toBe('X.Y');
    expect(out.value).toBeCloseTo(3.14, 3);
  });
});
