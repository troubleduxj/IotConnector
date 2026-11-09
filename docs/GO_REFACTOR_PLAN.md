# Factory Bridge Go 网关重构方案

> 注：Node 网关（apps/gateway）与 packages/shared 已于 2026-11-09 删除；共享代码在 apps/console/src/shared，模拟器在 tools/sim。下文保留原计划的描述。

> 文档状态：提案，可作为下一阶段技术设计与任务拆分基线
>
> 更新时间：2026-09-14
>
> 适用范围：`apps/gateway` 后端运行时；`apps/console` 前端暂不重写

## 1. 执行摘要

当前项目已经具备试点级产品形态：React 控制台、Fastify 网关、共享类型包、10 类协议驱动、实时 WebSocket、TDengine 存储、MQTT/Sparkplug、告警、配方、脚本和服务化部署均已存在。

Go 重构具有长期价值，但不适合一次性推倒重来。推荐采用“接口先行、核心渐进替换、协议分批迁移、双运行对比”的路线：

```text
现有 React 控制台
        |
REST + WebSocket + 配置/事件契约保持兼容
        |
Go Gateway（目标主运行时）
  ├─ API / Auth / RBAC
  ├─ Acquisition Engine
  ├─ Protocol Drivers
  ├─ Storage / Outbox / Shadow
  └─ Alarm / Recipe / Audit
        |
  设备、TDengine、MQTT、文件系统
```

迁移期间允许 Node 与 Go 并存：Node 继续承担尚未迁移或验证不足的协议，Go 先承接采集引擎、核心协议和可靠性能力。只有在现场回归和指标达标后，才将 Go 设为默认网关。

### 当前实施进度

2026-09-14 已完成第一批骨架工作：

- `apps/gateway-go` Go module 和标准启动入口已建立。
- 已兼容读取现有 `apps/gateway/data/config.json`，当前可识别 10 个通道、37 个位号。
- 已加入 schema 版本检查入口和临时文件 + sync + rename 的原子配置写入。
- 已加入 `Driver`、`Sample`、`Engine`、运行时快照和通道状态模型。
- 已加入 fake driver 单元测试，覆盖启动、采样、写入、停止和错误路径。
- Go 骨架提供 `/api/health`、`/api/system/info`、`/api/channels`、`/api/tags/live`。
- 已接入首个真实协议：Go Modbus TCP 驱动支持 1-based 地址、FC01/02/03/04 读取、FC05/06 写入、常用整数/浮点类型和 32 位字节序。
- 2026-09-20 Go BACnet/IP 驱动已接入 `GATEWAY_GO_DRIVER_MODE=go`，支持 AI/AO/AV/BI/BO/BV 的 PresentValue 批量读取、标准 WriteProperty、基础类型转换、超时和自动重连；Node 与 Go 均已使用 ProtoForge `127.0.0.1:47808` 完成 AI/AO/BI 真实读取和 AO 写入回归。ProtoForge 同步修复 Windows UDP 接收、标准 RPM/APDU、对象类型实例号和地址推断；Go `Discover` 的 Who-Is/I-Am、`SubscribeCOV` 确认/通知内容、`CancelCOV` 真实回归均已通过，ProtoForge 多设备 I-Am 已改为独立 UDP 帧并修复 process ID 回传；Go 生命周期锁与网络 I/O 锁已拆分，挂起请求可被 Stop 立即解阻塞，并新增首包丢失后同一 socket 恢复测试。现场设备回归、长期 COV 变化量和完整协议故障矩阵仍未完成。
- 已使用 `D:\Projects\sim-foundry-main` 的 ProtoForge Modbus TCP 服务完成真实联调：动态采样、连接拒绝后的 `offline` 状态、服务恢复后的自动重连均通过。
- 已加入基础 Bearer Token 保护和写入 JSONL 审计；配置 `GATEWAY_GO_API_TOKEN` 后，通道、实时值和写入接口需要认证。
- 已加入最小 RBAC：Viewer 只读，Operator 可写，Admin 继承全部当前 API 权限；兼容 Token 默认按 Operator 处理。
- 已加入基础密码登录、随机 Session Token、TTL 和注销；密码支持 bcrypt 哈希，Session 已持久化为 Token 摘要，重启后可恢复未过期会话。
- 已加入首登改密和密码复杂度策略；密码记录写入 `auth.json`，采用临时文件 + rename 更新。
- 已加入 CORS 来源白名单和认证失败限速；配置 `GATEWAY_GO_CORS_ORIGINS` 后仅允许列出的浏览器来源。
- 当前仍未接入完整 RBAC、TDengine 和前端流量；Go 已接入兼容 Node 的 WebSocket `hello`、订阅快照、实时批次、通道状态和写入结果，并在握手阶段执行认证。Node 网关仍是生产行为基线，Go Token 层不能替代最终用户会话体系。

2026-09-15 前端切流冒烟已通过：

