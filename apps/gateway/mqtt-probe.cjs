// 标准 mqtt.js 客户端探测当前 broker
const fs = require('fs');
const mqtt = require('mqtt');
const out = [];
const c = mqtt.connect('mqtt://127.0.0.1:1883', { clientId: 'probe_client', reconnectPeriod: 1500 });
c.on('connect', () => { out.push('CONNECTED'); c.publish('probe/test', 'hello'); });
c.on('message', (t, p) => out.push('MSG ' + t + ' ' + p.length + 'B'));
c.on('error', (e) => out.push('ERR ' + e.message));
c.on('close', () => out.push('CLOSE'));
c.on('reconnect', () => out.push('RECONNECT'));
setTimeout(() => { fs.writeFileSync('probe-result.txt', out.join('\n') || '(nothing)'); process.exit(0); }, 6000);
