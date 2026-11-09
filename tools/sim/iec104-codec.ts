/**
 * IEC 60870-5-104 最小协议编解码（零依赖，手写）：
 *  - APCI 帧：I（信息，32 位序号小端）、S（确认 0x01）、U（STARTDT/STOPDT/TESTFR）
 *  - ASDU：typeId | VSQ | COT(2,LE) | CA(2,LE) | IOA(3,LE) + 数据
 * 覆盖类型：M_SP_NA_1(1 单点遥信)、M_ME_NC_1(13 浮点遥测)、C_IC_NA_1(100 总召唤)
 */

// ===== 常量 =====
export const FRAME_START = 0x68;
export const COT = {
  PERIODIC: 1, BACKGROUND: 2, SPONTANEOUS: 3, ACTIVATION: 6, ACTIVATION_CONFIRM: 7,
  DEACTIVATION: 8, DEACTIVATION_CONFIRM: 9, ACTIVATION_TERMINATION: 10, RESPONSE_INTERROGATION: 20,
} as const;

export const TYPE = { M_SP_NA: 1, M_ME_NC: 13, C_IC_NA: 100 } as const;

// ===== U 帧 =====
export const U = {
  STARTDT_ACT: Buffer.from([0x68, 0x04, 0x07, 0x00, 0x00, 0x00]),
  STARTDT_CON: Buffer.from([0x68, 0x04, 0x0b, 0x00, 0x00, 0x00]),
  STOPDT_ACT: Buffer.from([0x68, 0x04, 0x13, 0x00, 0x00, 0x00]),
  STOPDT_CON: Buffer.from([0x68, 0x04, 0x23, 0x00, 0x00, 0x00]),
  TESTFR_ACT: Buffer.from([0x68, 0x04, 0x43, 0x00, 0x00, 0x00]),
  TESTFR_CON: Buffer.from([0x68, 0x04, 0x83, 0x00, 0x00, 0x00]),
} as const;

export type FrameKind = 'i' | 's' | 'u-startdt-act' | 'u-startdt-con' | 'u-stopdt-act' | 'u-stopdt-con' | 'u-testfr-act' | 'u-testfr-con' | 'unknown';

export interface ParsedFrame {
  kind: FrameKind;
  /** I 帧：发送/接收序号 */
  sendSeq?: number;
  recvSeq?: number;
  /** I 帧 ASDU 字段 */
  asdu?: {
    typeId: number;
    cot: number;
    commonAddr: number;
    /** 信息对象：IOA → { value: number | boolean; hasQuality?: boolean }（按类型解析） */
    points: Array<{ ioa: number; value: number | boolean; qds: number }>;
  };
}

/** 解析单帧（帧长已知） */
export function decodeFrame(buf: Buffer): ParsedFrame {
  if (buf.length < 6 || buf[0] !== FRAME_START) return { kind: 'unknown' };
  const c0 = buf[2];
  if ((c0 & 0x03) === 0x03) {
    // U 帧：低 2 位 = 11
    if (c0 === 0x07) return { kind: 'u-startdt-act' };
    if (c0 === 0x0b) return { kind: 'u-startdt-con' };
    if (c0 === 0x13) return { kind: 'u-stopdt-act' };
    if (c0 === 0x23) return { kind: 'u-stopdt-con' };
    if (c0 === 0x43) return { kind: 'u-testfr-act' };
    if (c0 === 0x83) return { kind: 'u-testfr-con' };
    return { kind: 'unknown' };
  }
  if ((c0 & 0x03) === 0x01) {
    // S 帧：字节2=0x01 标志；接收序号在字节4-5（小端，bit0 恒 0）
    const recvSeq = ((buf[5] << 7) | (buf[4] >> 1)) & 0x7fff;
    return { kind: 's', recvSeq };
  }
  // I 帧
  const sendSeq = ((buf[3] << 7) | (buf[2] >> 1)) & 0x7fff;
  const recvSeq = ((buf[5] << 7) | (buf[4] >> 1)) & 0x7fff;
  const asduBuf = buf.subarray(6);
  if (asduBuf.length < 6) return { kind: 'i', sendSeq, recvSeq };
  return {
    kind: 'i',
    sendSeq,
    recvSeq,
    asdu: decodeAsdu(asduBuf),
  };
}