- 控制台支持 `VITE_GATEWAY_URL`，可将 REST 和 WebSocket 同时指向 Go 网关；未配置时继续使用同源/Vite 代理。
- Go 已兼容首屏所需的登录、会话恢复、配置、标签、调度、告警空态、历史空态、实时快照和 WebSocket 链路。
- 使用 `http://127.0.0.1:3001` 直连 `http://127.0.0.1:18081` 验证通过：登录、Dashboard 渲染、ProtoForge 通道在线、2 个实时位号更新、进程重启后 Session 恢复均通过。
- 这只是首屏和实时监控灰度标准；历史数据、告警规则 CRUD、设备管理写配置、存储任务、配方、脚本、北向和系统运维接口仍未达到 Go 全量切流标准。
- 设备管理 CRUD 已于同日完成真实联调：通道/位号新增、修改、删除会原子持久化并触发采集引擎重载；完整协议参数校验和导入导出仍待补齐。
- Go 已加入内存历史缓冲、历史查询 DTO、告警规则 CRUD、high/low/deviation/roc 基础评估、告警确认和 WebSocket 告警事件；TDengine 持久化与断电恢复仍待完成。
- Go 历史缓冲已升级为 `history.jsonl` 追加落盘，启动时恢复最近数据并跳过损坏行；TDengine writer、真实历史查询和 `outbox.json` 断线队列已接入主进程，并已用 ProtoForge Modbus + TDengine 完成采样写入和历史查询联调。
- Go 已补齐存储任务配置 CRUD、运行统计兼容接口和系统存储探针；任务触发执行器及告警事件 TDengine 落库仍作为下一阶段可靠性工作。
- 已完成 TDengine 真实断网/恢复/Go 重启演练：断网期间采样继续、`outbox.json` 增长且无丢弃；数据库恢复后队列自动回放并回到 `online`；数据库离线时重启 Go 可恢复未回放队列。
- Go 已加入规则级 `minIntervalSec` 抑制、全局每分钟告警风暴上限（默认 100 次）、通知配置 CRUD、Webhook 测试和 Active 告警投递；钉钉签名、企微、SMTP 适配及通知可靠队列待补。
- Go 已补齐 Device Shadow 查询和北向 MQTT/Sparkplug 配置兼容接口，影子可返回 `reported/desired/pending`；MQTT 实际连接、BIRTH/DDATA/NDEATH/CMD 和影子发布仍待接入 Go runtime。
- Go 已接入 Paho MQTT 后台连接/重连、NDEATH Will、NBIRTH/DBIRTH/DDATA protobuf 子集、序列号持久化和断线北向 Outbox；当前配置中的 broker 不可达时仅标记离线，不阻塞网关启动，CMD/REBIRTH 订阅和完整 Sparkplug 验收待继续补齐。
- Go 已接入 STATE/CMD 订阅、JSON REBIRTH/CMD 下行写值和 HTTP REBIRTH 重发；现已补齐 Sparkplug protobuf CMD Metric 解码（数值、布尔、字符串、浮点）和 Go/Node 字符串字段编码兼容，并将 CMD 写入纳入审计。
- 北向断线 Outbox 已增加 DDATA、NBIRTH、DBIRTH 按主题合并，只保留每个主题最新快照，避免 broker 不可达或重复 REBIRTH 时堆积大量过期控制消息；已完成真实 broker 的断线回放和重启恢复验证。
- 2026-09-15 已完成真实 MQTT broker 双向演练：`18840` broker 上验证 NBIRTH、DBIRTH、DDATA、HTTP REBIRTH、protobuf CMD 写入及 `mqtt.cmd` 审计；停止 Go 联调实例后捕获 NDEATH，断线队列恢复为 0。生产级长期运行和多 broker 故障矩阵仍待补齐。
- 2026-09-15 Go Device Shadow 已接入：`shadow.json` 原子持久化、reported/desired/pending 收敛、成功写入才更新 desired、3 秒节流 MQTT retain 发布及 retain Outbox 恢复均已实现；使用 ProtoForge Modbus `5020` 真实采样验证了两个 Float 点位的 reported、retain 发布和 Go 重启恢复。
- 2026-09-21 ProtoForge 多协议联调已恢复：受控重启后通过认证 API 配置并启动 Modbus TCP `15020`、S7 `10102`、SNMP `1161`、FINS `19600`；MELSEC/EtherNet-IP 因端口占用由 ProtoForge 自动绑定到 `11022/14449`，Go 配置已同步。Go `GATEWAY_GO_DRIVER_MODE=go` 实测 S7、Modbus、SNMP、MELSEC、EtherNet/IP 在线采集，TDengine 写入/历史查询通过。Go TDengine 告警表已改为 Node 兼容的 `status/val` schema，避免既有表结构造成 9728/534 错误，重启回归 storage online。
- 2026-09-21 Go storage 增加 `NaN/Inf` 边界过滤，避免异常工程值进入 TDengine SQL；最终健康检查无 storage error，Outbox 维持低位并持续回放。当前仍需修复 BACnet RPM、OPC UA 点位映射、FINS 数据宽度和 MQTT/IEC104 模拟联调，才能关闭全协议 E2E 门禁。
- 2026-09-21 遗留协议第二批已完成点位契约对齐：ProtoForge 实际 OPC UA 节点 `ns=2;i=2/3/4`、BACnet AHU 对象和 FINS D100 UInt16 已写回 Go 配置；Go 真实状态由 5/10 提升至 8/10 在线，OPC UA/BACnet/FINS 均恢复采集。新增 MQTT 南向 Go driver（Paho 连接、自动重连、按 topic 订阅、JSON/原始值解码、写入），因 ProtoForge Python 环境缺 `amqtt` 且 pip 镜像不可达，暂只能验证连接超时与错误状态；IEC104 仍需单独实现协议栈并准备模拟端。
- 2026-09-22 已完成 IEC104 Go 驱动第一阶段：移植 APCI/ASDU 编解码、STARTDT 握手、S 帧确认、C_IC_NA 总召唤、M_SP_NA/M_ME_NC 数据解析、IOA 映射和断线重连；单测通过，运行时已能对 `12404` 生成明确连接拒绝状态。ProtoForge 没有 IEC104 server，真实数据和故障矩阵仍需外部 IEC104 模拟器或现场设备。
- 2026-09-22 已完成 MQTT 南向真实回归：使用仓库内 Aedes Broker 与 `mqtt-sim.ts` 验证 Go Paho 驱动连接、按 topic 订阅、JSON 字段路径解析、原始数值解析和自动重连；`Line1.Temp`、`Line1.Counter` 等点位持续更新，Broker 停止/恢复后通道重新 online。ProtoForge MQTT 因 Python 3.10 缺少 `amqtt` 且镜像不可达仍无法启动，但不再阻断 Go MQTT 功能验收。
- 2026-09-15 Go 配方 API 已接入：CRUD、参数变更版本递增、逐项下发、下载记录、复制、JSON 导入导出均已兼容，成功下发同步 Shadow desired 并保留审计入口；脚本执行隔离和业务级压力回归仍待补齐。
- 2026-09-15 Go 脚本 API 已接入：CRUD、手动执行、周期触发、tagChange 触发、输出环形保留、运行统计、1 秒执行超时和连续 3 次失败自动禁用；默认通过独立 worker 子进程运行 Goja，仅暴露 `Read`、`Write`、`log` 白名单 API，超时由父进程终止 worker。生产级资源配额和更强沙箱策略仍待补齐。
- 2026-09-15 Go 通知适配已扩展为通用 Webhook、钉钉签名、企业微信和 SMTP；统一测试接口与 Active 告警分发已接入四渠道。真实机器人、SMTP 账号和通知可靠队列/重试仍待验收。

