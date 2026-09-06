import net from 'node:net';

/**
 * 最小 S7comm 服务器模拟器（TPKT + COTP + S7）。
 * 支持：COTP CR/CC 握手、S7 通讯建立（0xF0）、读 Var（0x04）、写 Var（0x05）。
 * 虚拟 DB301 与网关种子配置 s7-01 的位号对齐：
 *   DB301.Real10 = pH        DB301.Real14 = Temperature
 *   DB301.Real18 = Pressure  DB301.DBX20.0 = alm1
 * 与 Modbus 模拟器同思路：真实协议字节流往返，验证驱动与链路。
 */

const PORT = Number(process.env.S7_SIM_PORT ?? 10102); // 真机为 102，Windows 下改用高位端口

const db301 = Buffer.alloc(64);
let tick = 0;

setInterval(() => {
  tick += 1;
  db301.writeFloatBE(7.2 + Math.sin(tick / 9) * 0.35, 10);
  db301.writeFloatBE(35.5 + Math.sin(tick / 7) * 1.2, 14);
  db301.writeFloatBE(1.2 + Math.sin(tick / 11) * 0.25, 18);
  db301[20] = tick % 40 < 4 ? db301[20] | 0x01 : db301[20] & 0xfe;
}, 500);

// 完整 COTP CC：nodes7 要求帧长 ≥22 字节（含 TSAP 参数回显）
const COTP_CC = Buffer.from([
  0x03, 0x00, 0x00, 0x16,
  0x11, 0xd0, 0x00, 0x00, 0x00, 0x02, 0x00, 0xc0, 0x01, 0x0a,
  0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x02,
]);

/** Ack_Data 帧：TPKT + COTP(DT,0x80) + S7 头(12B) + param + data */
function ackData(pduRef: number, param: Buffer, data: Buffer): Buffer {
  const paramLen = param.length;
  const dataLen = data.length;
  const total = 4 + 3 + 12 + paramLen + dataLen;
  const b = Buffer.alloc(total);
  b.writeUInt16BE(total, 2);
  b[4] = 0x02; // COTP length
  b[5] = 0xf0; // DT Data
  b[6] = 0x80; // EOT
  b[7] = 0x32; // S7 magic
  b[8] = 0x03; // Ack_Data
  b.writeUInt16BE(pduRef, 11);
  b.writeUInt16BE(paramLen, 13);
  b.writeUInt16BE(dataLen, 15);
  // 17/18 = errorClass/errorCode = 0
  param.copy(b, 19);
  if (dataLen > 0) data.copy(b, 19 + paramLen);
  return b;
}

interface ReadItemSpec {
  transportSpec: number; // 0x02 = BYTE/WORD/DWORD, 0x01 = BIT
  byteCount: number;
  dbNumber: number;
  byteAddr: number;
  bit: number;
}

function parseReadItems(param: Buffer): ReadItemSpec[] {
  const items: ReadItemSpec[] = [];
  const count = param[1];
  let off = 2;
  for (let i = 0; i < count; i += 1) {
    if (off + 12 > param.length) break;
    const transportSpec = param[off + 3];
    const byteCount = param.readUInt16BE(off + 4);
    const dbNumber = param.readUInt16BE(off + 6);
    // 面积码单独 1 字节，地址为后续 3 字节大端（byteAddr*8 + bit）
    const byteAddr = (param[off + 9] << 16) | (param[off + 10] << 8) | param[off + 11];
    items.push({ transportSpec, byteCount, dbNumber, byteAddr: byteAddr >>> 3, bit: byteAddr & 7 });
    off += 12;
  }
  return items;
}

function readDbBytes(db: Buffer, spec: ReadItemSpec): { code: number; bytes?: Buffer } {
  if (spec.dbNumber !== 301) return { code: 0x05 }; // addr out of range in this sim
  if (spec.byteAddr + spec.byteCount > db.length) return { code: 0x05 };
  return { code: 0xff, bytes: Buffer.from(db.subarray(spec.byteAddr, spec.byteAddr + spec.byteCount)) };
}

