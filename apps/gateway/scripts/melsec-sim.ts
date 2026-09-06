import net from 'node:net';

/**
 * 最小 MELSEC MC 3E 服务器模拟器（SLMP 二进制帧，TCP 直连无 TPKT/COTP）。
 * 软元件：D0=Int16 转速、D10/D11=Float 温度、M20=Bool 报警（位）。
 * 响应布局：[D0 00][net][pc][module 2][station][datalen 2][endcode 2][data...] —— 与驱动 onData 解析配对。
 */

const PORT = Number(process.env.MELSEC_SIM_PORT ?? 11021);
const D = Buffer.alloc(256 * 2);
const M = Buffer.alloc(64);
let tick = 0;

setInterval(() => {
  tick += 1;
  D.writeInt16BE(Math.round(1450 + Math.sin(tick / 7) * 80), 0);
  D.writeFloatBE(36.2 + Math.sin(tick / 6) * 1.4, 20);
  // M20 = 第 2 字节第 4 位
  if (tick % 30 < 5) M[2] |= 0x10;
  else M[2] &= 0xef;
}, 500);

function readWords(devCode: number, devNo: number, points: number): Buffer {
  const data = Buffer.alloc(points * 2);
  for (let i = 0; i < points; i += 1) {
    const no = devNo + i;
    let v = 0;
    if (devCode === 0xa8 && no * 2 + 2 <= D.length) v = D.readUInt16BE(no * 2);
    data.writeUInt16BE(v, i * 2);
  }
  return data;
}

function readBits(devCode: number, devNo: number, points: number): Buffer {
  const data = Buffer.alloc(Math.ceil(points / 2));
  if (devCode !== 0x90) return data;
  for (let i = 0; i < points; i += 1) {
    const on = (M[Math.floor((devNo + i) / 8)] & (1 << ((devNo + i) % 8))) !== 0;
    if (on) data[i >> 1] |= (i % 2 === 0) ? 0x01 : 0x10; // 首点低 4 位
  }
  return data;
}

function writeWords(devCode: number, devNo: number, points: number, data: Buffer): void {
  for (let i = 0; i < points; i += 1) {
    const no = devNo + i;
    if (devCode === 0xa8 && no * 2 + 2 <= D.length) {
      D[no * 2] = data[i * 2];
      D[no * 2 + 1] = data[i * 2 + 1];
    }
  }
}

function writeBits(devCode: number, devNo: number, points: number, data: Buffer): void {
  if (devCode !== 0x90) return;
  for (let i = 0; i < points; i += 1) {
    const bitAddr = devNo + i;
    const on = data[i] === 0x10; // 位写：每点 1 字节，ON=0x10
    const mask = 1 << (bitAddr % 8);
    if (on) M[Math.floor(bitAddr / 8)] |= mask;
    else M[Math.floor(bitAddr / 8)] &= ~mask;
  }
}

const server = net.createServer((socket) => {
  console.log('[melsec-sim] client connected');
  let rx = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 9) {
      if (rx[0] !== 0x50 || rx[1] !== 0x00) {
        console.log('[melsec-sim] 非 MC 帧，丢弃 1 字节');
        rx = rx.subarray(1);
        continue;
      }
      const dataLen = rx.readUInt16LE(7);
      const total = 9 + dataLen;
      if (rx.length < total) return;
      const frame = Buffer.from(rx.subarray(0, total));
      rx = rx.subarray(total);
      handleMc(frame);
    }
  });

  function handleMc(frame: Buffer): void {
    // 请求：[D0 00][net][pc][module 2][station][datalen 2][monitor 2][cmd 2][sub 2][dev 1][no 3][points 2][data...]
    const cmd = frame.readUInt16LE(11);
    const sub = frame.readUInt16LE(13);
    const devCode = frame[15];
    const devNo = frame.readUIntLE(16, 3);
    const points = frame.readUInt16LE(19);
    const monitor = frame.readUInt16LE(9);

    // 响应：9 字节头（datalen=2+data）+ endcode(2) + data
    const build = (data: Buffer): Buffer => {
      const resp = Buffer.alloc(11 + data.length);
      resp[0] = 0xd0; resp[1] = 0x00;
      resp[2] = 0x00; resp[3] = 0xff;
      resp[4] = 0x03; resp[5] = 0xff; resp[6] = 0x00;
      resp.writeUInt16LE(2 + data.length, 7);
      resp.writeUInt16LE(0x0000, 9); // end code OK
      data.copy(resp, 11);
      return resp;
    };

    let data = Buffer.alloc(0);
    if (cmd === 0x0401 && sub === 0x0000) data = readWords(devCode, devNo, points);
    else if (cmd === 0x0401 && sub === 0x0001) data = readBits(devCode, devNo, points);
    else if (cmd === 0x1401 && sub === 0x0000) writeWords(devCode, devNo, points, frame.subarray(21));
    else if (cmd === 0x1401 && sub === 0x0001) writeBits(devCode, devNo, points, frame.subarray(21));
    else {
      console.log('[melsec-sim] unsupported cmd', cmd.toString(16));
      return;
    }
    void monitor;
    socket.write(build(data));
  }

  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[melsec-sim] MC 3E listening on 127.0.0.1:${PORT} (D/M 软元件)`);
});