### 真实协议联调记录

| 项目 | 结果 |
|---|---|
| 模拟器 | ProtoForge 源码启动，`127.0.0.1:5020` |
| Go 网关 | `127.0.0.1:18081`，使用独立 `testdata/protoforge-modbus` 配置 |
| 读取 | `40001`、`40003` Float 点位持续返回有效值，并随模拟器变化 |
| 故障 | 停止模拟器后通道变为 `offline`，记录连接拒绝原因 |
| 恢复 | 重新启动模拟器后通道自动恢复 `online`，采样恢复 |
| 注意事项 | ProtoForge 的 demo 设备启动存在短暂初始化窗口，初始 0 值不能直接判定为通信失败 |

## 2. 当前基线与重构动机

### 2.1 已确认基线

- monorepo：`apps/console`、`apps/gateway`、`packages/shared`
- 网关入口约 1600 行，路由、启动、认证和业务编排集中在一个文件
- 当前支持 10 类协议驱动及多个本地模拟器
- 当前运行配置约 10 个通道、37 个位号
- 14 个测试文件、86 个测试通过
- TypeScript 类型检查和前端生产构建通过
- 当前本地启动未设置 `TDENGINE_URL`，存储处于 disabled/offline
- 当前种子配置存在默认弱口令和未启动设备重试日志

### 2.2 为什么考虑 Go

Go 主要解决长期运行网关的工程问题：

1. 以 goroutine、context 和明确的超时取消模型管理大量设备连接。
2. 以单二进制交付，降低 Node/pnpm/依赖安装对边缘设备的要求。
3. 提高协议解析、批量采集和数据写入的可预测性。
4. 方便通过进程边界隔离脚本、驱动和高风险操作。
5. 更适合做资源限制、优雅停机、崩溃恢复和系统服务集成。

### 2.3 不应把 Go 当作当前所有问题的答案

下列问题与语言无关，应在迁移前后立即修复：

- WebSocket 写入路径未做身份认证
- 多个配置和实时数据 API 未认证
- CORS 允许任意来源
- 默认账号未真正强制改密
- session token 明文落盘
- 输入校验和 API schema 不统一
- 配置文件非原子写入

## 3. 重构目标与非目标

### 3.1 目标

- 保持控制台主要 REST、WebSocket 和数据模型兼容。
- Go 网关覆盖采集、调度、实时值、告警、存储、北向上报和设备影子。
- 所有下行写入具备身份、角色、审计和幂等语义。
- 所有外部输入具备运行时 schema 校验。
- 支持 Windows/Linux 单二进制部署和优雅升级。
- 通过可重复的协议集成测试、压力测试和故障演练验收。
- 在目标规模下达到可量化的延迟、内存、重连和数据完整性指标。

### 3.2 非目标

