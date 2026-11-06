# 后续任务列表（Roadmap）

> Go 网关渐进式重构的完整架构、迁移阶段、验收指标和任务清单见：
> [GO_REFACTOR_PLAN.md](GO_REFACTOR_PLAN.md)。该文档中的 `GO-P0` 至 `GO-P2` 任务是本路线图的下一阶段主线，优先级高于普通功能扩展。

> 2026-09-07 更新：**P1/P2 全部完成**。
> P1 批次（本仓库提交）：M9 系统配置整改（dba2939）、点位实时值+地址校验（5baab58）、通道导入导出（a9d3aa6）、
> 通道通讯统计+相位错开重均衡（1c6c15c）、存储任务运行状态（fb2a3ea）、脚本运行监控+崩溃自动禁用（708043d）、
> 配方版本/下发记录/导出复制导入（658b036）。
> P2 批次：统一 TagValue 组件+值变化高亮 #25（50dd95f）、通知消息模板 #12（4652b8b）、
> Historian 自定义预设+量程外提示 #5（5c5c511）、设备影子 #22（d3d1af2）。
> 其中 #14 ROC 告警、#16 MELSEC/FINS/ENIP 驱动、#17 报文诊断真实化已在先前迭代随 P0/P1 顺带落地。
> 当前遗留：#11 告警通知真实端点联调、生产升级回滚演练；7 天连续运行和现场设备回归按用户决定暂缓。Go 主用切换已完成，Node 实例已下线但源码和回滚入口保留。
> 2026-09-09 协议扩展批次：MQTT 南向订阅 + SNMP（651291c）、BACnet/IP（854a150）驱动接入，
> 协议矩阵 9 个真驱动（占位仅剩 IEC 60870-5-104 —— npm 无可用库需手写完整协议栈，工作量 L，暂缓）。
> 2026-09-09（续）：IEC 60870-5-104 已以零依赖手写协议栈落地（608fb60），协议矩阵 10/10 真驱动全覆盖。
2026-09-09（C 组）：工程质量（协议单测 +22、Playwright 冒烟、OpenAPI 一致性 55↔55）、B 组功能（告警风暴抑制/北向 CMD 闭环/全量配置备份恢复）、运维三项（config schemaVersion v2 迁移、compose 全栈验证修复、网关服务化脚本）全部落地（812610d / 01d7ee1 / b2e5607 / adbec17 / 82cc59d）。
2026-09-15（Go 北向与 Shadow）：MQTT/Sparkplug B、CMD 审计、真实 broker 验收、Shadow 原子持久化、reported/desired/pending、retain 发布和 ProtoForge 真实采样重启恢复均完成；GO-P1-13/14 完成。
2026-09-21（ProtoForge 多协议真实联调）：受控重启 ProtoForge 并完成认证恢复；按 Go 配置启动 Modbus TCP `15020`、S7 `10102`、SNMP `1161`、FINS `19600`，并记录 MELSEC/EtherNet-IP 因端口占用自动切换至 `11022/14449`。Go 以 `GATEWAY_GO_DRIVER_MODE=go` 运行后，S7、Modbus、SNMP、MELSEC、EtherNet/IP 均达到在线采集，TDengine 写入和历史查询通过；当前 BACnet RPM 点位列表、OPC UA 节点地址、FINS 点位数据宽度及 MQTT/IEC104 模拟端仍阻断全协议门禁。
2026-09-21（TDengine 告警表兼容修复）：Go writer 的告警表 DDL 与 Node 既有 `alarm_events` 表结构不一致，导致 TDengine 错误码 9728/534、Outbox 持续堆积；已统一为 `status/val` 兼容 schema 并保守化字段长度，Go 单测通过，重启后 storage online、写入 628 条且队列稳定回落。协议全量 E2E 和故障矩阵仍未关闭。
2026-09-21（TDengine 非有限值保护）：补充 `NaN/Inf` 采样值过滤，避免异常工程值拼入 TDengine SQL；存储错误清零，最终重启检查 `storage=online`、`queued=4`、`written=845`，Go/Node/前端服务均保持可用。
2026-09-22（MQTT 南向真实联调）：使用项目内 Aedes Broker 和 `mqtt-sim.ts` 完成 Go MQTT 通道真实订阅；补充 JSON 字段路径映射，验证 `Line1.Temp=44.33`、`Line1.Counter=1210` 和布尔字段，通道状态为 online。停止并恢复 Broker 后 Go 自动重连、继续收到数据；Go 健康检查 `storage=online`、`written=6944`。ProtoForge MQTT 仍因 `amqtt` 依赖不可安装保留环境阻塞，但 Go MQTT 驱动已完成项目内模拟器回归。
2026-09-21（遗留协议第二批）：按 ProtoForge 真实设备点位修正 OPC UA `ns=2;i=2/3/4`、BACnet `AI:1/AI:2/BI:1/AO:1`、FINS D100 数据类型；Go 重启后 8/10 通道在线，新增 OPC UA、BACnet、FINS 在线回归。新增 Go MQTT 南向驱动、订阅/JSON 值解码和写入接口，已从 factory nil 进入真实连接阶段；ProtoForge 因 Python 3.10 缺少 `amqtt` 且当前镜像不可达，MQTT Broker 暂无法启动。IEC104 仍缺 Go 驱动和 ProtoForge 模拟端，保留为阻塞项。
2026-09-22（IEC104 Go 驱动）：移植 Node 已验证的 IEC 60870-5-104 APCI/ASDU 最小实现，支持 STARTDT、S 帧、总召唤、M_SP_NA 单点和 M_ME_NC 浮点遥测、IOA 映射、断线重连；新增编解码单测并通过。IEC104 通道现由 `driver factory returned nil` 转为真实连接拒绝状态，证明 Go 驱动已接入；ProtoForge 仍无 IEC104 模拟服务，现场联调待外部设备/专用模拟器。
2026-09-15（Go 业务 API）：配方 CRUD、版本、逐项下发、记录、复制、导入导出，以及脚本 CRUD、手动/周期/tagChange 执行、Goja worker 超时隔离均完成；剩余为全量双后端回归和生产级资源配额。
2026-09-15（Go 通知适配）：新增钉钉签名、企业微信和 SMTP 适配，统一测试接口和 Active 告警分发支持四渠道；Webhook/钉钉/企微本地 mock 契约测试已通过，真实机器人/SMTP 端点和可靠重试队列仍待完成。
2026-09-15（Go E2E）：E2E 支持 `E2E_BASE_URL` 覆盖；Go 直连控制台登录、调度和 Bool 历史冒烟 2/2 通过。Node 默认实例因 TDengine URL 未配置导致历史链路阻断，待补双后端全量回归环境。
2026-09-15（Go 驱动扩展）：新增 `melsec-go` MC 3E 二进制采集驱动，支持 D/W/R/ZR 字设备、M/X/Y/B 位设备、Int16/UInt16/Int32/Float 读写、轮询和断线重连路径；协议级假服务测试通过，真实 ProtoForge `11021` 联调待模拟器启动。
2026-09-15（Go 驱动扩展续）：新增 `fins-go` FINS/TCP 驱动，支持 D/W/CIO/H 字设备和 CIO 位设备、Int16/UInt16/Int32/Float 读写与轮询；协议级假服务测试通过，真实 ProtoForge `19600` 联调待模拟器启动。
2026-09-15（Go 驱动扩展第三批）：新增 `enip-go` EtherNet/IP/CIP 驱动，支持 RegisterSession、SendRRData、背板/槽位路由、符号 Tag 读写和 Bool/Int16/UInt16/Int32/Float；协议级假服务测试通过，真实 ProtoForge `14448` 联调待模拟器启动。
2026-09-15（Go 驱动扩展第四批）：新增 `snmp-go` SNMP v1/v2c 驱动，支持 OID 批量 GET、community、timeout/retries、数值/字符串/布尔转换和基础 SET；转换单测通过，真实 ProtoForge `1161` 联调待模拟器启动。
2026-09-15（Go 驱动扩展第五批）：引入 MIT `github.com/gopcua/opcua v0.9.1`，新增 `opcua-go` OPC UA 基础驱动，支持 None/用户名认证、节点读写和轮询采集；已与 ProtoForge `4840` 的 `ns=2;i=2` 完成真实读写。S7 开源方案核查完成：`github.com/robinson/gos7` 为 BSD-3-Clause、当前无正式 tag，暂不直接接入生产路径。
2026-09-15（Go 驱动扩展第六批）：引入并固定 BSD-3-Clause `github.com/robinson/gos7` commit `2d6806f80c8b`，新增 `s7-go`；支持 DB、M、I/E、Q/A、T、C 区域基础读写、Bool/Byte/Int16/UInt16/Int32/Float、轮询与断线重连。单元测试与 ProtoForge `127.0.0.1:103` 的 `DB1.DBD0` 真实读写通过；S7-1200/1500 现场回归、优化块和安全保护待完成。
2026-09-16（Go S7 跨区域联调）：结束验证前确认 `102` 被 Siemens `S7DOS Help Service` 占用且当前账户无权停止，改在 `127.0.0.1:103` 启动独立 ProtoForge S7 服务；DB1.DBD0、DB1.DBB4、M0.0、Q0.0 多点读取和 DB/M/Q 回写通过。
2026-09-16（Go S7 位写入可靠性）：Bool 写入改为读改写目标字节，保护同字节其他位；全量 Go 测试与 `go vet` 通过。
2026-09-16（Go S7 联调配置化）：真实测试支持 `PROTOFORGE_S7_HOST`/`PROTOFORGE_S7_PORT` 覆盖，默认仍使用 ProtoForge `127.0.0.1:103`，可直接切换到标准端口 `102` 验证。
2026-09-16（Go FINS 真实联调）：修正 FINS/TCP 标准 4 字节 Command + 4 字节 ErrorCode 封装、SID 偏移、CIO 位读命令和位写命令；ProtoForge `127.0.0.1:19600` 上 D0/CIO0.00 读写通过，新增可配置 host/port 的真实测试；全量 Go 测试和 `go vet` 通过。
2026-09-16（Go MELSEC 真实联调）：新增可配置 host/port 的 ProtoForge MC 3E 真实测试；`127.0.0.1:11021` 上 D100/M0 读取和写入通过，全量 Go 测试与 `go vet` 通过。
2026-09-16（Go EtherNet/IP 真实联调）：修正 UCMM 数据项、标准直接 `0x4C/0x4D` Tag 服务和 ProtoForge CIP 响应解析；补充 CIP 写响应状态校验。ProtoForge `127.0.0.1:14448` 上 Float/Int16 符号 Tag 读取和写入通过；临时联调服务与夹具已清理。SNMP 真实联调仍待完成。
2026-09-16（Go SNMP UDP 集成验证）：补充标准 BER 编解码的本地 UDP v2c 集成测试，覆盖批量 GET、SET、数值/字符串转换和动态端口；修正 Integer SET 使用 `int32` 导致的编码失败，并统一 OID 前导点兼容。SNMP 真实设备/标准 `snmpd` 联调仍待完成。
2026-09-17（Go SNMP 标准 Agent 联调）：先前使用项目内 `net-snmp` Agent 完成的验证不属于 ProtoForge 联调；现已在 `D:\Projects\sim-foundry-main\scripts\snmp_agent.py` 增加 ProtoForge 工程内的零依赖 SNMP v1/v2c Agent 夹具，支持批量 GET、标量 OID、数值/字符串 SET。Go 外部集成测试连接 ProtoForge UDP/1161 后，v2c 与 v1 均通过；超时/重试、前导点兼容和类型转换也通过。真实 SNMP 设备回归仍待现场条件。
2026-09-17（ProtoForge SNMP 服务注册）：新增 `protoforge.protocols.snmp.SnmpServer`，接入 ProtoForge 协议注册表、默认端口/协议配置和 UDP 端口冲突检查；支持由协议管理生命周期启动，并将设备点位映射为 SNMP 标量 OID。注册服务 smoke fixture 连接 Go SNMP 外部测试，v1/v2c GET/SET 均通过。当前 community 字符串尚未纳入访问控制，生产 SNMPv3 不在本批范围。
2026-09-17（ProtoForge SNMP 访问控制）：SNMP 服务及独立夹具新增 community 校验，不匹配请求静默丢弃；协议配置支持 1-128 字符 community，Go 外部测试支持 `SNMP_EXTERNAL_COMMUNITY` 覆盖。默认 public 兼容回归通过，SNMPv3 仍不在本批范围。
2026-09-17（ProtoForge SNMP 负向回归）：新增错误 community 超时断言，确认未授权请求不会返回数据；SNMPv3 需要独立 USM/authPriv 设计，列入下一专项，不将 v1/v2c 能力误标为 v3 支持。
2026-09-17（BACnet 联调修复）：BACnet 驱动修正 RPM 返回值为 0/false 时被误判为空的问题；ProtoForge BACnet 服务移除 `SO_REUSEADDR`，同机同 UDP 端口冲突现在会明确拒绝。新增门控 BACnet live 测试覆盖 AI/AV/BI/BV 读回及 AV/BV 写入，回归通过。
2026-09-17（Go 替代 Node 路由）：Go 驱动注册表新增 `GATEWAY_GO_DRIVER_MODE=go` 透明路由模式，自动将 Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、SNMP、OPC UA 通道选择到 Go 驱动；显式 `params.driver` 优先，保留逐通道灰度/回滚。新增 registry 路由单测。
2026-09-17（Go BACnet/IP 驱动）：新增 `bacnet-go` 原生 UDP 驱动，支持 AI/AO/AV/BI/BO/BV 的 PresentValue 批量读取、WriteProperty、Bool/Float/数值/字符串转换、超时和断线重连；兼容 ProtoForge 紧凑 RPM 响应与标准 Complex-ACK，并接入自动路由。协议编解码、地址、写入和路由单测通过；ProtoForge 真实进程联调、Who-Is/I-Am、COV 和多设备发现仍待完成。
2026-09-20（BACnet 真实联调）：修复 ProtoForge Windows Proactor UDP 接收、RPM 标准对象上下文标签、Confirmed-Request 标准 APDU、按对象类型独立实例号和点位地址类型推断；修正 Node/Go 请求头及 Go 标准 RPM/WriteProperty 编解码。使用 ProtoForge `127.0.0.1:47808` 完成 Node 与 Go 的 AI/AO/BI 读取、AO 写入和重启后回归；Node 下线门禁仍受 BACnet 发现/COV、多设备和全量故障矩阵约束。
2026-09-20（BACnet 发现）：ProtoForge I-Am 响应改为标准 Context Tag 0/1/2/3；Go `bacnet-go` 新增 Who-Is/I-Am `Discover`，可返回设备实例、最大 APDU、分段能力、厂商 ID 和来源地址。ProtoForge 真实发现回归通过；COV、跨设备发现和现场设备回归仍待完成。
2026-09-20（BACnet COV）：ProtoForge 修正标准 SubscribeCOV Context Tag、对象类型/实例匹配和 Simple-ACK 顺序；Go `bacnet-go` 新增 `SubscribeCOV`，并用 ProtoForge 真实验证订阅确认及 UnconfirmedCOVNotification。COV 取消/续租、确认通知、跨设备和长期变化量回归仍待完成。
2026-09-20（BACnet COV 与多设备）：补齐 lifetime 编码、同一订阅续租、lifetime=0 取消、到期清理和对象类型隔离；Go 新增 `CancelCOV`。ProtoForge 多设备 I-Am 改为每台设备独立 UDP 帧，避免拼接报文；真实 ProtoForge 已通过 COV 订阅/通知/取消及发现回归。
2026-09-20（BACnet COV 通知校验）：Go 增加 COV 通知解码断言，验证 process ID、对象类型和实例号；修复 ProtoForge 使用内部订阅 ID 替代客户端 process ID 的协议错误。ProtoForge 真实 COV 订阅、通知内容、取消和读写回归通过。
2026-09-20（BACnet 故障恢复）：拆分 Go BACnet 生命周期锁与网络 I/O 锁，停止驱动可立即关闭挂起 UDP 请求，不再等待网络超时；新增 Stop 解阻塞回归测试。Go 全量测试、`go vet` 和 ProtoForge BACnet live 回归通过。
2026-09-20（协议故障矩阵第一批）：新增 BACnet UDP 夹具回归，覆盖首包丢失、超时、同一 socket 恢复读取；停止解阻塞与恢复路径均通过。当前各协议现场故障矩阵仍需按可用 ProtoForge 服务逐项执行。
2026-09-20（Go/Node 灰度路由）：补齐 registry 路由矩阵，验证全局 Go 模式、显式 Go、显式 legacy/Node 回滚和无 Go 模式默认不切流；协议驱动选择不会被全局开关覆盖。设备级灰度仍需接入运行时配置和 API。
2026-09-21（设备级灰度 API）：新增通道驱动查询/切换接口，支持 `auto`、`go`、`node` 三种选择；配置原子持久化并触发 Engine Reload，Go 驱动按协议映射，显式 legacy 标记可回滚。新增 API 回归测试覆盖 Go→Node→auto。
2026-09-21（设备级灰度 UI）：设备详情页接入驱动状态查询和切换控件，支持自动/Go/Node；管理员可切换，工程师和操作员只读；切换中禁用控件，失败恢复原选择并提示。Console typecheck/build、Go 全量测试通过。浏览器冒烟受当前 3000 端口返回 404 阻断，需使用 console Vite 5173 或正确的控制台服务端口复测。
2026-09-21（设备级灰度浏览器回归）：修复 Go 网关 CORS 预检未声明 PUT/DELETE，导致控制台设备驱动切换出现 `Failed to fetch`；现已允许完整 REST 方法集。管理员设备页 Go→Auto 真实浏览器回归通过，2 个核心登录/业务冒烟测试继续通过。
2026-09-21（双后端对比第一批）：Go `18080` 与 Node `18081` 隔离运行；两端 `/api/config` 均为 10 通道/37 位号且通道 ID、协议、地址一致。Go 控制台核心冒烟及设备灰度回归通过；Node 登录/导航通过，但历史 Bool 用例因 TDengine 未配置无统计数据而失败。Node 尚无设备级 `/driver` API，继续保留为兼容期差异。
2026-09-21（Node 灰度 API 兼容）：Node 新增设备级 `/api/channels/{id}/driver` 查询/切换接口；Node 网关明确返回 `node`，支持 `node`/`auto` 持久化和热重载，拒绝伪装成 Go 的切换请求。Node TypeScript 检查通过，Go/Node 两端 driver API 基础回归通过；Node TDengine 未配置仍阻断历史数据全链路。
2026-09-21（Node TDengine 双后端回归）：确认 Docker `aurasense-tdengine` 已运行；Node 隔离网关改用 `TDENGINE_URL=http://localhost:6041`（当前 Windows/WSL 环境下 127.0.0.1 转发超时），存储恢复 online，已写入 245 条。Node 控制台核心冒烟 2/2 通过；Go 控制台核心冒烟+设备灰度 3/3 通过。Go 当前无可用南向样本时保持 storage offline，待 Go 协议模拟器启用后验证写入/历史。
2026-09-16（Go 运行指标第一阶段）：新增受 viewer 权限保护的 `/api/metrics`，提供采样总量、状态更新次数、通道状态分布、离线转换/恢复次数、成功采集延迟，以及存储 queued/written/dropped；新增引擎指标单测。统一 Prometheus 输出和协议级重连细分仍待补齐。
2026-09-16（Go Prometheus 指标）：新增 `/metrics` 文本端点和 API 回归测试，输出采样/状态 counter、通道状态 gauge、离线转换/恢复、延迟汇总及存储队列指标；协议级重连细分仍待补齐。
2026-09-16（Go 重连指标）：新增 `factorybridge_acquisition_reconnects_total`，以离线到在线恢复作为统一重连口径，并补充 Prometheus 端点回归断言；按协议/通道拆分仍待后续故障演练完善。
2026-09-16（Go TDengine 故障恢复验证）：新增 HTTP 503 故障注入测试，验证 TDengine 写入失败时状态变为 offline、Outbox 保留数据，服务恢复后重新冲刷并回到 online；真实断网、进程重启和磁盘不足演练仍待现场环境执行。