const server = net.createServer((socket) => {
  console.log('[s7-sim] client connected');
  let rx = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 4) {
      if (rx[0] !== 0x03) {
        console.log('[s7-sim] bad TPKT magic, dropping buffer');
        rx = Buffer.alloc(0);
        return;
      }
      const total = rx.readUInt16BE(2);
      if (rx.length < total) return;
      const frame = Buffer.from(rx.subarray(0, total));
      rx = rx.subarray(total);
      try {
        handleFrame(frame);
      } catch (e) {
        console.error('[s7-sim] handleFrame exception:', e, 'frame:', frame.toString('hex'));
      }
    }
  });

  function handleFrame(frame: Buffer): void {
    console.log('[s7-sim] frame:', frame.toString('hex'));
    // COTP Connection Request (CR, 0xe0) → CC
    if (frame[5] === 0xe0) {
      console.log('[s7-sim] reply COTP CC');
      socket.write(COTP_CC);
      return;
    }
    if (frame[7] !== 0x32) return;
    const msgType = frame[8];
    if (msgType !== 0x01) return; // 仅处理 Job
    // Job 帧的 S7 头为 10 字节（无 error 字节），参数从偏移 17 开始；
    // Ack_Data 头为 12 字节（多 errorClass/errorCode），参数从 19 开始。
    const pduRef = frame.readUInt16BE(11);
    const paramLen = frame.readUInt16BE(13);
    const param = frame.subarray(17, 17 + paramLen);
    const fn = param[0];
    console.log('[s7-sim] S7 job fn=0x' + fn.toString(16) + ' pduRef=' + pduRef + ' paramLen=' + paramLen);

    const send = (resp: Buffer): void => {
      console.log('[s7-sim] reply:', resp.toString('hex'));
      socket.write(resp);
    };

    if (fn === 0xf0) {
      // 通讯建立：param = fn, res, maxAmQCaller(2), maxAmQCallee(2), pdu(2)
      const resp = Buffer.from([0xf0, 0x00, 0x00, 0x03, 0x00, 0x03, 0x01, 0xe0]);
      send(ackData(pduRef, resp, Buffer.alloc(0)));
      return;
    }

    if (fn === 0x04) {
      // 读 Var
      const items = parseReadItems(param);
      const dataChunks: Buffer[] = [];
      for (const item of items) {
        const result = item.dbNumber === 301 ? readDbBytes(db301, item) : { code: 0x05 };
        if (result.bytes) {
          const dataItem = Buffer.alloc(4 + result.bytes.length);
          dataItem[0] = 0xff;
          dataItem[1] = 0x04; // transport code（nodes7 校验须为 0x04）
          dataItem.writeUInt16BE(result.bytes.length * 8, 2); // 长度按位
          result.bytes.copy(dataItem, 4);
          dataChunks.push(dataItem);
        } else {
          dataChunks.push(Buffer.from([result.code, 0x00, 0x00, 0x00]));
        }
      }
      const respParam = Buffer.from([0x04, items.length]);
      send(ackData(pduRef, respParam, Buffer.concat(dataChunks)));
      return;
    }

    if (fn === 0x05) {
      // 写 Var：param = fn,count,items(12B each)；data = 每项 [ret, transport, lenBits u16, bytes]
      const itemCount = param[1];
      let itemOff = 2;
      let dataOff = 17 + paramLen; // Job 帧数据区从 17 + paramLen 开始
      const retCodes: number[] = [];
      for (let i = 0; i < itemCount; i += 1) {
        if (itemOff + 12 > param.length || dataOff + 4 > frame.length) {
          retCodes.push(0x05);
          break;
        }
        const transportSpec = param[itemOff + 3];
        const dbNumber = param.readUInt16BE(itemOff + 6);
        const addr24 = (param[itemOff + 9] << 16) | (param[itemOff + 10] << 8) | param[itemOff + 11];
        const byteAddr = addr24 >>> 3;
        const bit = addr24 & 7;

        const transport = frame[dataOff + 1];
        const lenBits = frame.readUInt16BE(dataOff + 2);
        const byteCount = transport === 0x03 ? 1 : lenBits / 8;
        if (dataOff + 4 + byteCount > frame.length) {
          retCodes.push(0x05);
          break;
        }
        const value = frame.subarray(dataOff + 4, dataOff + 4 + byteCount);

        if (dbNumber === 301 && byteAddr + byteCount <= db301.length) {
          if (transportSpec === 0x01) {
            if (value[0] & 0x01) db301[byteAddr] |= 1 << bit;
            else db301[byteAddr] &= ~(1 << bit);
          } else {
            value.copy(db301, byteAddr);
          }
          retCodes.push(0xff);
        } else {
          retCodes.push(0x05);
        }
        itemOff += 12;
        dataOff += 4 + byteCount + (byteCount % 2); // 奇数字节补 1 填充
      }
      const respParam = Buffer.from([0x05, retCodes.length]);
      send(ackData(pduRef, respParam, Buffer.from(retCodes)));
      return;
    }

    // 未知功能码：ServiceFault
    socket.write(ackData(pduRef, Buffer.from([0x81]), Buffer.from([0x08, 0x00, 0x00, 0x00])));
  }

  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[s7-sim] listening on 127.0.0.1:${PORT} (rack 0, slot 1, virtual DB301)`);
});