- 不在第一阶段重写 React 控制台。
- 不在第一阶段引入微服务集群、服务网格或 Kubernetes。
- 不为了语言替换而改变现有业务语义。
- 不承诺所有协议在没有真实设备验证的情况下同时迁移。
- 不把 `node:vm` 直接等价替换成 Go 内嵌脚本执行；脚本应单独设计隔离边界。

## 4. 目标架构

### 4.1 进程与模块边界

建议先保持单一 Go 网关进程，内部按包拆分：

```text
cmd/factorybridge/
internal/
  api/                 REST、WebSocket、OpenAPI
  auth/                用户、会话、RBAC、限速
  config/              schema、迁移、原子持久化
  domain/              Channel、Tag、Alarm、Recipe 等领域模型
  acquisition/         调度器、驱动生命周期、批量 flush
  protocol/
    modbus/
    s7/
    opcua/
    mqtt/
    melsec/
    fins/
    enip/
    snmp/
    bacnet/
    iec104/
  storage/              TDengine、队列、历史查询
  northbound/            MQTT/Sparkplug、Outbox、CMD
  alarm/                 告警状态机和通知
  recipe/                配方校验与批量下发
  shadow/                reported/desired 状态
  audit/                 审计事件
  observability/         metrics、日志、trace、health
pkg/protocol/             可复用协议模型或接口
```

`cmd` 只负责启动和依赖组装。HTTP handler 不直接操作文件、设备或数据库，所有写操作通过 service 接口完成。

### 4.2 核心接口

```go
type Driver interface {
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
    Read(ctx context.Context, tags []Tag) ([]Sample, error)
    Write(ctx context.Context, tag Tag, value Value) error
    Test(ctx context.Context, tags []Tag) TestResult
    Stats() DriverStats
}

type SampleSink interface {
    Publish(ctx context.Context, samples []Sample) error
}

type Storage interface {
    Enqueue(ctx context.Context, samples []Sample) error
    QueryHistory(ctx context.Context, req HistoryQuery) (HistoryResult, error)
    Health(ctx context.Context) StorageStatus
}
```

接口重点是显式传入 `context.Context`、区分工程值和原始值、返回结构化错误，并且所有操作都能注入 fake 实现进行测试。

### 4.3 事件模型

采集、告警、存储和北向发布之间不要互相调用具体实现，统一通过内部事件模型传递：

```text
Driver -> SampleEvent ->
  Runtime cache
  WebSocket broadcaster
  Alarm evaluator
  Storage queue
  Device shadow
  Northbound publisher
```

事件应包含：`eventId`、`tagId`、`channelId`、`value`、`rawValue`、`quality`、`sampleTs`、`receivedTs`、`sequence`。

## 5. 兼容契约

### 5.1 HTTP

Go 版本必须继续支持当前控制台使用的主要端点，迁移期间以现有 OpenAPI 清单为契约来源。建议将 OpenAPI 从手写对象改为独立版本化文件：

- `docs/api/openapi.v1.yaml`
- CI 校验 Go 路由是否覆盖契约
- 破坏性变更使用 `/api/v2`

### 5.2 WebSocket

保留现有消息类型：`hello`、`tags-batch`、`channel-status`、`storage-status`、`alarm`、`write-result`，但增加认证握手：

```text
client -> { type: "auth", token: "..." }
server -> { type: "auth-result", ok: true, user: {...} }
client -> { type: "subscribe" }
```

认证成功前不得推送敏感数据，也不得接受 `write` 消息。

### 5.3 配置和数据格式

- 保持现有 JSON 配置可导入。
- 增加 `schemaVersion` 迁移链。
- Go 不直接复用 Node 的内部结构，使用显式 DTO 和迁移器。
- 对敏感字段使用加密存储或外部 secret 引用。
- 对配置写入采用临时文件、fsync、rename、备份保留。

## 6. 协议迁移策略

不要按代码目录顺序迁移，按业务价值、生态成熟度和验证成本排序。

| 批次 | 协议 | 建议 | 原因 |
|---|---|---|---|
| A | Modbus TCP | 首批 Go 原生迁移 | 边界清晰、测试容易、现场覆盖广 |
| A | IEC104 | 首批 Go 原生迁移 | 当前已有自研 codec，适合先建立二进制协议范式 |
| B | MQTT/Sparkplug | 第二批迁移 | Go 生态成熟，便于同时验证 Outbox 和 CMD |
| B | SNMP | 第二批迁移 | 轮询模型简单，便于验证驱动抽象 |
| C | S7 | 真实设备验证后迁移 | 库和 PLC 兼容性需要现场回归 |
| C | MELSEC/FINS/ENIP | 按客户设备优先级迁移 | 需要针对设备型号和地址语义做验证 |
| D | OPC UA | 最后迁移 | 安全策略、证书、订阅和重连复杂，不能只做连通性验证 |
| D | BACnet/IP | 最后迁移 | UDP、设备发现、对象类型和同机端口约束需要专项测试 |

迁移协议的完成标准不是“编译通过”，而是：读、写、断线、重连、超时、坏质量、批量地址、长时间运行和真实设备回归全部通过。

## 7. 安全与可靠性基线

### P0 安全要求

