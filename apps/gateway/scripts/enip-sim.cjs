// 最小 EtherNet/IP 模拟器 (CJS, 零依赖)
// 支持 Register Session + SendRRData(Unconnected Send 包装的 Symbolic Read/Write Tag)
const net = require('net');

const TAGS = {
  'Line1.ConveyorSpeed': { type: 0xc3, size: 2, value: 320 }, // INT
  'Line1.Temperature': { type: 0xca, size: 4, value: 42.5 }, // REAL
};
setInterval(() => {
  TAGS['Line1.ConveyorSpeed'].value = 300 + Math.round(Math.random() * 60);
  TAGS['Line1.Temperature'].value = Math.round((40 + Math.random() * 5) * 10) / 10;
}, 2000);

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** SendRRData 响应体：iface + timeout + itemCount + addrItem + dataItem(payload) */
function rrDataBody(payload) {
  return Buffer.concat([
    u32(0), u16(0), u16(2), // iface / timeout / itemCount
    u16(0xa1), u16(4), u32(1), // addr item: connected transport
    u16(0xb1), u16(payload.length), payload, // data item
  ]);
}

/** Unconnected Send 响应包装：[0xCC][genStatus][embLen][embedded][pad] */
function unconnectedResp(embedded) {
  const pad = embedded.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0xcc, 0x00]), u16(embedded.length), embedded, pad]);
}

/** 从 IOI 提取符号名：[0x91][len][name][pad?] */
function ioiName(ioi) {
  if (ioi[0] !== 0x91) return null;
  const len = ioi[1];
  return ioi.toString('ascii', 2, 2 + len);
}

net.createServer((sock) => {
  console.log('[enip-sim] conn');
  let session = 0;
  let rx = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 24) {
      const total = 24 + rx.readUInt16LE(2);
      if (rx.length < total) break;
      const frame = Buffer.from(rx.subarray(0, total));
      rx = rx.subarray(total);
      try { handle(frame); } catch (e) { console.error('[enip-sim] handle error:', e); }
    }
  });
  sock.on('error', () => {});

  function handle(frame) {
    const cmd = frame.readUInt16LE(0);
    if (cmd === 0x0065) {
      session = 0x12345678;
      // body = protocol version u16 + option flags u16
      const r = Buffer.concat([u16(0x0065), u16(4), u32(session), u32(0), Buffer.alloc(12), u16(1), u16(0)]);
      sock.write(r);
      console.log('[enip-sim] RegisterSession ok, session=' + session.toString(16));
      return;
    }
    if (cmd !== 0x006f) return;

    // SendRRData 请求：24 头 + iface(4) + timeout(2) + itemCount(2) + items...
    let p = 24 + 6;
    const itemCount = frame.readUInt16LE(p); p += 2;
    let payload = null;
    for (let i = 0; i < itemCount; i += 1) {
      const type = frame.readUInt16LE(p); p += 2;
      const len = frame.readUInt16LE(p); p += 2;
      if (type === 0xb1) payload = frame.subarray(p, p + len);
      p += len;
    }
    if (!payload) { console.log('[enip-sim] no data item'); return; }

    // Unconnected Send 请求：[0x4C][msgLen u16][embedded][route][pad]；兼容裸 0x4E/0x4D
    let embedded = payload;
    let service = payload[0];
    if (service === 0x4c) {
      const msgLen = payload.readUInt16LE(1);
      embedded = payload.subarray(3, 3 + msgLen);
      service = embedded[0];
    }
    const pathSize = embedded[1];
    const ioi = embedded.subarray(2, 2 + pathSize * 2);
    const name = ioiName(ioi);
    if (!name) { console.log('[enip-sim] unsupported IOI'); return; }

    let embResp;
    if (service === 0x4e) {
      const tag = TAGS[name];
      const type = tag ? tag.type : 0xc3;
      const valueBytes = Buffer.alloc(tag ? tag.size : 2);
      if (tag) {
        if (tag.type === 0xca) valueBytes.writeFloatLE(tag.value, 0);
        else valueBytes.writeInt16LE(tag.value, 0);
      }
      embResp = Buffer.concat([Buffer.from([0xce, 0x00]), u16(type), valueBytes]);
      console.log(`[enip-sim] READ ${name} -> ${tag ? tag.value : '??'}`);
    } else if (service === 0x4d) {
      // Write：IOI 后跟 [type u16][value bytes]
      const valOff = 2 + pathSize * 2;
      const type = embedded.readUInt16LE(valOff);
      const vb = embedded.subarray(valOff + 2);
      if (TAGS[name]) {
        TAGS[name].value = type === 0xca ? vb.readFloatLE(0) : vb.readInt16LE(0);
      }
      embResp = Buffer.from([0xcd, 0x00]);
      console.log(`[enip-sim] WRITE ${name} type=0x${type.toString(16)} -> ${TAGS[name] ? TAGS[name].value : '??'}`);
    } else {
      embResp = Buffer.from([service | 0x80, 0x08]); // 不支持的服务
      console.log(`[enip-sim] unsupported service 0x${service.toString(16)}`);
    }

    const body = rrDataBody(unconnectedResp(embResp));
    const resp = Buffer.concat([u16(0x006f), u16(body.length), u32(session), u32(0), Buffer.alloc(12), body]);
    sock.write(resp);
  }
}).listen(14448, '127.0.0.1', () => console.log('[enip-sim] listening on 14448'));
