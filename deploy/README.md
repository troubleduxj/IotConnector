# Factory Bridge 部署指南（服务化运行）

> 演示/试点环境推荐 Docker Compose 一键栈（`docker-compose.yml`：网关 + 控制台 nginx + TDengine + 五个协议模拟器）；
> 需要网关以**系统服务**方式常驻（开机自启、崩溃自动拉起）时，按本文操作。

## 前置条件

1. Node.js ≥ 20（建议 22 LTS）
2. `pnpm install --frozen-lockfile`（monorepo 根目录执行；`tsx` 为运行时加载器，随 devDependencies 安装）
3. （可选，历史查询/存储任务需要）TDengine：`docker run -d --name tdengine --restart unless-stopped -p 16041:6041 tdengine/tdengine:3.3.6.13`

> **重要**：网关全部持久化文件（`data/config.json`、`audit.jsonl`、`sessions.json`、`shadow.json`、
> `northbound.json`、`outbox.jsonl`）按 `process.cwd()/data` 解析，服务的工作目录必须指向 `apps/gateway`。

## Linux（systemd）

```bash
# 1. 按实际安装路径与运行账号修改 deploy/systemd/factory-bridge-gateway.service
sudo cp -r <repo> /opt/factory-bridge
sudo useradd -r -s /usr/sbin/nologin fbridge
sudo chown -R fbridge:fbridge /opt/factory-bridge/apps/gateway/data

# 2. 安装并启动
sudo cp /opt/factory-bridge/deploy/systemd/factory-bridge-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now factory-bridge-gateway

# 3. 验证
systemctl status factory-bridge-gateway
journalctl -u factory-bridge-gateway -f
curl -s http://127.0.0.1:8080/api/health
```

单元文件要点：`Restart=always`（5 秒退避）、`KillSignal=SIGINT`（触发优雅停机：
影子强制落盘 → 北向 NDEATH → 引擎停止）、`ReadWritePaths` 限定仅 `data/` 可写。

## Windows（WinSW 服务包装）

1. 下载 [WinSW-x64.exe](https://github.com/winsw/winsw/releases)，重命名为
   `factory-bridge-gateway.exe` 放入 `deploy/windows/`；
2. 编辑 `factory-bridge-gateway-service.xml` 中的 `<workingdirectory>` 为实际 `apps\gateway` 路径；
3. 管理员 CMD：`deploy\windows\install-service.cmd`（卸载：`uninstall-service.cmd`）。

服务名 `factory-bridge-gateway`，自动启动（延迟启动避免抢占开机 I/O），
滚动日志位于 `deploy\windows\logs\`。

## 控制台（生产构建）

```bash
pnpm --filter @iotconnector/console build   # 产出 apps/console/dist（hash 路由静态站）
# 任一静态服务器托管即可，例：
npx serve apps/console/dist -l 3000
```

控制台仅依赖同源 REST/WS；如与网关不同域，需在网关侧放开 CORS（默认允许本地开发源）。

## 健康检查与运维接口

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 存活探针（systemd/WinSW/K8s probe） |
| `GET /api/system/info` | 版本、运行时长、配置规模、存储状态 |
| `GET /api/system/db-test` | TDengine 连通性实测（返回 RTT） |
| `GET /api/system/diag` | 审计尾部导出（现场排障） |
| `GET /api/shadow` | 设备影子快照（reported vs desired） |

## 故障排查速查

| 现象 | 处置 |
|---|---|
| 网关起不来，日志 `EADDRINUSE` | 8080 被占用：改 `GATEWAY_PORT` 或释放端口 |
| 存储状态 `offline`，`Table does not exist` | TDengine 未启动/URL 错：`curl http://127.0.0.1:16041/-/ping`；TDengine 不可达网关会自动降级继续采集，恢复后自动重连 |
| MQTT 北向未发布 | `GET /api/northbound` 看 `status.connected/lastError`；断线期间数据入 Reliable Outbox 自动补传 |
| 登录提示锁定 | 登录失败 5 次/10 分钟锁定，等待解锁或由管理员重启网关（内存锁定计数） |
| 通道反复 error | 设备管理页「连接测试」查看分步握手明细（支持 S7 多位号批量探针、OPC UA 订阅采样） |