> 基于 v0.2.0-phase1-core 标签（Phase 1 核心闭环已完成）。
> 优先级：P0 = 下一迭代必做；P1 = 本阶段内；P2 = Phase 2/3。
> 工作量：S ≈ 半天~1 天，M ≈ 2-3 天，L ≈ 1 周+。

## 一、页面接线收尾（Phase 1 剩余）✅ 已全部完成

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 1 | ~~Data Storage 页接真实存储引擎~~ | P0 | L | ✅ 含表达式触发（1bb25fe）+ 运行状态监控 FR-M4-06（fb2a3ea） |
| 2 | ~~Recipes 页接真实数据~~ | P0 | M | ✅ 含版本/下发记录/导出复制导入 FR-M6-03/04（658b036） |
| 3 | ~~Scripts 页（JS 沙箱）~~ | P1 | L | ✅ 含运行监控+崩溃自动禁用 FR-M8-06（708043d） |
| 4 | ~~Acquisition Scheduler 页接真实指标~~ | P1 | M | ✅ 含通道通讯统计 FR-M2-07 + 重均衡 FR-M3-03/04（1c6c15c） |
| 5 | ~~Historian 位号选择器：自定义预设保存、量程外数据提示~~ | P2 | S | ✅ 5c5c511 |

## 二、认证与安全加固（Phase 1 收尾）

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 6 | 首登强制改密 + 口令复杂度校验 | P0 | S | 种子口令目前为弱口令 |
| 7 | 会话持久化（网关重启不掉线）+ 会话列表/踢出 | P1 | S | 当前会话在内存 |
| 8 | 全局请求限速 + 登录失败锁定（5 次/10 分钟） | P1 | S | 防爆破 |
| 9 | ESLint + Prettier + CI（typecheck/lint/build 流水线） | P0 | S | 工程底线 |
| 10 | 关键路径自动化测试：引擎单测（标度/告警状态机/Modbus 解析）+ API 冒烟测试 | P1 | M | 重构安全网 |