/** 解析 ASDU：typeId(1) VSQ(1) COT(2 LE) CA(2 LE) + 对象序列 */
export function decodeAsdu(b: Buffer): ParsedFrame['asdu'] {
  const typeId = b[0];
  const vsq = b[1];
  const cot = b[2] | (b[3] << 8);
  const commonAddr = b[4] | (b[5] << 8);
  const count = vsq & 0x7f; // VSQ 高位置 1 表示连续地址（本实现按独立地址解析）
  const points: ParsedFrame['asdu'] = { typeId, cot, commonAddr, points: [] };
  let o = 6;
  for (let i = 0; i < count && o < b.length; i += 1) {
    const ioa = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    o += 3;
    if (typeId === TYPE.M_SP_NA) {
      const siq = b[o++];
      points.points.push({ ioa, value: (siq & 0x01) === 1, qds: siq });
    } else if (typeId === TYPE.M_ME_NC) {
      const value = b.readFloatLE(o);
      const qds = b[o + 4];
      o += 5;
      points.points.push({ ioa, value, qds });
    } else if (typeId === TYPE.C_IC_NA) {
      const qoi = o < b.length ? b[o] : 20;
      o += 1;
      points.points.push({ ioa, value: true, qds: qoi });
    } else {
      break; // 未知类型跳过整帧数据
    }
  }
  return points;
}

// ===== 编码 =====

/** I 帧封装（ASDU 已组好）：0x68 len(=ASDU+4 控制域) + 控制域 4B + ASDU，总长 = 6 + ASDU */
export function encodeIFrame(asduBody: Buffer, sendSeq: number, recvSeq: number): Buffer {
  const frame = Buffer.alloc(asduBody.length + 6);
  frame[0] = FRAME_START;
  frame[1] = asduBody.length + 4;
  frame[2] = (sendSeq << 1) & 0xff;
  frame[3] = (sendSeq >> 7) & 0xff;
  frame[4] = (recvSeq << 1) & 0xff;
  frame[5] = (recvSeq >> 7) & 0xff;
  asduBody.copy(frame, 6);
  return frame;
}

export function encodeSFrame(recvSeq: number): Buffer {
  const f = Buffer.alloc(6);
  f[0] = FRAME_START;
  f[1] = 0x04;
  f[2] = 0x01;
  f[4] = (recvSeq << 1) & 0xff;
  f[5] = (recvSeq >> 7) & 0xff;
  return f;
}

/** 通用 ASDU 头 + 对象数据（objects 为 IOA+payload 字节） */
export function encodeAsdu(typeId: number, cot: number, commonAddr: number, objects: Buffer[], vsq = 1): Buffer {
  const body = Buffer.alloc(6 + objects.reduce((n, b) => n + b.length, 0));
  body[0] = typeId;
  body[1] = vsq & 0x7f;
  body[2] = cot & 0xff;
  body[3] = (cot >> 8) & 0xff;
  body[4] = commonAddr & 0xff;
  body[5] = (commonAddr >> 8) & 0xff;
  let o = 6;
  for (const obj of objects) {
    obj.copy(body, o);
    o += obj.length;
  }
  return body;
}

/** IOA(3 LE) */
export function ioa(ioa: number): Buffer {
  return Buffer.from([ioa & 0xff, (ioa >> 8) & 0xff, (ioa >> 16) & 0xff]);
}

/** M_SP_NA 单点遥信：IOA + SIQ */
export function mSp(ioaVal: number, value: boolean): Buffer {
  return Buffer.concat([ioa(ioaVal), Buffer.from([value ? 0x01 : 0x00])]);
}

/** M_ME_NC 浮点遥测：IOA + float32(LE) + QDS */
export function mMeNc(ioaVal: number, value: number, quality = 0): Buffer {
  const b = Buffer.alloc(8);
  b.writeUIntLE(ioaVal, 0, 3);
  b.writeFloatLE(value, 3);
  b[7] = quality;
  return b;
}

/** C_IC_NA 总召唤：IOA=0 + QOI(20) */
export function cIc(cot: number, commonAddr: number): Buffer {
  return encodeAsdu(TYPE.C_IC_NA, cot, commonAddr, [Buffer.concat([ioa(0), Buffer.from([20])])]);
}

/** TCP 流拆帧：返回完整帧数组与剩余缓冲 */
export function splitFrames(acc: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let rest = acc;
  for (;;) {
    if (rest.length < 2 || rest[0] !== FRAME_START) break;
    const len = rest[1];
    if (rest.length < len + 2) break;
    frames.push(rest.subarray(0, len + 2));
    rest = rest.subarray(len + 2);
  }
  return { frames, rest };
}
