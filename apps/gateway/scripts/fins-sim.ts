import net from 'node:net';

/**
 * 最小 Omron FINS/TCP 服务器模拟器。
 * 帧封装：'FINS' + len(BE32, = cmd+reserved+error+FINS帧) +
 * command(4B=0x00000002) + error(4B=0) + FINS帧
 * FINS 帧头 10B：ICF RSV GCT DNA DA1 DA2 SNA SA1 SA2 SID；随后 MRC SRC …
 * 支持：内存区字读/写（DM=0x82 / CIO=0xB0）、CIO 位读/写。
 * 软元件（与 fins 驱动种子对齐）：D100/D101=Float 温度（BE 合成）、D110=UInt16 焊接计数。
 */

const PORT = Number(process.env.FINS_SIM_PORT ?? 19600);
const DM = Buffer.alloc(200 * 2);
let tick = 0;

setInterval(() => {
  tick += 1;
  // D100/D101 = Float 温度（BE）
  DM.writeFloatBE(45 + Math.sin(tick / 8) * 6, 100 * 2);
  // D110 = UInt16 计数
  DM.writeUInt16BE(1200 + (tick % 400), 110 * 2);
}, 500);

function areaCode(addr: string): number {
  const t = addr[0].toUpperCase();
  return t === 'D' ? 0x82 : t === 'C' ? 0xb0 : t === 'W' ? 0xb1 : 0x82;
}

const server = net.createServer((socket) => {
  console.log('[fins-sim] client connected');
  let rx = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 16) {
      if (rx.toString('ascii', 0, 4) !== 'FINS') {
        console.log('[fins-sim] 非 FINS 帧，丢弃 1 字节');
        rx = rx.subarray(1);
        continue;
      }
      const tcpLen = rx.readUInt32BE(4);
      const total = 8 + tcpLen;
      if (rx.length < total) return;
      const frame = Buffer.from(rx.subarray(0, total));
      rx = rx.subarray(total);

      // FINS 帧（自偏移 16）：ICF..SID(10) + MRC(10) SRC(11) ...
      const fins = frame.subarray(16);
      const mrc = fins[10];
      const src = fins[11];
      const sid = fins[9];

      if (mrc !== 0x01) {
        console.log('[fins-sim] unsupported MRC', mrc.toString(16));
        return;
      }

      // 响应 FINS 帧：ICF(0xC0) RSV GCT DNA DA1 DA2 SNA SA1 SA2 SID + MRC SRC + endcode(2) + data
      const respHead = Buffer.from([0xc0, 0x00, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, sid]);
      const respMeta = Buffer.from([0x01, src]); // MRC/SRC 应答（读=01）

      if (src === 0x01 && mrc === 0x01) {
        // 字读：area(12) addr(13..14) count(15..16)
        const area = fins[12];
        const word = fins.readUInt16BE(13);
        const count = fins.readUInt16BE(15);
        const data = Buffer.alloc(count * 2);
        for (let i = 0; i < count; i += 1) {
          const idx = (word + i) * 2;
          if (area === 0x82 && idx + 2 <= DM.length) data.writeUInt16BE(DM.readUInt16BE(idx), i * 2);
        }
        const resp = Buffer.concat([respHead, respMeta, Buffer.from([0x00, 0x00]), data]);
        const tcp = Buffer.alloc(8);
        tcp.write('FINS', 0, 'ascii');
        tcp.writeUInt32BE(8 + resp.length, 4);
        const prefix = Buffer.alloc(8);
        prefix.writeUInt32BE(0x00000002, 0);
        socket.write(Buffer.concat([tcp, prefix, resp]));
        console.log(`[fins-sim] word read D${word} x${count}`);
      } else if (src === 0x02 && mrc === 0x01) {
        // 字写：area(12) addr(13..14) count(15..16) data(17..)
        const area = fins[12];
        const word = fins.readUInt16BE(13);
        const count = fins.readUInt16BE(15);
        for (let i = 0; i < count; i += 1) {
          const idx = (word + i) * 2;
          if (area === 0x82 && idx + 2 <= DM.length) {
            DM[idx] = fins[18 + i * 2];
            DM[idx + 1] = fins[19 + i * 2];
          }
        }
        const resp = Buffer.concat([respHead, respMeta, Buffer.from([0x00, 0x00])]);
        const tcp = Buffer.alloc(8);
        tcp.write('FINS', 0, 'ascii');
        tcp.writeUInt32BE(8 + resp.length, 4);
        const prefix = Buffer.alloc(8);
        prefix.writeUInt32BE(0x00000002, 0);
        socket.write(Buffer.concat([tcp, prefix, resp]));
        console.log(`[fins-sim] word write D${word} x${count}`);
      } else {
        console.log('[fins-sim] unsupported MRC/SRC', mrc.toString(16), src.toString(16));
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fins-sim] FINS/TCP listening on 127.0.0.1:${PORT} (DM 区)`);
});