## 三、告警与通知增强

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 11 | 钉钉/企微/邮件**真实端点投递验证** + 钉钉签名联调 | P0 | S | 代码+模板就绪，缺真实机器人地址（用户明确推后） |
| 12 | ~~通知消息模板可配置（标题/内容模板变量）~~ | P2 | S | ✅ 4652b8b：10 变量全渠道渲染 + UI 编辑 |
| 13 | ~~告警确认机制（Acknowledge + 操作员备注）~~ | P1 | M | ✅ FR-M10-01 已完成 |
| 14 | ~~告警规则：变化率(ROC)类型~~ | P2 | S | ✅ 随告警引擎完成 |

## 四、协议与诊断深化（Phase 2）

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 15 | ~~S7 写入探针优化（多位号探针循环）+ OPC UA 订阅式连接测试~~ | P1 | S | ✅ 377572f：S7 全位号单 PDU 批量读、OPC UA MonitoredItem 订阅采样 |
| 16 | ~~MELSEC / EtherNet-IP / FINS 驱动（Phase 2 协议）~~ | P2 | L each | ✅ 三驱动+连接测试（9f520b5）已上线，演示环境 6 通道在线 |
| 17 | ~~报文诊断真实化（驱动层 hook，Modbus 先行）~~ | P2 | M | ✅ 四二进制驱动帧级 TX/RX 已 hook |
| 18 | ~~地址语法在线校验器（shared schema 扩展）~~ | P1 | M | ✅ FR-M2-12 已完成 |

