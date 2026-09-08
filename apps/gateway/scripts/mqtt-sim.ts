import mqtt from 'mqtt';

/**
 * MQTT 采集模拟器：以 1s 周期向两个主题发布遥测，
 * 供 MQTT 南向订阅通道联调（JSON 路径取字段 / 原始值两种 payload）。
 * 前置：pnpm --filter @iotconnector/gateway mqtt-broker（aedes，1883）
 * 启动：pnpm --filter @iotconnector/gateway mqtt-sim
 */

const URL = process.env.MQTT_SIM_URL ?? 'mqtt://127.0.0.1:1883';

const client = mqtt.connect(URL, { connectTimeout: 6000 });

client.on('connect', () => {
  console.log(`[mqtt-sim] 已连接 ${URL}，开始发布遥测`);
  setInterval(publish, 1000);
});

let connectedOnce = false;
client.on('connect', () => { connectedOnce = true; });
client.on('error', (e) => {
  // 瞬断（如 broker 重启）不退出，mqtt 客户端自动重连
  if (!connectedOnce) {
    console.error(`[mqtt-sim] 初始连接失败: ${e.message}（请先启动 mqtt-dev-broker）`);
    process.exit(1);
  }
  console.error(`[mqtt-sim] 瞬断将自动重连: ${e.message}`);
});

let n = 0;
function publish(): void {
  n += 1;
  // 主题 1：JSON 多字段（多位号共用一个主题，各自 jsonPath 取字段）
  const json = JSON.stringify({
    temp: Number((42 + Math.sin(n / 10) * 3).toFixed(2)),
    speed: 1200 + (n % 50),
    running: n % 30 !== 0, // 每 30 秒一个 false 边沿
  });
  client.publish('factory/line1/status', json);
  // 主题 2：原始数值（payloadMode=raw）
  client.publish('factory/line1/counter', String(1000 + n));
}