1. REST 除健康检查和登录外默认要求 Bearer/Cookie 认证。
2. WebSocket 完成认证握手后才发送数据和接受写操作。
3. 写值、配方下发、脚本运行、恢复出厂必须经过角色授权和审计。
4. 登录失败按账号和来源地址双维度限速。
5. 默认管理员首次登录必须改密，且密码有复杂度要求。
6. session 只保存 hash 或使用 HttpOnly Cookie，不保存明文 token。
7. 生产 CORS 使用显式白名单。
8. 敏感配置不得通过普通 GET 直接返回明文密码和密钥。
9. 脚本执行放到独立 worker/process，设置 CPU、内存、时长和并发限制。
10. 所有恢复出厂、删除存储表、批量下发操作增加二次确认和审计关联 ID。

### 可靠性要求

- 每个驱动都有 context 超时和可取消 Stop。
- 单个驱动异常不得导致网关进程退出。
- 配置更新失败不得破坏正在运行的旧配置。
- Outbox 使用可恢复的分段文件或嵌入式数据库，不依赖一次性完整 JSON 覆盖。
- 队列溢出、数据丢弃、设备重连风暴和存储离线必须产生可观测告警。
- 优雅停机顺序：停止新写入 -> flush 事件 -> 持久化状态 -> 停止驱动 -> 关闭 HTTP。

## 8. 迁移阶段

### Phase 0：冻结契约和修复高风险问题

目标：不改变业务能力，先建立可迁移的安全与测试基线。

- 修复 WebSocket 未认证写入。
- 统一 REST API 认证中间件。
- 修复默认密码和首登改密。
- 补齐 API、WebSocket、配置迁移和权限测试。
- 固化 OpenAPI、JSON fixture、事件 fixture。
- 记录当前 Node 的延迟、内存、CPU、采样吞吐和重连行为。

### Phase 1：Go 骨架和兼容层

目标：Go 服务能启动、健康检查、登录、读取配置、提供兼容 API，但暂不接管设备。

- 创建 Go module 和标准目录。
- 实现配置加载、schema migration、原子写入。
- 实现 Auth/RBAC、健康检查、OpenAPI。
- 实现 REST DTO 和 WebSocket 认证握手。
- 用 fake driver 提供模拟采样。
- 让现有控制台可以切换到 Go 地址并完成登录、Dashboard、诊断只读链路。

### Phase 2：采集核心与第一批协议

目标：Go 接管调度、实时值和 Modbus/IEC104。

- 实现 driver registry、生命周期、相位错开和 context 管理。
- 实现工程值转换、质量码、批量 flush。
- 迁移 Modbus TCP。
- 迁移 IEC104 codec/driver。
- 实现 WebSocket 实时推送。
- 与 Node 并行采集同一模拟器，对比样本和状态。

### Phase 3：持久化和北向能力

目标：形成可断网运行的 Go 端到端闭环。

- 实现 TDengine writer、历史查询和断线队列。
- 迁移 MQTT/Sparkplug B。
- 实现磁盘 Outbox、序列号、重传和去重策略。
- 迁移 Device Shadow。
- 实现存储、北向和队列指标。

### Phase 4：高级协议和业务能力

目标：按真实客户设备优先级继续替换 Node 驱动和业务服务。

- S7 读写和真实 PLC 回归。
- MELSEC/FINS/ENIP/SNMP。
- OPC UA 安全连接、订阅、证书和重连。
- BACnet 对象读写和端口冲突场景。
- 告警、配方、脚本、通知和审计迁移。

### Phase 5：双运行、切换和下线 Node

目标：Go 成为默认网关，Node 进入兼容回滚阶段。

- 采集结果双写对比。
- 设备级灰度开关。
- 现场连续运行至少 7 天。
- 故障注入：设备断网、TDengine 断网、MQTT 断网、进程重启、磁盘空间不足。
- 完成回滚文档和升级包。
- 连续两个发布周期无 Node 依赖后再下线 Node 网关。

## 9. 测试与验收

### 9.1 自动化测试层级

| 层级 | 内容 | 最低要求 |
|---|---|---|
| 单元测试 | codec、地址解析、标度、告警、队列、配置迁移 | 核心包覆盖率 80% |
| 驱动集成测试 | 各协议模拟器读写、超时、重连 | 每个已迁移协议至少一套 |
| API 测试 | 认证、RBAC、幂等、错误码、敏感字段脱敏 | 所有写接口 |
| WebSocket 测试 | 握手、订阅、断开、未认证写入拒绝 | 必须覆盖 |
| 压力测试 | 点位数、采样周期、批量 flush、内存 | 覆盖目标规模 1x 和 2x |
| 故障演练 | 设备/存储/MQTT/磁盘/进程异常 | 结果可重复 |
| E2E | 登录、Dashboard、诊断写值、历史、告警 | Node/Go 双后端均通过 |

### 9.2 建议目标指标

这些是验收目标，不是当前已达成指标：

- 10,000 点位、1 秒采集周期下 CPU 和内存稳定。
- 100ms 采集周期场景下无未解释的调度漂移。
- 端到端实时显示 P95 延迟不超过 1 秒。
- 单设备断线不影响其他设备采集。
- 网关重启后配置、影子、Outbox 和序列号可恢复。
- TDengine 恢复后队列按序补写，丢弃数据可追踪。
- 关键 API 错误响应结构统一，未认证写入全部返回 401/403。

