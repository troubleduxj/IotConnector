#!/bin/bash
# 一键启动全部演示进程（开发用）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 1
echo "[start-all] root: $ROOT"

# 清理旧实例
for port in 8080 3001 1883 10102 11021 15020 14448 19600; do
  for pid in $(netstat -ano | grep ":$port" | grep LISTENING | awk '{print $5}' | sort -u); do
    taskkill //PID $pid //T //F >/dev/null 2>&1
  done
done
sleep 1

G="$ROOT/apps/gateway"
rm -f "$G/data/config.json"

cd "$G"
nohup pnpm run s7-sim     > /tmp/s7-sim.log     2>&1 &
nohup pnpm run modbus-sim > /tmp/mb-sim.log     2>&1 &
nohup pnpm run opcua-sim  > /tmp/opc-sim.log    2>&1 &
nohup pnpm run melsec-sim > /tmp/melsec-sim.log 2>&1 &
nohup pnpm run fins-sim   > /tmp/fins-sim.log   2>&1 &
nohup pnpm run enip-sim   > /tmp/enip-sim.log   2>&1 &
nohup node scripts/mqtt-broker.cjs > /tmp/mqtt-broker.log 2>&1 &
sleep 5

TDENGINE_URL=http://127.0.0.1:16041 nohup pnpm run start > /tmp/gateway.log 2>&1 &
cd "$ROOT/apps/console"
nohup pnpm exec vite --port=3001 --strictPort > /tmp/console.log 2>&1 &

sleep 12
echo "[start-all] 端口监听检查："
for port in 3001 8080 1883 10102 11021 15020 14448 19600; do
  n=$(netstat -ano | grep ":$port " | grep LISTENING | wc -l)
  echo "  :$port → $n"
done
echo "[start-all] 完成。控制台 http://localhost:3001"