## 五、部署与运维（Phase 2）

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 19 | docker-compose 一键栈（gateway + console nginx + TDengine + 三模拟器） | P0 | S | 演示与交付基础 |
| 20 | ~~网关 Windows 服务 / Linux systemd 打包~~ | P1 | M | ✅ deploy/：systemd 单元 + WinSW 包装（安装/卸载脚本）+ 部署指南与健康检查/排障速查 |
| 21 | 北向 MQTT/Sparkplug B 上报 + Reliable Outbox（决策 D7） | P1 | L | PRD FR-M9-03 |
| 22 | ~~设备影子真实实现~~ | P2 | M | ✅ FR-M9-04（d3d1af2）：reported/desired 双快照 + pending 收敛 + MQTT retain 快照 + REST |

## 七、Go/Node 下线门禁（持续推进）

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 26 | ~~设备级灰度 UI~~ | P0 | S | ✅ 详情页支持 auto/Go/Node；管理员可写，非管理员只读，失败回滚 |
| 27 | 全协议 Go/Node 双后端 E2E 对比 | P0 | L | ✅ 基础门禁已通过；仍需补齐读写、质量码、异常、重连、写入幂等和性能结果后关闭 Node 下线门禁 |
| 28 | ProtoForge 故障演练矩阵 | P0 | L | TDengine、BACnet、SNMP、PLC、OPC UA 的断网/恢复/重启/首包丢失逐项留证 |
| 29 | 真实设备现场回归与 7 天连续运行 | P0 | L | S7-1200/1500、SNMP 设备、OPC UA Server 及关键 PLC 场景 |
| 30 | ~~灰度切换、回滚和升级演练~~ | P0 | M | ✅ 本地最终切换已完成：前端默认代理 Go `18080`，Node `18081` 已停止；Node 代码、配置和启动脚本保留用于回滚。生产升级回滚演练仍需另行安排 |

