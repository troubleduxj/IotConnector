# FactoryBridge Go Gateway

这是 Go 网关渐进式重构实现。已覆盖 Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、SNMP、OPC UA、BACnet/IP；设置 `GATEWAY_GO_DRIVER_MODE=go` 后可对这些通道启用 Go 驱动，Node 仍可通过显式配置保留灰度回滚。

## 启动

在仓库根目录执行：

```powershell
go run ./apps/gateway-go/cmd/factorybridge
```

默认监听 `http://127.0.0.1:18080`，读取 `apps/gateway/data/config.json`。

也可以在 `apps/gateway-go` 目录执行，启动入口会自动识别相邻的 `apps/gateway/data` 目录。

可通过环境变量覆盖：

- `GATEWAY_GO_PORT`：监听端口，默认 `18080`
- `GATEWAY_GO_DATA_DIR`：配置目录，默认 `apps/gateway/data`
- `GATEWAY_GO_API_TOKEN`：可选 Bearer Token；配置后保护通道、实时值和写入接口
- `GATEWAY_GO_VIEWER_TOKEN`：可选只读 Token，可访问通道和实时值
- `GATEWAY_GO_OPERATOR_TOKEN`：可选操作 Token，可在只读权限上写入点位
- `GATEWAY_GO_ADMIN_TOKEN`：可选管理员 Token，继承全部当前 API 权限
- `GATEWAY_GO_LOGIN_USERNAME`：密码登录用户名，默认 `admin`
- `GATEWAY_GO_LOGIN_PASSWORD`：配置后启用密码登录；未配置时登录接口返回 `501`
- `GATEWAY_GO_LOGIN_PASSWORD_HASH`：推荐配置 bcrypt 哈希；优先级高于明文密码变量
- `GATEWAY_GO_MUST_CHANGE_PASSWORD`：首次初始化时要求改密，默认 `false`
- `GATEWAY_GO_SESSION_TTL`：Session 有效期，默认 `8h`
- `GATEWAY_GO_CORS_ORIGINS`：可选逗号分隔来源白名单，例如 `http://localhost:3000`
- `GATEWAY_GO_DRIVER_MODE=go`：将已覆盖的 Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、SNMP、OPC UA 通道自动路由到 Go 驱动；显式 `params.driver` 优先，可按通道灰度或回滚

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
