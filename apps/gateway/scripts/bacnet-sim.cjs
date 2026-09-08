// BACnet/IP 最小设备模拟器（复用 bacstack 内部编解码）：
// 响应 ReadProperty / ReadPropertyMultiple（PresentValue, 对象 AI/AV/BI/BV）与
// WriteProperty（AV/BV 可写，写后读回）。
// 详见 README「BACnet 模拟器」。启动：pnpm --filter @iotconnector/gateway bacnet-sim
const dgram = require('node:dgram');
const Bacnet = require('bacstack');
const baAsn1 = require('bacstack/lib/asn1');
const baApdu = require('bacstack/lib/apdu');
const baServices = require('bacstack/lib/services');

const PORT = Number(process.env.BACNET_SIM_PORT ?? 47808);
const P_PRESENT_VALUE = 85;

// 对象库：AI:1 温度（动态）、AV:3 设定值（可写，初始 22.5）、BI:1 运行（动态布尔）、BV:2 报警（可写，初始 false）
const objects = new Map();
objects.set('0:1', { type: Bacnet.enum.ObjectType.ANALOG_INPUT, scalar: 'ai1', dataType: Bacnet.enum.ApplicationTags.REAL });
objects.set('2:3', { type: Bacnet.enum.ObjectType.ANALOG_VALUE, scalar: 'av3', dataType: Bacnet.enum.ApplicationTags.REAL, value: 22.5, writable: true });
objects.set('3:1', { type: Bacnet.enum.ObjectType.BINARY_INPUT, scalar: 'bi1', dataType: Bacnet.enum.ApplicationTags.BOOLEAN });
objects.set('5:2', { type: Bacnet.enum.ObjectType.BINARY_VALUE, scalar: 'bv2', dataType: Bacnet.enum.ApplicationTags.BOOLEAN, value: false, writable: true });

const state = { ai1: () => 23 + Math.round(Math.sin(Date.now() / 30000) * 4) * 0.1, bi1: () => Math.floor(Date.now() / 20000) % 2 === 0 };
const readValue = (key, obj) => (obj.scalar && state[obj.scalar] ? state[obj.scalar]() : obj.value);

const socket = dgram.createSocket('udp4');
socket.on('error', (e) => { console.error(`[bacnet-sim] ${e.message}`); process.exit(1); });
socket.on('message', (msg, rinfo) => {
  // BVLC(4) + NPDU(变长) → APDU：解析 NPDU 长度（DNET/DADR/SNET/SADR/hop）
  if (msg.length < 5 || msg[0] !== 0x81) return;
  let o = 4;
  const ctrl = msg[o];
  o += 1;
  if (ctrl & 0x20) { o += 3; o += msg[o - 1]; }
  if (ctrl & 0x10) { o += 2; const slen = msg[o]; o += 1 + slen; }
  if (ctrl & 0x08) o += 1;
  const apdu = msg.subarray(o);
  console.log(`[bacnet-sim] 收到 ${msg.length}B from ${rinfo.address}:${rinfo.port} npduLen=${o - 4} apdu0=${apdu[0].toString(16)}`);
  // 标准布局：type | invokeId | 0x00 | service | …（tester 与驱动均按此构造）
  if (apdu.length < 4) return;
  const invokeId = apdu[1];
  const service = apdu[3];
  const body = apdu.subarray(4);

  try {
    console.log(`[bacnet-sim] service=${service} invoke=${invokeId} body=${body.toString('hex')}`);
    if (service === 12) { // ReadProperty
      const req = baServices.readProperty.decode(body, 0, body.length);
      console.log('[bacnet-sim] decoded:', JSON.stringify(req));
      const key = `${req.objectId.type}:${req.objectId.instance}`;
      const obj = objects.get(key);
      if (!obj) { sendError(invokeId, service, rinfo, 31); return; } // UNKNOWN_OBJECT
      try { sendReadPropertyAck(invokeId, req.objectId, req.property, rinfo, obj); }
      catch (e2) { console.error('[bacnet-sim] Ack 异常:', e2.stack); }
    } else if (service === 14) { // ReadPropertyMultiple (BACnet service choice = 14)
      const req = baServices.readPropertyMultiple.decode(body, 0, body.length);
      const parts = [];
      for (const item of req.properties) {
        const obj = objects.get(`${item.objectId.type}:${item.objectId.instance}`);
        if (!obj) continue;
        // ReadAccessResult: objectId ctx0 + open tag1 + 每属性(propId ctx2 + open tag4 + 值 + close4) + close1
        const buf = Buffer.alloc(8);
        buf.writeUInt32BE(((item.objectId.type & 0x3ff) << 22) | (item.objectId.instance & 0x3fffff), 0);
        parts.push(Buffer.from([0x0c]), buf.subarray(0, 4), Buffer.from([0x1e]));
        for (const prop of item.properties) {
          if (prop.id !== 85) continue; // 只应答 PresentValue
          parts.push(Buffer.from([0x29, 85])); // ctx2 enumerated 85
          const raw = readValue(`${item.objectId.type}:${item.objectId.instance}`, obj);
          // Bool 也以 REAL 0/1 返回：bacstack 的 RPM-Ack BOOLEAN 解码在 beta 版有缺陷，REAL 保证驱动稳定解析
          const v = Buffer.alloc(5);
          v[0] = 0x44;
          v.writeFloatBE(Number(raw) || 0, 1);
          parts.push(Buffer.from([0x4e]), v, Buffer.from([0x4f]));
        }
        parts.push(Buffer.from([0x1f]));
      }
      if (parts.length === 0) { sendError(invokeId, service, rinfo, 31); return; }
      sendApdu(invokeId, 5, Buffer.concat(parts), rinfo);
    } else if (service === 15) { // WriteProperty
      const req = baServices.writeProperty.decode(body, 0, body.length);
      const key = `${req.objectId.type}:${req.objectId.instance}`;
      const obj = objects.get(key);
      if (!obj || !obj.writable) { sendError(invokeId, service, rinfo, 31); return; }
      obj.value = req.values?.[0]?.value?.value ?? obj.value;
      sendSimpleAck(invokeId, service, rinfo);
    }
  } catch (e) {
    console.error(`[bacnet-sim] 处理失败: ${e.message}`);
  }
});

