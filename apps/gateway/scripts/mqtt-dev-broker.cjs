// 开发用完整 MQTT Broker（aedes）：实现订阅转发（供 MQTT 南向采集联调），
// 同时打印所有 PUBLISH（保留原 mqtt-broker.cjs 的北向报文可见性）。
// 端口：MQTT_BROKER_PORT（默认 1883）。启动：pnpm --filter @iotconnector/gateway mqtt-dev-broker
const { createServer } = require('node:net');
const { Aedes } = require('aedes');
const PORT = Number(process.env.MQTT_BROKER_PORT || 1883);

(async () => {
  const aedes = await Aedes.createBroker();

  aedes.on('publish', (packet, client) => {
    const from = client ? client.id : 'external';
    console.log(`[PUB] ${from} → ${packet.topic}: ${packet.payload.toString().slice(0, 200)}`);
  });
  aedes.on('client', (client) => console.log(`── 连接 ${client.id}`));
  aedes.on('clientDisconnect', (client) => console.log(`── 断开 ${client.id}`));

  createServer((socket) => aedes.handle(socket))
    .listen(PORT, () => console.log(`[mqtt-dev-broker] aedes 监听 tcp/${PORT}（完整订阅转发 + 发布打印）`));
})();
