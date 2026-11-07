# FactoryBridge Go Gateway

这是 Go 网关渐进式重构实现。已覆盖 Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、SNMP、OPC UA、BACnet/IP；设置 `GATEWAY_GO_DRIVER_MODE=go` 后可对这些通道启用 Go 驱动，Node 仍可通过显式配置保留灰度回滚。

## 启动

在仓库根目录执行：

```powershell
go run ./apps/gateway-go/cmd/factorybridge
```

默认监听 `http://127.0.0.1:18080`，数据目录为 `apps/gateway-go/data`（在 `apps/gateway-go` 目录执行时为 `./data`；发布包为可执行文件旁的 `data/`）。

该目录首次启动且为空时，会从旧的 Node 数据目录 `apps/gateway/data` 复制 `config.json`、`gateway.db`（一致快照）和尚未导入的旧状态文件，旧目录不改动。用 `--data-dir` 或 `GATEWAY_GO_DATA_DIR` 显式指定目录时不导入。

### 命令

```bash
factorybridge run [--data-dir 目录] [--host 127.0.0.1] [--port 18080] [--log-level info] [--dev] [--dev-no-auth]
factorybridge user create --name 用户名 --role viewer|operator|engineer|admin   # 口令交互输入，不回显
factorybridge user list|passwd|role|unlock|disable|enable|delete --name 用户名
factorybridge version [--json]
```

不带命令等同 `run`。退出码：0 成功、1 运行错误、2 参数错误、3 配置错误。脚本中设置口令用 `--password-stdin`。

### 账号与角色

- 用户与会话存放在数据目录下的 `gateway.db`（SQLite）。首次启动时，如果库中没有用户，会把旧的 `auth.json`（单个 admin）导入为 admin，并把原文件改名为 `auth.json.migrated`。
- 生产模式没有默认账号。库为空时，先用 `factorybridge user create --name <名> --role admin` 创建首个管理员。
- 四级角色：viewer（只读）< operator（写值、确认告警、运行脚本、下发配方）< engineer（改通道、位号、告警、配方、脚本、北向、通知）< admin（用户、会话、审计、驱动切换、删除通道）。
- 口令至少 12 位，须含大写、小写、数字和特殊字符。连续失败 5 次锁定 15 分钟。管理员重置口令或在界面上创建账号后，用户下次登录必须修改。
- 改角色、重置口令、禁用、删除后，该用户现有会话立即失效。
- 静态令牌（下方 `*_TOKEN`）用于脚本和第三方只读或写值调用，不能管理用户。

### 开发模式

`run --dev` 只能监听回环地址，以服务方式运行时拒绝进入。它会做三件事：

- 创建或重置 admin 账号 `dev`。口令取 `FB_DEV_PASSWORD`；未设置时随机生成，打印在启动日志里。
- 放行 `http://localhost:*`、`http://127.0.0.1:*` 来源，Vite 开发服务器不用再配 CORS。
- 在 `/api/system/info` 和 `/api/auth/me` 中返回 `devMode: true`。

`run --dev-no-auth` 在此基础上跳过登录，所有请求按 admin 处理，审计中的操作者记为 `dev(no-auth)`。

### 环境变量

- `GATEWAY_GO_PORT`、`GATEWAY_GO_HOST`、`GATEWAY_GO_DATA_DIR`、`GATEWAY_GO_LOG_LEVEL`：同名命令行参数的缺省值
- `GATEWAY_GO_VIEWER_TOKEN` / `GATEWAY_GO_OPERATOR_TOKEN` / `GATEWAY_GO_ADMIN_TOKEN`：静态令牌；`GATEWAY_GO_API_TOKEN` 为兼容旧配置，等同 operator
- `GATEWAY_GO_SESSION_TTL`：会话有效期，默认 `8h`
- `GATEWAY_GO_CORS_ORIGINS`：逗号分隔的来源白名单，例如 `http://localhost:3000`。写请求和 WebSocket 只接受同源或白名单来源
- `GATEWAY_GO_DRIVER_MODE=go`：将已覆盖的 Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、SNMP、OPC UA 通道自动路由到 Go 驱动；显式 `params.driver` 优先，可按通道灰度或回滚