### 双后端下线门禁执行工具

新增 `scripts/compare-gateways.ps1`，用于在 Go/Node 同时运行时执行同口径检查：登录、配置拓扑、通道参数与状态、实时采样数量、TDengine 健康状态。脚本退出码为 0 才允许进入下一轮灰度；可通过 `-OutputFile` 留存 JSON 证据。

当前执行结果（2026-09-24）：Go 网关 `18080`、Node 网关 `18081` 均健康，TDengine 两端 online，双后端均可登录并持续产生实时采样；基础门禁仍未关闭，当前唯一状态差异是 OPC UA：Go 对 ProtoForge/当前模拟服务返回的无效 NodeId 严格置为 offline，Node 仍将监控创建后的通道标记为 online。前端因 Windows 对 `3000` 端口返回 `EACCES`，已临时在 `32123` 启动，待环境端口策略解除后恢复标准端口。

2026-09-22：首轮恢复 Node 对比实例时发现 FINS 短响应会在 Node 驱动中触发 `Buffer.readUInt16BE` 越界并导致进程退出；已增加短帧拒绝保护，并补充 Node TDengine 非有限采样过滤，避免 `NaN/Infinity` 将存储管道拖入 offline。修复后的 Node 实例仍需完成稳定运行窗口和双后端证据脚本。

