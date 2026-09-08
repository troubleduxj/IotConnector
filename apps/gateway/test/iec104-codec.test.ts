import { describe, it, expect } from 'vitest';
import {
  U, TYPE, COT, decodeFrame, decodeAsdu, encodeIFrame, encodeSFrame, encodeAsdu, ioa, mSp, mMeNc, cIc, splitFrames,
} from '../src/engine/drivers/iec104-codec';

describe('IEC104 APCI 帧', () => {
  it('U 帧六态解码', () => {
    expect(decodeFrame(U.STARTDT_ACT).kind).toBe('u-startdt-act');
    expect(decodeFrame(U.STARTDT_CON).kind).toBe('u-startdt-con');
    expect(decodeFrame(U.STOPDT_ACT).kind).toBe('u-stopdt-act');
    expect(decodeFrame(U.STOPDT_CON).kind).toBe('u-stopdt-con');
    expect(decodeFrame(U.TESTFR_ACT).kind).toBe('u-testfr-act');
    expect(decodeFrame(U.TESTFR_CON).kind).toBe('u-testfr-con');
  });

  it('I 帧编解码往返：序号与 ASDU', () => {
    const body = cIc(COT.ACTIVATION, 1); // C_IC 总召唤
    const frame = encodeIFrame(body, 3, 7);
    const p = decodeFrame(frame);
    expect(p.kind).toBe('i');
    expect(p.sendSeq).toBe(3);
    expect(p.recvSeq).toBe(7);
    expect(p.asdu?.typeId).toBe(TYPE.C_IC_NA);
    expect(p.asdu?.cot).toBe(COT.ACTIVATION);
    expect(p.asdu?.commonAddr).toBe(1);
  });

  it('S 帧编码解码', () => {
    const f = encodeSFrame(5);
    expect(decodeFrame(f).kind).toBe('s');
    expect(decodeFrame(f).recvSeq).toBe(5);
  });

  it('帧长度合规：0x68 len = ASDU + 4，总长 6 + ASDU', () => {
    const body = encodeAsdu(TYPE.M_ME_NC, 20, 1, [mMeNc(1, 10.5)]);
    const frame = encodeIFrame(body, 0, 1);
    expect(frame[0]).toBe(0x68);
    expect(frame[1]).toBe(body.length + 4);
    expect(frame.length).toBe(body.length + 6);
  });
});

describe('IEC104 ASDU', () => {
  it('M_ME_NC 浮点遥测解码', () => {
    const asdu = encodeAsdu(TYPE.M_ME_NC, COT.RESPONSE_INTERROGATION, 7, [mMeNc(3, 220.5), mMeNc(4, 49.99)], 2);
    const d = decodeAsdu(asdu);
    expect(d?.typeId).toBe(13);
    expect(d?.cot).toBe(20);
    expect(d?.commonAddr).toBe(7);
    expect(d?.points).toHaveLength(2);
    expect(d?.points[0].ioa).toBe(3);
    expect(d?.points[0].value).toBeCloseTo(220.5, 3);
    expect(d?.points[1].ioa).toBe(4);
    expect(d?.points[1].value).toBeCloseTo(49.99, 3);
  });

  it('M_SP_NA 单点遥信解码（布尔）', () => {
    const asdu = encodeAsdu(TYPE.M_SP_NA, 20, 1, [mSp(1001, true), mSp(1002, false)], 2);
    const d = decodeAsdu(asdu);
    expect(d?.points).toHaveLength(2);
    expect(d?.points[0]).toMatchObject({ ioa: 1001, value: true });
    expect(d?.points[1]).toMatchObject({ ioa: 1002, value: false });
  });

  it('C_IC_NA 总召唤 cot=6 qoi=20', () => {
    const d = decodeAsdu(cIc(COT.ACTIVATION, 1));
    expect(d?.typeId).toBe(100);
    expect(d?.cot).toBe(6);
    expect(d?.points).toHaveLength(1);
    expect(d?.points[0].ioa).toBe(0); // 总召唤 IOA=0
  });

  it('IOA 24 位编解码', () => {
    expect(ioa(0x123456)).toEqual(Buffer.from([0x56, 0x34, 0x12]));
  });
});

describe('IEC104 TCP 拆帧', () => {
  it('半帧与多帧粘连', () => {
    const a = encodeIFrame(cIc(COT.ACTIVATION, 1), 0, 0); // 16B
    const b = encodeIFrame(encodeAsdu(TYPE.M_ME_NC, 20, 1, [mMeNc(1, 1.5)]), 1, 0); // 22B
    const stream = Buffer.concat([a, b]);
    // 半帧投喂
    let r = splitFrames(stream.subarray(0, 10));
    expect(r.frames).toHaveLength(0);
    // 补齐
    r = splitFrames(Buffer.concat([r.rest, stream.subarray(10)]));
    expect(r.frames).toHaveLength(2);
    expect(decodeFrame(r.frames[0]).asdu?.cot).toBe(COT.ACTIVATION);
    expect(decodeFrame(r.frames[1]).asdu?.points[0].value).toBeCloseTo(1.5, 3);
  });

  it('非法头字节丢弃', () => {
    const junk = Buffer.from([0x69, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(splitFrames(junk).frames).toHaveLength(0);
    expect(splitFrames(junk).rest.length).toBe(6);
  });

  it('长度字段与帧尾一致（无尾零滞留）', () => {
    const f = encodeIFrame(encodeAsdu(TYPE.M_SP_NA, 20, 1, [mSp(1, true)], 1), 0, 0);
    const r = splitFrames(f);
    expect(r.frames).toHaveLength(1);
    expect(r.rest.length).toBe(0); // 回归：encodeIFrame 曾多 2B 导致滞留
  });
});