已移除：`GATEWAY_GO_LOGIN_USERNAME`、`GATEWAY_GO_LOGIN_PASSWORD`、`GATEWAY_GO_LOGIN_PASSWORD_HASH`、`GATEWAY_GO_MUST_CHANGE_PASSWORD`。设置后不再生效，改用 `user` 子命令。另外，旧版本在未配置任何认证时会放行全部请求，现在不再这样。

设备级灰度 API：`GET /api/channels/{channelId}/driver` 查看当前选择，管理员可通过 `PUT /api/channels/{channelId}/driver` 写入 `{"driver":"go"}`、`{"driver":"node"}` 或 `{"driver":"auto"}`。`go` 会按协议映射到对应 Go 驱动，`node` 保留 legacy 回滚标记，`auto` 清除显式覆盖并恢复全局模式。

当前端点：

- `GET /api/health`
- `GET /api/system/info`
- `GET /api/channels`
- `GET /api/tags/live`
- `GET /api/history`
- `GET/POST /api/alarms`，`PUT/DELETE /api/alarms/:id`
- `GET /api/alarms/history`，`POST /api/alarms/events/:id/ack`
- `POST /api/tags/:id/write`，请求体为 `{ "value": number | string | boolean }`
- `POST /api/auth/login`，请求体为 `{ "username": "...", "password": "..." }`
- `POST /api/auth/logout`
- `POST /api/auth/password`，请求体为 `{ "currentPassword": "...", "newPassword": "..." }`
- `GET /ws`，兼容控制台消息：连接后发送 `subscribe` 获取快照，随后接收 `tags-batch` 和 `channel-status`；发送 `write` 获取 `write-result`

配置 Token 后，请求头使用 `Authorization: Bearer <token>`。兼容变量 `GATEWAY_GO_API_TOKEN` 等价于 Operator Token。权限不足返回 `403`，凭证无效返回 `401`。写入事件追加到 `<GATEWAY_GO_DATA_DIR>/audit.jsonl`，密码登录会话持久化到 `sessions.json`。`Float`/`Int32` 使用 FC16 双寄存器写入。

当前 Go 历史查询会将数值采样追加到 `<GATEWAY_GO_DATA_DIR>/history.jsonl`，重启后恢复最近数据；该本地日志用于迁移阶段恢复验证，生产历史存储仍需配置 TDengine writer。

WebSocket 握手支持 `Authorization: Bearer <token>`；浏览器原生 WebSocket 也可使用 `/ws?token=<token>`。启用认证后，未认证连接不能升级，写入必须先完成 `subscribe`。

密码登录成功后返回随机 Session Token；推荐使用 bcrypt 哈希变量。Session 持久化到 `<GATEWAY_GO_DATA_DIR>/sessions.json`，文件只保存 Token 摘要、用户、角色和过期时间，不保存原始 Token。

新密码至少 12 个字符，并同时包含大写字母、小写字母、数字和特殊字符。首次改密完成前，其他受保护接口返回 `403`。

认证失败默认按客户端地址限制为 5 次/分钟，超限返回 `429`；CORS 未配置白名单时不添加跨域许可头。

驱动默认通过通道 `params.driver` 显式选择；设置 `GATEWAY_GO_DRIVER_MODE=go` 后，已覆盖协议可自动选择 Go 驱动：

- `simulation`：本地周期模拟采样
- `modbus-go`：Go Modbus TCP 驱动，仅对 `Modbus TCP` 通道生效
- `melsec-go`：Go Mitsubishi MC 3E 二进制驱动，仅对 `Mitsubishi MELSEC` 通道生效；支持 D/W/R/ZR 字设备和 M/X/Y/B 位设备
- `fins-go`：Go Omron FINS/TCP 驱动，仅对 `Omron FINS` 通道生效；使用标准 Command/ErrorCode 封装和 SID，支持 D/W/CIO/H 字设备和 CIO 位设备
- `enip-go`：Go EtherNet/IP/CIP 驱动，仅对 `EtherNet/IP (Rockwell)` 通道生效；支持 RegisterSession、SendRRData、槽位路由、符号 Tag 读写、CIP 响应状态校验和 Bool/Int16/UInt16/Int32/Float；默认槽位为 1，显式 `params.slot` 优先；已通过 ProtoForge Int16 真实写入回归
- `snmp-go`：Go SNMP v1/v2c 驱动，仅对 `SNMP` 通道生效；支持 OID 批量 GET、community、timeout/retries、OID 前导点兼容、数值/字符串/布尔转换和基础 SET；本地标准 UDP v2c GET/SET 集成测试通过