## 10. 任务列表

### 当前执行状态（2026-09-15）

| 状态 | 范围 | 说明 |
|---|---|---|
| ✅ 已完成 | Go 网关骨架、配置兼容、Session/RBAC 基础、Modbus TCP、WebSocket、历史 JSONL、TDengine 数值写入与查询、存储任务基础执行 | 已通过 Go 单测、vet，并完成 ProtoForge Modbus + TDengine 真实联调 |
| 🟡 进行中 | 告警通知、Outbox 长期可靠性、全量 E2E、协议现场回归、脚本资源治理 | MQTT/Shadow、配方、脚本核心链路和真实 broker/ProtoForge 回归已完成；仍不能视为完成生产切流 |
| 🟡 进行中 | 全量 E2E、性能基线、7 天运行、设备级灰度开关、升级回滚、Node 下线 | registry 已具备全局 Go/显式驱动/legacy 回滚矩阵；运行时设备级配置与完整切流评审仍待完成 |
| ⛔ 外部依赖 | 告警通知真实端点、真实 PLC/OPC UA 证书与现场设备回归 | 需要测试地址、证书或现场设备条件 |

### 本轮执行顺序

1. 完成钉钉/企微/SMTP 适配及通知可靠投递。
2. 完成 Outbox 长期压测、磁盘不足演练和统一 metrics。
3. 完成全量 API/E2E、性能基线和协议现场回归。
4. 完成脚本 worker 资源治理、灰度开关和双后端切流。
5. 完成 7 天连续运行、升级回滚和 Node 下线评审。

优先级：P0 必须先做；P1 迁移主线；P2 扩展和优化。工作量：S 半天至 1 天，M 2-3 天，L 约 1 周，XL 1-2 周以上。

### P0：迁移前置与安全基线

| ID | 任务 | 工作量 | 依赖 | 完成标准 |
|---|---|---:|---|---|
| GO-P0-01 | 修复 WebSocket 认证和写入审计 | M | 无 | ✅ Go 已完成握手认证、订阅前置、写入审计；完整用户会话和资源矩阵待迁移 |
| GO-P0-02 | REST 认证中间件和敏感 GET 收口 | M | 无 | 🟡 Go 已完成 Bearer Token 和最小 RBAC；Node 兼容会话及全量敏感资源待迁移 |
| GO-P0-03 | 默认账号首登改密和密码策略 | S | 无 | 🟡 Go 已具备 bcrypt、首登改密和复杂度校验；多用户管理和密码轮换策略待补 |
| GO-P0-04 | CORS、限速和 query token 清理 | S | GO-P0-02 | 🟡 Go 已完成 CORS 白名单和认证失败限速；登录限速及 query token 清理待迁移 |
| GO-P0-05 | 配置/会话/密钥持久化安全整改 | M | GO-P0-03 | 🟡 Go 已完成配置、Session 摘要和审计 JSONL 持久化；密钥轮换及加密存储待迁移 |
| GO-P0-06 | 固化 OpenAPI v1、DTO 和错误码 | M | 无 | Node API 生成 fixture，CI 能检测破坏性变更 |
| GO-P0-07 | API、WS、权限和配置恢复测试 | M | GO-P0-01~06 | Node 基线测试全部自动化 |
| GO-P0-08 | 建立 Node 基线性能报告 | M | 无 | 保存 CPU、内存、吞吐、延迟、重连基线 |

### P1：Go 基础设施和采集核心

| ID | 任务 | 工作量 | 依赖 | 完成标准 |
|---|---|---:|---|---|
| GO-P1-01 | 创建 Go module、目录和构建流水线 | S | GO-P0-06 | Windows/Linux 可重复构建 |
| GO-P1-02 | Go 配置模型、schema migration、原子写入 | M | GO-P0-05 | 可读取现有配置并回写无数据丢失 |
| GO-P1-03 | Go Auth/RBAC/审计服务 | M | GO-P0-02 | 🟡 Go 已完成 Token/Session 角色矩阵、bcrypt 和持久会话；多用户及完整资源矩阵待补 |
| GO-P1-04 | REST DTO、OpenAPI 和健康检查 | M | GO-P0-06 | 🟡 Go 已满足首屏/实时监控及设备 CRUD DTO；全量业务 REST 和 OpenAPI 仍待迁移 |
| GO-P1-05 | WebSocket 认证、订阅和事件广播 | M | GO-P0-01 | 🟡 Go 已完成兼容消息链路和协议测试；前端切流及告警/存储事件待迁移 |
| GO-P1-06 | Driver 接口、registry、生命周期管理 | M | GO-P1-01 | 可注入 fake driver 并正确停止 |
| GO-P1-07 | 调度、批量 flush、标度和质量码 | L | GO-P1-06 | 样本顺序、时间戳和工程值与 Node 一致 |
| GO-P1-08 | Modbus TCP Go 驱动 | M | GO-P1-07 | ✅ 读值、动态采样、断线重连、超时、FC05/06/16 写入通过；认证审计待补 |
| GO-P1-09 | IEC104 Go codec/driver | L | GO-P1-07 | STARTDT、总召唤、S 帧、遥信遥测通过 |
| GO-P1-10 | Node/Go 样本对比工具 | M | GO-P1-08~09 | 同一输入产生可解释的差异报告 |