2026-09-22（双后端对比首轮）：配置拓扑 10 通道/37 位号一致，Go/Node 均有实时采样，TDengine 两端 online；门禁仍失败于通道状态差异：Node 的 FINS 返回 `response too short: 22B`、MELSEC 超时、EtherNet/IP `status 0x1`、MQTT 无 Broker、IEC104 断开。Go 端继续作为目标实现，以上差异进入协议故障矩阵和 Node 下线评审，不宣称 Node 已下线。

2026-09-22（协议兼容修复与基础门禁通过）：修复 Node MELSEC MC 3E 目标模块字节序（`FF 03`）、兼容 ProtoForge 返回的 `0x5000` 响应头；修复 Node EtherNet/IP 使用 `B2 + 直接 CIP` 的标准 Unconnected Data 封装、Read Tag 服务码 `0x4C` 及 `CC` 响应解析；FINS 标准 TCP 前缀修复继续生效。使用 ProtoForge 真实服务和项目 MQTT 开发 Broker 联调，Go/Node 均为 10 通道、37 位号，通道状态、实时样本和 TDengine 均通过，证据写入 `docs/artifacts/gateway-compare-latest.json`，门禁结果 `pass=true`。ProtoForge 当前未安装 `amqtt`，MQTT 使用项目完整 aedes Broker；IEC104 当前无可用模拟服务，双方保持 offline，仍需进入故障演练与现场回归清单。

2026-09-22（TDengine Outbox 恢复治理）：真实 TDengine 容器退出后恢复，双后端 Outbox 累积约 1.3 万条并触发 `SQL statement too long`；Go/Node 写入器新增单次最多 500 条的分段提交，Go 新增大批量分段单测。容器恢复后队列按段冲刷，Go/Node TDengine 均回到 online，拓扑、状态和实时样本门禁再次 `pass=true`。下一步继续补写入幂等、故障重连矩阵和 IEC104 可用模拟服务。

2026-09-22（EtherNet/IP 写入真实性修复）：使用 ProtoForge AB 真实 TCP 服务抓取 Go/Node 报文，确认 Go 返回 `CIP response status 0x04` 是有效错误；Node 原先只校验 ENIP 封装状态，收到 `CD 00 04 00` 仍返回 `ok=true`，属于假成功。已修正 ProtoForge AB 按 CIP PathSize 截断写入路径，Go/Node 均校验 CIP 状态；Go 的隐式 EtherNet/IP 槽位与 Node 对齐为 1，显式 `params.slot` 仍可覆盖。新增 `scripts/run_iotconnector_ab.py` 作为持久在线联调实例，Go 对 `enip-01` 的真实写入已通过。Node 运行实例需重载新驱动后再完成双端写入证据；Node 下线门禁仍未关闭。

2026-09-22（协议写入与存储恢复）：恢复项目 MELSEC/FINS 模拟器（MELSEC 使用配置端口 `11022`，FINS 使用 `19600`），修复 Node MELSEC/FINS 后台轮询与写入共享 pending 请求造成的 `Error: overridden`，两端 MELSEC、EtherNet/IP、FINS 写入探针全部通过，证据见 `docs/artifacts/protocol-write-latest.json`。TDengine 容器完成重启恢复；Windows 环境 Go/Node 统一使用 `http://localhost:6041`，规避 IPv4 回环 REST 超时，Go Outbox 从约 2.1 万条分段冲刷至个位数。最新双后端基础门禁 `pass=true`，证据见 `docs/artifacts/gateway-compare-latest.json`。

## 六、i18n 与体验

| # | 任务 | 优先级 | 工作量 | 说明 |
|---|---|---|---|---|
| 23 | i18n 词典覆盖存量页面（Dashboard/Diagnose/Device/Historian 深层文案） | P1 | M | 框架已就绪，机械迁移 |
| 24 | 统一 Toast 组件（替代 window.alert 与散落的 toast state） | P1 | S | UI 规范 §5.6 |
| 25 | ~~实时值变化高亮动画（TagValue 组件化）~~ | P2 | S | ✅ 50dd95f：TagValue 组件 + 400ms transition-colors |

---

### 建议下一迭代（Sprint 1，约 1-2 周）

**P0 打包**：#1 存储任务引擎 + 页面、#2 配方下发、#6 首登改密、#9 CI、#11 通知真实联调、#19 compose 栈。
完成后即可对真实工厂做第一次受限试点（Modbus + S7 场景）。

## 2026-09-22 继续推进记录

