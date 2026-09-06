// 裸 socket CONNECT 探针（对当前 1883 listener）
const net = require('node:net');
const fs = require('fs');
const out = [];
const vh = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
const cid = Buffer.from([0x00, 0x00]);
const p = Buffer.concat([vh, cid]);
const pkt = Buffer.concat([Buffer.from([0x10, p.length + 2]), Buffer.from([0x00, 0x00]), p]);
const s = net.connect(1883, '127.0.0.1');
s.on('connect', () => { out.push('TCP OK, sent ' + pkt.length + 'B'); s.write(pkt); });
s.on('data', (d) => out.push('RX ' + d.toString('hex')));
s.on('error', (e) => out.push('ERR ' + e.message));
s.on('close', () => out.push('closed'));
setTimeout(() => { fs.writeFileSync('probe-result.txt', out.join('\n')); process.exit(0); }, 3000);