### P1：存储、北向和可靠性

| ID | 任务 | 工作量 | 依赖 | 完成标准 |
|---|---|---:|---|---|
| GO-P1-11 | TDengine writer 和历史查询 | L | GO-P1-07 | ✅ REST SQL writer、数值/布尔写入、真实历史查询、离线回退 JSONL；ProtoForge 多协议 Go 采集 + TDengine 写入/历史查询已完成回归 |
| GO-P1-12 | 磁盘队列和 Outbox 分段存储 | L | GO-P1-11 | 🟡 已支持旧格式兼容、分段 JSON 文件、容量上限、最旧数据淘汰、重启恢复和溢出计数；基础分段/恢复/容量单测通过，分段压缩、磁盘不足演练和长期压测待补 |
| GO-P1-13 | MQTT/Sparkplug B 发布和 CMD | L | GO-P1-05 | ✅ 已完成 Paho 异步连接/重连、NDEATH Will、NBIRTH/DBIRTH/DDATA 编解码、STATE/JSON 与 protobuf CMD、REBIRTH、序列持久化、BIRTH/DDATA Outbox 去重、CMD 审计，并通过 `18840` 真实 broker 双向演练 |
| GO-P1-14 | Device Shadow 迁移 | M | GO-P1-13 | ✅ 已完成 shadow.json 原子持久化、reported/desired/pending、成功写入收敛、3 秒节流和 retain Outbox；ProtoForge Modbus 真实采样、retain 发布和重启恢复通过 |
| GO-P1-15 | 存储、队列、协议 metrics 和诊断 | M | GO-P1-11~14 | 🟡 Go 已提供 `/api/metrics` JSON 和 `/metrics` Prometheus 文本端点，返回采样总量、状态更新、通道状态分布、离线转换/恢复/重连次数、成功采集延迟及存储 queued/written/dropped；按协议和通道拆分的重连细分仍待补齐 |
| GO-P1-16 | 断网/重启/磁盘不足故障演练 | M | GO-P1-12 | 🟡 已补充 TDengine HTTP 503 故障注入、队列保留和恢复冲刷测试；Outbox 重启/分段/容量测试已有覆盖，真实断网、进程重启和磁盘不足演练及结果归档仍待完成 |

### P2：协议和业务迁移

| ID | 任务 | 工作量 | 依赖 | 完成标准 |
|---|---|---:|---|---|
| GO-P2-01 | S7 迁移和真实 PLC 回归 | L | GO-P1-10 | 🟡 Go `s7-go` 已锁定 `github.com/robinson/gos7` commit `2d6806f80c8b`，覆盖 DB/M/I/Q/T/C 基础读写，多点读取支持 Read Var 和逐点回退，单测与 ProtoForge DB1.DBD0/DB1.DBB4/M0.0/Q0.0 多点真实读取通过；S7-1200/1500、优化块、安全保护、PDU 边界和长期重连回归待完成，继续保留 Node 驱动 |
| GO-P2-02 | SNMP、MELSEC、FINS、ENIP 迁移 | XL | GO-P1-06 | 🟡 Go 驱动已完成并支持 `GATEWAY_GO_DRIVER_MODE=go` 自动路由；ProtoForge 真实联调已确认 SNMP/MELSEC/FINS/ENIP 在线采集；SNMPv3、真实设备和长期运行仍待专项验证 |
| GO-P2-03 | OPC UA 安全连接、订阅和证书 | XL | GO-P1-06 | 🟡 已引入 MIT `github.com/gopcua/opcua v0.9.1`，完成 None/用户名认证、节点读写、轮询采集和 ProtoForge `4840` 真实读写；Sign/SignAndEncrypt、证书、订阅式采集仍待专项验证 |
| GO-P2-04 | BACnet/IP 迁移 | L | GO-P1-06 | 🟡 Go `bacnet-go` 已实现 AI/AO/AV/BI/BO/BV PresentValue 批量读写、Who-Is/I-Am 发现、SubscribeCOV 确认/通知、CancelCOV、续租、超时重连并接入自动路由；Node/Go 已通过 ProtoForge 真实读写、发现和 COV 回归；现场设备、长期 COV 和完整故障矩阵仍待专项 |
| GO-P2-05 | 告警引擎和通知服务迁移 | L | GO-P1-07 | 🟡 Go 已支持基础状态机、回差、ROC、确认、Active/Cleared TDengine 落库、风暴抑制、独立告警 Outbox 及 Webhook/钉钉/企微/SMTP 适配；HTTP 三渠道本地 mock 契约测试通过，真实端点、可靠重试队列待补 |
| GO-P2-06 | 配方、批量下发和影子收敛迁移 | M | GO-P1-14 | 🟡 Go 已完成配方 CRUD/版本/逐项下发/记录/复制/导入导出及 Shadow 收敛；脚本与全量业务回归仍待补齐 |
| GO-P2-07 | 脚本执行隔离服务 | L | GO-P1-03 | 🟡 Go 已完成独立 worker 子进程、Goja 白名单 API、手动/周期/tagChange 执行、1 秒超时、输出/统计和连续失败自动禁用；生产级 CPU/内存配额和更强沙箱策略待补 |
| GO-P2-08 | 全量 API/E2E 双后端回归 | L | GO-P2-01~07 | 🟡 Go 控制台核心冒烟与设备灰度回归通过；Go/Node 配置结构 10 通道/37 位号一致；Go 已完成 8/10 ProtoForge 协议样本写入与历史查询，仍待 MQTT 模拟器恢复、IEC104 实现以及全量读写、质量码、异常、重连、幂等和性能对比 |

