import net from 'node:net';

/**
 * 最小 Modbus TCP 从站模拟器（仅 FC03 读保持寄存器 / FC06 写单寄存器）。
 * 寄存器映射（与 gateway 种子配置 mb-01 对齐，1-based 4x 区）：
 *   40001: Motor Speed (Int16, RPM，带波动)
 *   40002: Running Status (Int16, 1=Running)
 *   40003-40004: Inverter Current ×10 (Float, CDAB 字序，工程值 = raw/10)
 */

const PORT = Number(process.env.MODBUS_SIM_PORT ?? 15020); // 1502 在 Windows 常被系统保留（EACCES）

const holding = Buffer.alloc(1000 * 2); // 1000 个保持寄存器
let tick = 0;

function writeFloatCDAB(buf: Buffer, regIndex: number, v: number): void {
  const tmp = Buffer.alloc(4);
  tmp.writeFloatBE(v);
  // 逻辑字节序 ABCD → 线序 CDAB：低字在前
  buf[regIndex * 2] = tmp[2];
  buf[regIndex * 2 + 1] = tmp[3];
  buf[regIndex * 2 + 2] = tmp[0];
  buf[regIndex * 2 + 3] = tmp[1];
}

setInterval(() => {
  tick += 1;
  const speed = Math.round(1200 + Math.sin(tick / 8) * 60 + (Math.random() - 0.5) * 10);
  holding.writeInt16BE(speed, 0);
  holding.writeInt16BE(1, 2);
  writeFloatCDAB(holding, 2, (24.8 + Math.sin(tick / 12) * 1.5) * 10);
}, 500);

const server = net.createServer((socket) => {
  console.log('[modbus-sim] client connected');
  socket.on('data', (chunk: Buffer) => {
    if (chunk.length < 8) return;
    const tid = chunk.readUInt16BE(0);
    const uid = chunk.readUInt8(6);
    const fc = chunk.readUInt8(7);

    if (fc === 3) {
      const start = chunk.readUInt16BE(8);
      const count = chunk.readUInt16BE(10);
      if (start + count > 1000) {
        socket.write(exception(tid, uid, fc, 2));
        return;
      }
      const byteCount = count * 2;
      const resp = Buffer.alloc(9 + byteCount);
      resp.writeUInt16BE(tid, 0);
      resp.writeUInt16BE(0, 2);
      resp.writeUInt16BE(3 + byteCount, 4);
      resp.writeUInt8(uid, 6);
      resp.writeUInt8(3, 7);
      resp.writeUInt8(byteCount, 8);
      holding.copy(resp, 9, start * 2, start * 2 + byteCount);
      socket.write(resp);
    } else if (fc === 6) {
      const reg = chunk.readUInt16BE(8);
      const val = chunk.readUInt16BE(10);
      holding.writeInt16BE(val, reg * 2);
      socket.write(chunk.subarray(0, 12)); // 原样回显请求
    } else {
      socket.write(exception(tid, uid, fc, 1));
    }
  });
  socket.on('error', () => {});
});

function exception(tid: number, uid: number, fc: number, code: number): Buffer {
  const resp = Buffer.alloc(9);
  resp.writeUInt16BE(tid, 0);
  resp.writeUInt16BE(0, 2);
  resp.writeUInt16BE(3, 4);
  resp.writeUInt8(uid, 6);
  resp.writeUInt8(fc | 0x80, 7);
  resp.writeUInt8(code, 8);
  return resp;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[modbus-sim] listening on 127.0.0.1:${PORT} (slave=1, FC03/FC06)`);
});