ProtoForge SNMP 联调：在 `D:\Projects\sim-foundry-main` 执行
`python scripts/snmp_agent.py --host 127.0.0.1 --port 1161`，再设置
`SNMP_EXTERNAL_TEST=1`、`SNMP_EXTERNAL_PORT=1161` 运行
`go test ./internal/acquisition -run TestSNMPDriverExternalAgent -v`；将
`SNMP_EXTERNAL_VERSION` 设为 `1` 可回归 v1，`SNMP_EXTERNAL_COMMUNITY` 可覆盖 community，默认回归 v2c/public。
设置 `SNMP_EXTERNAL_REJECT_TEST=1` 可验证错误 community 被服务端静默丢弃。
- `opcua-go`：基于 `github.com/gopcua/opcua` 的 OPC UA 驱动，仅对 `OPC UA` 通道生效；支持 None/Sign/SignAndEncrypt 配置、匿名/用户名认证、节点读写和轮询采集
- `bacnet-go`：BACnet/IP UDP 驱动，仅对 `BACnet/IP` 通道生效；支持 AI/AO/AV/BI/BO/BV 对象、标准 ReadPropertyMultiple/WriteProperty、PresentValue 读写、Who-Is/I-Am 发现、SubscribeCOV 订阅/通知、CancelCOV 和续租、Bool/Float/数值/字符串转换、超时和自动重连；已与 ProtoForge `47808` 完成读取、写入、发现、COV 通知内容和取消真实回归，兼容旧紧凑响应及标准 Complex-ACK 响应
- `s7-go`：基于固定 master commit 的 `github.com/robinson/gos7`，仅对 `Siemens Profinet` 通道生效；支持 DB、M、I/E、Q/A、T、C 区域的 Bool/Byte/Int16/UInt16/Int32/Float 读写和轮询；Bool 写入采用读改写保护同字节其他位；多点采集按最多 20 项调用 Read Var，设备不支持时自动逐点回退。地址示例：`DB1.DBD0`、`DB1.DBX0.0`、`M0.0`、`MW2`、`IB0`、`QW2`、`T1`、`C1`

第三方驱动决策：`gopcua/opcua v0.9.1` 使用 MIT 许可证并已纳入依赖；`robinson/gos7` 当前只有 master 伪版本（BSD-3-Clause），依赖已固定到 `2d6806f80c8b`。当前已完成 ProtoForge DB 真实读写，S7-1200/1500、优化块、安全保护和长期重连回归仍需现场验收。

未配置驱动的通道不会主动连接现场设备。

运行诊断指标：`GET /api/metrics`（需要 viewer/operator/admin 凭证）返回采样总量、通道状态分布、离线转换/恢复/重连次数、成功采集延迟和存储队列计数；`GET /metrics` 提供 Prometheus 0.0.4 文本格式。按协议和通道拆分的重连细分仍在后续阶段补齐。

S7 ProtoForge 真实联调测试默认连接 `127.0.0.1:103`，可通过 `PROTOFORGE_S7_HOST` 和 `PROTOFORGE_S7_PORT` 覆盖：

```powershell
$env:PROTOFORGE_S7="1"
$env:PROTOFORGE_S7_PORT="102"
go test ./internal/acquisition -run TestS7ProtoForgeReadWrite -v
```

BACnet ProtoForge 真实联调默认连接 `127.0.0.1:47808`：

```powershell
$env:PROTOFORGE_BACNET="1"
go test ./internal/acquisition -run TestBACnetProtoForgeReadWrite -v
go test ./internal/acquisition -run TestBACnetProtoForgeWhoIs -v
```

后续任务按 [Go 重构方案](../../docs/GO_REFACTOR_PLAN.md) 的 `GO-P0` 至 `GO-P2` 执行。