function readValueWrap(obj, key) { return readValue(key, obj); }

function sendReadPropertyAck(invokeId, objectId, propertyId, rinfo, obj) {
  const key = `${objectId.type}:${objectId.instance}`;
  const pid = typeof propertyId === 'number' ? propertyId : propertyId.id;
  const raw = readValue(key, obj);
  const buf = Buffer.alloc(8);
  let payload;
  if (obj.dataType === Bacnet.enum.ApplicationTags.BOOLEAN) {
    payload = Buffer.from([0x01, raw ? 1 : 0]); // application BOOLEAN
  } else {
    const f = Number(raw) || 0;
    payload = Buffer.alloc(5);
    payload[0] = 0x44; // application REAL, len 4
    payload.writeFloatBE(f, 1);
  }
  // objectId ctx0 (0x0c + 4B) + propertyId ctx1 (0x19 0x55) + open tag3 (0x3e) + 值 + close tag3 (0x3f)
  buf.writeUInt32BE(((objectId.type & 0x3ff) << 22) | (objectId.instance & 0x3fffff), 0);
  payload = Buffer.concat([Buffer.from([0x0c]), buf.subarray(0, 4), Buffer.from([0x19, pid]), Buffer.from([0x3e]), payload, Buffer.from([0x3f])]);
  sendApdu(invokeId, 12, payload, rinfo);
}

function sendSimpleAck(invokeId, service, rinfo) {
  sendApdu(invokeId, service, Buffer.from([0x00]), rinfo, true);
}

function sendError(invokeId, service, rinfo, errorClass) {
  const errBuffer = { buffer: Buffer.alloc(64), offset: 0 };
  baServices.error.encodeError(errBuffer, service, errorClass, 0);
  sendApdu(invokeId, service, errBuffer.buffer.subarray(0, errBuffer.offset), rinfo, false, true);
}

function sendApdu(invokeId, service, payload, rinfo, simpleAck = false, isError = false) {
  // Confirmed-Response: PDU type 0x30 | (isError ? 0x05 : 0x00); SimpleACK: type 0x20
  const apduType = isError ? 0x50 : simpleAck ? 0x20 : 0x30;
  const apdu = Buffer.concat([Buffer.from([apduType, invokeId, 0x00, service]), payload]);
  // BVLC Original-Unicast-NPDU(0x0A) + NPDU(0x01)
  // BVLC: 0x81 type / 0x0A Original-Unicast-NPDU / 长度 2B 大端（= NPDU + APDU） / NPDU 0x01
  const total = apdu.length + 1;
  const npdu = Buffer.concat([Buffer.from([0x81, 0x0a, (total >> 8) & 0xff, total & 0xff, 0x01]), apdu]);
  console.log(`[bacnet-sim] 发出 ${npdu.length}B: ${npdu.toString('hex').slice(0,60)}`);
  socket.send(npdu, rinfo.port, rinfo.address);
}

socket.bind(PORT, () => {
  console.log(`[bacnet-sim] 监听 udp/${PORT}`);
  console.log('[bacnet-sim] 对象：AI:1(温度,动态) AV:3(设定值,可写) BI:1(运行,动态) BV:2(报警,可写)');
});
