// 最小 MQTT Broker（验证用途）：CONNECT→CONNACK、PUBLISH 打印、DISCONNECT 关闭。
// 不实现订阅转发 —— 北向验证只需要看到网关发出的 NBIRTH/DBIRTH/DDATA 报文。
const { createServer } = require('node:net');
const fs = require('node:fs');

const PORT = Number(process.env.MQTT_BROKER_PORT || 1883);
const LOG = process.env.MQTT_LOG || 'mqtt-broker.log';
const log = (m) => { console.log(m); fs.appendFileSync(LOG, m + '\n'); };

function readMQString(buf, off) {
  const len = buf.readUInt16BE(off);
  return { value: buf.subarray(off + 2, off + 2 + len).toString('utf-8'), next: off + 2 + len };
}

function decodeRemainingVarint(buf, off) {
  let multiplier = 1; let value = 0; let i = off; let byte;
  do { byte = buf[i]; value += (byte & 127) * multiplier; multiplier *= 128; i += 1; } while ((byte & 128) !== 0);
  return { value, next: i };
}

const server = createServer((socket) => {
  const who = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`── 连接 ${who}`);
  let rx = Buffer.alloc(0);
  let clientId = '';

  socket.on('data', (chunk) => {
    rx = Buffer.concat([rx, chunk]);
    while (rx.length >= 2) {
      const { value: remaining, next: hdrEnd } = decodeRemainingVarint(rx, 1);
      const total = hdrEnd + remaining;
      if (rx.length < total) break;
      const packet = rx.subarray(0, total);
      rx = rx.subarray(total);

      const type = packet[0] >> 4;
      if (type === 1) {
        const proto = readMQString(packet, hdrEnd);
        clientId = readMQString(packet, proto.next + 4).value;
        log(`← CONNECT client="${clientId}" proto=${proto.value}`);
        socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK OK
      } else if (type === 3) {
        const topic = readMQString(packet, hdrEnd);
        const payload = packet.subarray(topic.next);
        const preview = payload.length
          ? Array.from(payload.subarray(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join(' ')
          : '(empty)';
        log(`← PUBLISH ${topic.value} (${payload.length}B) ${preview}...`);
      } else if (type === 14) {
        log(`← DISCONNECT ${clientId}`);
      }
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => log(`── 断开 ${who}`));
});

server.listen(PORT, '127.0.0.1', () => log(`[mini-mqtt] listening on 127.0.0.1:${PORT}`));
