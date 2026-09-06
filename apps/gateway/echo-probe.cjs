// 判别：1883 上的回显服务 —— 若字节能到达，说明端口可用，问题在 aedes
const net = require('node:net');
const fs = require('fs');
const out = [];
const srv = net.createServer((sock) => {
  out.push('echo server accepted connection');
  sock.on('data', (d) => {
    out.push('echo RX ' + d.length + 'B: ' + d.toString('hex'));
    sock.write(d); // 回显
  });
  sock.on('error', () => {});
});
srv.listen(1883, '127.0.0.1', () => out.push('echo listening 127.0.0.1:1883'));

const client = net.connect(1883, '127.0.0.1');
client.on('connect', () => {
  out.push('client connected, sending 4B');
  client.write(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
});
client.on('data', (d) => out.push('client got echo: ' + d.toString('hex')));
client.on('error', (e) => out.push('client err: ' + e.message));

setTimeout(() => {
  fs.writeFileSync('probe-result.txt', out.join('\n'));
  process.exit(0);
}, 3000);
