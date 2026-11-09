import net from 'node:net';
import {
  U, TYPE, COT, splitFrames, decodeFrame, encodeIFrame, encodeSFrame, encodeAsdu, ioa, mSp, mMeNc, cIc,
} from './iec104-codec';

/**
 * IEC 60870-5-104 站端模拟器（配电自动化 RTU 风格）：
 * 监听 TCP：STARTDT 握手 → 响应总召唤（激活确认 + 单点遥信 M_SP + 浮点遥测 M_ME_NC + 激活终止）。
 * 遥测 IOA 1-4（动态模拟量），遥信 IOA 1001-1004（动态开关量，每 15s 翻转一次）。
 * 默认端口 2404。启动：pnpm --filter @iotconnector/gateway iec104-sim
 */

const PORT = Number(process.env.IEC104_SIM_PORT ?? 2404);
const COMMON = 1; // 公共地址（站地址）

const telemetry = () => [
  { ioa: 1, name: 'Ua 母线电压', value: 10500 + Math.round(Math.sin(Date.now() / 5000) * 300) }, // kV*100
  { ioa: 2, name: 'Ia 母线电流', value: 320 + (Math.floor(Date.now() / 10000) % 40) },
  { ioa: 3, name: '有功功率', value: 8600 + Math.round(Math.sin(Date.now() / 9000) * 500) },
  { ioa: 4, name: '频率', value: 50 + Math.sin(Date.now() / 4000) * 0.2 },
];
const telemetryFloat = () => [
  { ioa: 1, name: 'Ua 电压(kV)', value: 10.5 + Math.sin(Date.now() / 5000) * 0.3 },
  { ioa: 2, name: 'Ia 电流(A)', value: 320 + (Math.floor(Date.now() / 10000) % 40) },
  { ioa: 3, name: '有功(MW)', value: 8.6 + Math.sin(Date.now() / 9000) * 0.5 },
  { ioa: 4, name: '频率(Hz)', value: 50 + Math.sin(Date.now() / 4000) * 0.2 },
];
const telemetrySignals = () => [
  { ioa: 1001, name: '断路器 1 合位', value: Math.floor(Date.now() / 15000) % 2 === 0 },
  { ioa: 1002, name: '断路器 2 合位', value: Math.floor(Date.now() / 20000) % 2 === 0 },
  { ioa: 1003, name: '保护动作', value: Math.floor(Date.now() / 60000) % 30 === 0 },
  { ioa: 1004, name: '就地/远方', value: true },
];

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  const who = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[iec104-sim] 连接 ${who}`);
  let started = false;
  let acc = Buffer.alloc(0);

  const send = (b: Buffer): void => {
    console.log(`[iec104-sim] TX ${b.length}B: ${b.toString('hex').slice(0, 40)}`);
    socket.write(b);
  };

  socket.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const { frames, rest } = splitFrames(acc);
    acc = rest;
    for (const frame of frames) {
      const parsed = decodeFrame(frame);
      switch (parsed.kind) {
        case 'u-startdt-act': {
          started = true;
          send(U.STARTDT_CON);
          console.log(`[iec104-sim] STARTDT 激活确认 (${who})`);
          break;
        }
        case 'u-testfr-act':
          send(U.TESTFR_CON);
          break;
        case 'u-stopdt-act':
          started = false;
          send(U.STOPDT_CON);
          break;
        case 'i': {
          if (!parsed.asdu) break;
          const { typeId, cot } = parsed.asdu;
          // 总召唤激活 → 确认 + 数据 + 终止
          if (typeId === TYPE.C_IC_NA && cot === COT.ACTIVATION) {
            send(encodeIFrame(cIc(COT.ACTIVATION_CONFIRM, COMMON), 0, parsed.sendSeq! + 1));
            // 遥测（每点独立 VSQ=1，浮点）
            for (const t of telemetryFloat()) {
              send(encodeIFrame(encodeAsdu(TYPE.M_ME_NC, COT.RESPONSE_INTERROGATION, COMMON, [mMeNc(t.ioa, t.value)]), 0, parsed.sendSeq! + 1));
            }
            // 遥信
            const sps = telemetrySignals().map((s) => mSp(s.ioa, s.value));
            // 拆包：每 8 点一帧（VSQ≤127）
            for (let i = 0; i < sps.length; i += 8) {
              const chunk2 = sps.slice(i, i + 8);
              send(encodeIFrame(encodeAsdu(TYPE.M_SP_NA, COT.RESPONSE_INTERROGATION, COMMON, chunk2, chunk2.length), 0, parsed.sendSeq! + 1));
            }
            // 激活终止
            send(encodeIFrame(cIc(COT.ACTIVATION_TERMINATION, COMMON), 0, parsed.sendSeq! + 1));
            console.log(`[iec104-sim] 总召唤响应完成 (${who})`);
          }
          break;
        }
        default:
          break;
      }
    }
  });

  socket.on('close', () => console.log(`[iec104-sim] 断开 ${who}`));
  socket.on('error', () => undefined);
});

server.listen(PORT, () => {
  console.log(`[iec104-sim] 监听 tcp/${PORT}（站地址 ${COMMON}）`);
  console.log('[iec104-sim] 遥测 IOA 1-4（浮点）、遥信 IOA 1001-1004（开关量，周期翻转）');
});