- 新增 `scripts/fault-matrix.mjs`，使用 Node 原生 HTTP、端口 PID 定位和受控模拟器重启执行真实故障演练；PowerShell 版本 `scripts/fault-matrix.ps1` 保留用于兼容调用。
- Go 网关真实演练已通过：MELSEC、FINS、MQTT/Sparkplug B 均完成“停止模拟器 -> 网关进入 offline -> 恢复模拟器 -> 回到 online -> 实时采样恢复”。三项结果见 `docs/artifacts/fault-matrix-passed-3.json`，恢复耗时约 6.9~9.8 秒，live sample 数量保持 17。
- EtherNet/IP 模拟器已支持 `ENIP_SIM_PORT`，并修正 `0xB2 + 直接 CIP`、`0x4C Read Tag`、CIP 响应状态和类型/长度字段；Go 驱动同时在 CIP 解析/状态错误时主动清理 session。
- EtherNet/IP 真实故障演练已通过：停止模拟器后进入 offline，恢复后回到 online，live sample `17 -> 17`，恢复约 3.8 秒，证据见 `docs/artifacts/fault-matrix-enip.json`。
- 当前故障矩阵状态：MELSEC/FINS/EtherNet-IP/MQTT 已完成第一轮；S7、SNMP、OPC UA、BACnet、IEC104 仍需分别完成可用模拟器/现场设备故障演练；TDengine 磁盘不足和长期堆积仍未关闭。
- SNMP 第一轮故障矩阵已完成：停止项目 SNMP Agent 后 Go 通道严格经历 `online -> offline -> online`，实时样本 `20 -> 20`，证据见 `docs/artifacts/fault-matrix-snmp.json`。故障脚本现要求实际状态进入 offline/error，不再仅以端口消失判定。
- 2026-09-24：补齐故障矩阵 S7/OPC UA 模拟器重启映射；S7 真实演练通过，`online -> offline -> online`，恢复约 3.4 秒，证据见 `docs/artifacts/fault-matrix-s7.json`。OPC UA 端口可恢复，但当前配置中的 `ns=2;i=2/3/4` 与运行服务地址空间不匹配，Go 正确保持 offline，证据见 `docs/artifacts/fault-matrix-opcua.json`，后续需先统一 ProtoForge 节点模型/地址再关闭该门禁。
- 2026-09-24（任务 2 推进）：将 OPC UA 运行配置统一为模拟器真实节点 `ns=2;s=Pressure_Sensor_01`、`Flow_Sensor_01`、`Welder_001_WeldingVoltage`、`Valve_01_Opening`；Go/Node 均恢复 online，基础双后端门禁 `pass=true`。补齐 Go OPC UA Double 写入映射，Go/Node 对压力与焊接电压写入均通过，证据见 `docs/artifacts/gateway-compare-latest.json`、`docs/artifacts/protocol-write-opcua.json`。通用 MELSEC/FINS/EtherNet-IP 写入对比也通过，证据见 `docs/artifacts/protocol-write-gate.json`。
- 2026-09-24（任务 2 下一阶段）：双后端门禁新增实时位号集合/质量码一致性检查；当前 Go/Node 均返回 21 个实时位号且质量码全部为 `Good`，证据见 `docs/artifacts/gateway-compare-quality.json`。S7 双后端断线恢复实测通过：两端同时经历 `online -> offline -> online`，并恢复实时采样；下一步继续覆盖其余协议的双后端异常与质量码场景。
- 2026-09-24（任务 2 重连修复）：MELSEC 与 FINS Node 驱动在轮询超时后增加失效 socket 清理、pending 请求释放、轮询定时器重建和自动重连；此前模拟器重启后 Node 会永久 offline，现 MELSEC 双后端断线恢复通过，且 FINS 修复后双后端当前状态重新一致。`gateway-compare-latest.json` 已恢复 `pass=true`；Node TypeScript 类型检查通过。
- 2026-09-24（任务 2 协议恢复扩展）：EtherNet/IP、OPC UA、SNMP 模拟器分别完成重启恢复验证，Go/Node 均恢复 online；发现并修复 Node OPC UA `connection_lost` 仅更新状态而不调度重连的问题。Node 类型检查通过，最终双后端门禁配置、通道状态、实时采样、TDengine 和质量码均 `pass=true`，证据见 `docs/artifacts/gateway-compare-latest.json`。
- 2026-09-24（任务 2 幂等与性能）：Go/Node 对 MELSEC、FINS、EtherNet/IP、OPC UA 共 5 个代表性位号执行重复相同写入，两端均 10/10 次成功，未出现 transport error 或假成功，证据见 `docs/artifacts/gateway-write-idempotency.json`。同时完成 `/api/tags/live` 20 次延迟采样：Go p50 8.50ms/p95 28.68ms，Node p50 3.30ms/p95 5.41ms；该结果为当前本机基线，不能替代高并发压力测试。
- 2026-09-24（任务 2 压力基线）：新增 `scripts/gateway-load.mjs`，以并发 10、每网关 100 次 `/api/tags/live` 请求执行同口径压力验证；Go/Node 均 100/100 成功、错误率 0%，Go p95 38.15ms/p99 42.54ms，Node p95 30.20ms/p99 36.35ms。证据见 `docs/artifacts/gateway-load-latest.json`。当前仅为本机轻量基线，尚未达到生产压力门槛。
- 2026-09-24（任务 2 高并发与 Soak）：并发 50、每网关 500 次请求均成功，Go/Node 错误率 0%，P95 分别为 122.51ms/108.01ms，证据见 `docs/artifacts/gateway-load-high.json`；随后并发 20、每网关 3000 次请求均成功，错误率 0%，Go/Node P95 分别为 25.88ms/22.45ms，证据见 `docs/artifacts/gateway-load-soak.json`。压测结束后双后端门禁仍 `pass=true`。这属于本机短时稳定性验证，生产级 30 分钟/7 天连续运行仍未关闭。
- 2026-09-25（任务 2 长稳观察启动）：新增 `scripts/gateway-stability.mjs`，已后台启动 30 分钟观察（每 5 秒采样 Go/Node 健康、通道、实时位号、质量码和 TDengine 队列），完成后生成 `docs/artifacts/gateway-stability-30m.json`。观察期间不改变现有服务和协议模拟器。
- 2026-09-25（TDengine 真实重启恢复）：30 分钟观察期间 TDengine REST/恢复过程出现超时与连接重置，Go/Node 存储均进入 offline；观察结果见 `docs/artifacts/gateway-stability-30m.json`，该轮不通过，未将存储故障误判为 Go 协议故障。重启 `aurasense-tdengine` 后发现 Windows Docker 的 `6041` 转发仍不稳定，备用映射 `127.0.0.1:16041` 在容器恢复完成后稳定返回 REST 200；两个网关均切换到该地址并受控重启，Go 持久化 Outbox 从约 7.9 万条冲刷至 0，Node 队列恢复至个位数。期间未清理 Go Outbox，Node 原有队列已发生既有溢出丢弃，最终 Go/Node `storage=online`。
- 2026-09-25（恢复后稳定性门禁）：修正 `scripts/gateway-stability.mjs` 的 `minLiveCount` 空集合计算误报；Go/Node 各 12 次、共 1 分钟观察均无 HTTP 失败、无坏质量码、存储全程 online，实时位号最少 21 个，门禁通过。证据见 `docs/artifacts/gateway-stability-recovery-final-1m.json`。Go/Node 当前均为 7/10 通道在线、21 个实时位号，Go 运行参数恢复为 `GATEWAY_GO_DRIVER_MODE=go`；30 分钟生产级长稳和 7 天连续运行仍未关闭。
- 2026-09-25（30 分钟稳定性重测通过）：两个网关通过 `http://127.0.0.1:16041` 连接 TDengine，分别完成 345 次、每 5 秒一次观测；Go/Node 均 `failures=0`、`badQualityObservations=0`、`storageOfflineObservations=0`、`minLiveCount=21`，最大 Outbox 分别为 26/53，最终门禁 `pass=true`。证据见 `docs/artifacts/gateway-stability-30m-retest-16041.json`。30 分钟长稳门禁关闭；7 天连续运行与现场设备回归按用户决定暂缓，保留为后续条件具备时执行。当前剩余为最终灰度/Node 下线评审。
- 2026-09-25（最终灰度切换与 Node 下线评审完成）：复核双后端对比门禁 `gateway-compare-pre-cutover.json` 为 `pass=true`，前端 Vite 默认代理确认指向 Go `18080`；通过前端代理完成 `admin/admin123` 登录、通道列表和实时值验证（10 个通道、7 个在线、21 个实时位号、坏质量码 0）。随后停止 Node 网关 `18081`，端口已关闭，Go `18080` 与前端 `32123` 保持健康，TDengine 经 `16041` 在线。Node 源码、配置和启动脚本未删除，保留回滚能力；本地 Go 主用切换完成。
- 2026-09-25（Go-only 运维入口）：新增 `scripts/start-go-gateway.ps1`，默认使用 `GATEWAY_GO_DRIVER_MODE=go` 和 TDengine `16041`，检测到 `18080` 已运行时幂等退出，不会重新启动 Node。脚本验证通过，Go 全量 `go test ./...` 通过；当前 Go/前端健康、TDengine online 且 Outbox 为 0。
- 2026-09-25（Go 主用 CI 门禁）：更新 `.github/workflows/ci.yml`，加入 Go 版本解析、`go test ./...`、`go vet ./...` 和 `go build ./cmd/factorybridge`；本地 Node/前端 typecheck、Go vet 和 Go 构建均通过。Go 主用后续改动现进入 CI 自动校验范围。
- 2026-09-25（Go 脚本资源配额）：脚本 worker 增加请求体 256 KiB、代码 64 KiB、单行输出 2 KiB、总输出 64 KiB、单次写入值 4 KiB 和最多 50 次写入限制；脚本 API 对超大代码返回 `413`。新增 worker 限额测试，Go 全量测试、vet 和构建通过，脚本资源配额任务关闭。
- 2026-09-25（Node 回滚入口）：新增 `scripts/start-node-rollback.ps1`，仅在 `18081` 未占用时启动 Node 回滚实例，使用 TDengine `16041`，不会启动 Go 或修改前端代理。已完成脚本静态检查，当前 Node 仍保持下线；实际回滚演练按生产升级窗口另行执行。
- 2026-09-25（本地 Go→Node→Go 回滚演练）：启动 Node 并将前端代理切至 `18081`，完成登录、健康、10 个通道、7 个在线通道、21 个实时位号和质量码检查；随后恢复 Go `18080`、关闭 Node、将前端代理切回 Go，恢复后同等检查通过。Node 最终保持下线，Go 主用恢复。启动脚本端口检查改为最长 15/20 秒重试，避免慢启动误报失败。