### P2：切换和交付

| ID | 任务 | 工作量 | 依赖 | 完成标准 |
|---|---|---:|---|---|
| GO-P2-09 | 设备级灰度切换开关 | M | GO-P1-10 | 🟡 registry、通道驱动 GET/PUT、原子持久化、Engine Reload、控制台 UI 和管理员浏览器回归已完成；双后端全量回归和生产灰度观察仍待补齐 |
| GO-P2-10 | 7 天连续运行和压力测试 | L | GO-P2-08 | 无内存增长、无未解释丢点或重连风暴 |
| GO-P2-11 | Go 单二进制打包和升级回滚 | M | GO-P1-01 | Windows/Linux 安装、升级、回滚可执行 |
| GO-P2-12 | 生产部署、备份、恢复和运维手册 | M | GO-P2-10~11 | 新环境按文档完成部署和恢复 |
| GO-P2-13 | Node 网关兼容期和下线评审 | S | GO-P2-10 | 连续两个版本无 Node 依赖后批准下线 |

## 11. 里程碑与资源估算

以下是单个熟悉 TypeScript、Go 和工业协议的工程师的粗略估算，实际取决于真实设备验证条件：

| 里程碑 | 范围 | 估算 |
|---|---|---:|
| M0 | P0 安全、契约、基线 | 1-2 周 |
| M1 | Go 骨架、认证、兼容 API、fake driver | 2-3 周 |
| M2 | 调度核心、Modbus、IEC104、WS | 3-5 周 |
| M3 | TDengine、Outbox、Sparkplug、Shadow | 3-5 周 |
| M4 | S7、OPC UA 和剩余协议 | 5-8 周 |
| M5 | 双运行、压力、现场试点、切换 | 3-6 周 |

如果由两人协作，可缩短日历时间，但协议现场验证和故障演练通常无法线性并行。

## 12. 决策门

每个阶段设置停止条件，避免重构变成无期限项目：

- M0 未完成 P0 安全项，不进入协议迁移。
- M1 若控制台兼容成本超过预估，应冻结 API，不继续扩展业务。
- M2 若 Go 在 Modbus/IEC104 上不能达到 Node 的行为一致性，保留 Node 驱动并重新评估。
- M3 若 Outbox、TDengine 恢复和故障演练不达标，不进入现场试点。
- M5 只有在连续运行、性能、数据完整性和回滚均通过后，才切换 Go 为默认网关。

## 13. 最终建议

推荐采用 Go，但把重构目标定义为“更可靠的生产网关”，而不是“把 TypeScript 翻译成 Go”。

第一阶段最值得投入的顺序是：

1. 先修复现有安全漏洞并固化 API/事件契约。
2. 用 Go 建立兼容网关骨架和采集核心。
3. 优先迁移 Modbus、IEC104、MQTT/Sparkplug 和存储可靠性。
4. 以真实设备验证为准迁移 S7、OPC UA、BACnet 等复杂协议。
5. 双运行、故障注入、连续运行达标后再下线 Node。

该路线可以保留现有控制台和业务资产，降低一次性重写风险，同时把 Go 的价值集中在最需要它的采集、并发、可靠性和部署环节。
## 2026-09-22 故障矩阵推进记录

- 新增 `scripts/fault-matrix.mjs`，统一通过 API 观察通道状态、停止对应模拟器监听进程、等待 offline、重启模拟器并验证 online 与实时采样恢复；输出 `docs/artifacts/fault-matrix-latest.json`。
- Go 实测通过 MELSEC、FINS、MQTT/Sparkplug B 三项断网/恢复演练，证据归档于 `docs/artifacts/fault-matrix-passed-3.json`。
- EtherNet/IP 模拟器端口已参数化为 `ENIP_SIM_PORT`，并修正标准 `0xB2 + 直接 CIP`、`0x4C Read Tag` 与响应类型/长度字段；Go 驱动补充错误 session 清理。真实重启恢复已通过，证据见 `docs/artifacts/fault-matrix-enip.json`。
- 后续顺序：补 SNMP/S7/OPC UA/BACnet/IEC104 故障矩阵 -> TDengine 磁盘不足和长期堆积 -> 全量 E2E/性能 -> 灰度切换评审。
- SNMP 故障矩阵已通过：Go 实际状态 `online -> offline -> online`，样本数量保持，证据为 `docs/artifacts/fault-matrix-snmp.json`。BACnet 当前 `47808` 由 ProtoForge 主服务占用，需使用 ProtoForge 生命周期重启或专用 BACnet 端口夹具验证，不能直接抢占端口。
