# Factory Bridge - Enterprise IIoT Edge Gateway Console

**Factory Bridge** 是一款面向工业物联网 (IIoT) 场景设计的企业级边缘计算网关配置与监控控制台。它将复杂的工业设备接入、现场总线协议解析、毫秒级时间片调度、数据清洗、本地时序持久化以及云端上报等底层硬核逻辑，通过极具现代感和专业度的高质感 Web UI 进行可视化呈现与全生命周期管理。

本项目不仅支持传统的工业数据监控，更深度融合了 **TDengine 超级表时序引擎**、**多协议批量聚合调度 (Read Plan)**、**跨量纲归一化趋势分析**、**Redis 实时流总线** 以及 **设备影子 (Device Shadow)** 等现代工业 4.0 与分布式边缘网关的最佳工程实践。

---

## 🏗️ 核心技术架构 (Edge-to-Cloud Pipeline)

```
[工业现场设备 PLC / Sensors / Drives / Inverters / HVAC]
   │
   ├── Siemens S7 / Profinet (RFC1006)
   ├── EtherNet/IP & CIP (ControlLogix / Micro800)
   ├── Mitsubishi MELSEC (SLMP / MC 3E/1E)
   ├── Omron FINS (CJ2 / CS1 / NJ / NX)
   ├── OPC UA (IEC 62541 / SecureChannel)
   ├── Modbus TCP (IEC 61158 / RTU over TCP)
   ├── MQTT / Sparkplug B (Group/Node/Device)
   ├── BACnet/IP (ASHRAE 135)
   └── IEC 60870-5-104 (电力远动)
   │
   ▼
[1. 南向多协议采集与握手测试 (Southbound Driver Layer)]
   │
   ▼
[2. 毫秒级时间片调度与报文合并 (Acquisition Scheduler & Read Plan)]
   ├── 时间片打散削峰 (Time-Slice Balancing)
   └── 协议级 PDU / 批量字寄存器打包吞吐调优 (Modbus/S7/CIP/MC)
   │
   ▼
[3. 边缘数据清洗与标度变换 (Edge Data Transform: Scale / Offset / Deadband)]
   │
   ▼
[4. 实时分发 (WS 推送至控制台 + 北向 Sparkplug B 管道)]
   │
   ├──▶ [5. 本地高性能时序持久化 (TDengine STable Schemaless Ingestion)]
   ├──▶ [6. 边缘脚本联动与配方控制 (Python Scripts & Recipe Engine)]
   └──▶ [7. 北向断网续传与状态镜像 (MQTT Reliable Outbox & Device Shadow)]
```

---

## ✨ 核心功能模块与近期更新特性 (Features & Recent Updates)

### 1. 🔌 多协议工业通讯矩阵 (Industrial Protocols Ecosystem)
支持覆盖离散制造、过程控制、楼宇自控及电力电网的主流协议：
* **Siemens Profinet / S7 (ISO-on-TCP 102)**：支持 S7-1500 / 1200 / 300 / 400 / 200 SMART，可配 Rack、Slot、连接模式 (OP/PG/Basic) 与 PDU 协商 (240/480/960 Bytes)。
* **EtherNet/IP & CIP (ODVA CIP 44818)**：支持 Rockwell / Allen-Bradley ControlLogix、CompactLogix、Micro800，支持 CIP 路由路径 (如 `1,0`)、CPU 插槽与 Class 3 / UCMM 报文。
* **Mitsubishi MELSEC (SLMP / MC 3E/1E 5000)**：支持 iQ-R、iQ-F (FX5U)、Q、L 系列，支持二进制/ASCII 帧格式、网络号/站号寻址。
* **Omron FINS (9600)**：支持 CJ2 / CS1 / NJ / NX 系列，支持源/目的网络号、节点号与单元号路由。
* **OPC UA (IEC 62541 4840)**：支持 Endpoint URL、安全策略 (None / Sign / SignAndEncrypt)、加密算法 (Basic256Sha256 / Aes128) 及 X.509/匿名认证。
* **Modbus TCP (502)**：支持 Slave/Unit ID、32/64 位字节顺序切换 (CDAB/ABCD/DCBA/BADC)、0/1 基址偏移与最大连续寄存器批量调节。
* **MQTT / Sparkplug B (1883/8883)**：支持工业 Sparkplug B v2.2 规范 (Group ID / Edge Node ID / Device ID)、QoS 0/1/2、TLS/SSL 及断网离线缓存。
* **BACnet/IP (47808)**：支持楼宇与暖通自控 (HVAC/冷机)，配置 Device Instance ID、Max APDU 长度与 BBMD 注册。
* **IEC 60870-5-104 (2404)**：支持电力电网远动通讯，配置 Common ASDU 地址、COT/IOA 字节长度与 T1/T2/T3 超时定时器。
* **BACnet/IP (47808)**：楼宇自控 HVAC/冷机/照明/电力表，位号地址 = 对象类型:实例（AI:1/AV:3/BI:1/BV:2），
  读 PresentValue（readPropertyMultiple 批量轮询），AV/AO/BV 支持下发；驱动以 raw dgram 实现
  （bacstack beta 的发送端口=绑定端口，同机模拟器必然冲突）；内置模拟器
  `pnpm --filter @iotconnector/gateway bacnet-sim`（复用 bacstack 编解码，含可写 AV/BV）。
* **IEC 60870-5-104 (2404)**：电力远动/配电自动化，零依赖手写协议栈（iec104-codec：APCI I/S/U 帧 +
  ASDU M_SP_NA/M_ME_NC/C_IC_NA 编解码）；驱动 TCP → STARTDT 激活 → 周期总召唤（cot=6）→ 按 IOA 匹配
  位号（Bool→单点遥信、数值→浮点遥测）→ publish，S 帧确认；位号地址 = IOA:n；内置站端模拟器
  `pnpm --filter @iotconnector/gateway iec104-sim`（遥测 IOA 1-4 动态 + 遥信 IOA 1001-1004 周期翻转）。
* **SNMP v1/v2c (161)**：UPS / PDU / 环境传感器 / 网络设备 / 能耗表轮询，位号地址为点分 OID，
  OctetString 自动转数值/字符串；内置 net-snmp Agent 模拟器（`pnpm --filter @iotconnector/gateway snmp-sim`）。
* **MQTT 南向采集 (1883)**：订阅型驱动——位号地址 = 订阅主题，支持「主题#字段路径」语法
  （如 `factory/line1/status#temp` 取 JSON 字段、`factory/line1/counter#` 取原始标量），
  多位号可共用主题各取字段；配套 aedes 完整 broker（`mqtt-dev-broker`）与发布模拟器（`mqtt-sim`）。
* **协议辅助工具**：内置各协议标准地址语法说明表 (Address Syntax Reference)、实时通讯链路握手测试
  （六协议分步握手 + S7 全位号批量探针 + OPC UA 订阅采样 + MQTT CONNACK/SUBACK/采样 + SNMP GET）
  与十六进制协议诊断抓包分析器。

---

### 2. 📈 历史时序查询与多位号比对分析 (Historian Query & Multi-Tag Analytics) —— *[全新升级]*
针对工业现场海量历史数据检索与跨设备工艺比对需求，进行了深度重构与优化：
* **多维度位号检索与筛选**：
  * 支持按位号名称、所属通道、数据类型进行实时模糊检索与一键重置。
  * 提供设备/通道快速过滤芯片 (Filter Chips)。
  * 内置「Top 6 核心工艺参数」、「反应釜 R0021 全量点位」、「传动与电机群」一键对比预设。
* **多位号同屏同步比对 (Multi-Tag Comparison)**：
  * 支持最多 8 个不同设备/点位同时绘制，每个位号分配独立的高辨识度工业标准色标。
  * 支持单个曲线独立的显示/隐藏 (Show/Hide) 切换。
* **双模式 Y 轴尺度切换 (Scaling Modes)**：
  * **归一化模式 (Normalized 0-100%)**：彻底解决不同量纲/量程物理量（如 pH 值 7.2 与 转速 1200 RPM、温度 35℃、电流 24A）因数值悬殊无法直观同屏对比的痛点，将各物理量动态映射至 0~100% 相对区间进行工艺相关性与扰动分析。
  * **原始物理量模式 (Raw Engineering Values)**：保留原始物理工程单位，自适应刻度显示。
* **灵活的时间窗口与重采样策略 (Time Window & Resampling)**：
  * 快速预设：`15m`、`1h`、`6h`、`24h`、`7d`、`30d`。
  * 自定义起止时间选择器：精确到分秒的时间跨度选择。
  * 采样粒度：支持 `1s (原始采样)`、`5s 均值`、`1m 插值`、`5m 包络` 降噪与平滑。
  * 实时动态轮询 (Live Polling)：支持一键开启/暂停秒级定时数据刷新与流式追加。
* **曲线图片与工业报表导出 (Export Capabilities)**：
  * **导出高清图表 PNG (Export Chart PNG)**：通过 HTML5 Canvas 高清渲染，自动合成系统标题、时间跨度元数据、对比图表及底部各点位极值统计摘要，便于直接插入质量分析与交接班报告。
  * **导出矢量图 SVG (Export Vector SVG)**：支持矢量格式下载，适用于 SCADA 组态与工程文档。
  * **导出 Excel / CSV 表格**：一键导出包含时间戳、Epoch 毫秒数及各点位带单位数据的标准 CSV 结构化文件。
* **点位统计包络表 (Statistical Metrics Table)**：
  * 实时计算并展示所选时间窗口内的：**最新值、最小值 (Min)、最大值 (Max)、平均值 ($\mu$)、标准差 ($\sigma$)、峰峰值波动范围 ($\Delta$)、通讯质量等级 (Quality)**。

---

### 3. ⏱️ 采集调度引擎 (Acquisition Scheduler)
* **时间片负载均衡 (Time Slice Load Balancing)**：将高频采集任务打散分配到不同毫秒级时间片中，动态重均衡 (Dynamic Rebalancing) 削峰填谷，彻底避免 CPU 和网络 I/O 尖刺。
* **协议读计划聚合 (Read Plan Tuning)**：智能分析连续的寄存器地址，自动合并为单次批量读取报文（支持 Modbus、Siemens S7 PDU 240/480/960 Bytes、Rockwell CIP Multiple Service Packet、Mitsubishi MC 3E Bulk Words 吞吐量优化）。
* **线程池解耦**：采集 I/O 与数据后处理线程池独立调配。

---

### 4. 🗄️ 数据持久化规则引擎 (Data Storage Rules)
* **TDengine 时序整合**：采用“超级表 (STable) + 子表”架构，告别传统关系型数据库臃肿的列映射。
* **Schemaless Ingestion (无模式写入)**：网关自动注入 `Timestamp`、`Value`，并自动打上 `Channel`、`TagName`、`BatchID` 等标签，实现千万级时序数据高效写入。
* **灵活触发模式**：支持连续周期存储、变化量/死区存储、上升沿触发或自定义表达式逻辑。

---

### 5. ⚙️ 系统与网络配置 (System Configuration)
* **MQTT 断网续传 (Reliable Outbox)**：开启后，在离线状态下本地缓冲遥测数据，并在网络恢复后可靠顺序推送到云端。
* **设备影子 (Device Shadow)**：边缘端为每位号维护 reported（采集上报）+ desired（写管道期望值）双快照，
  不一致标记「待收敛」；REST `GET /api/shadow` 查询，同时以 retain QoS1 发布至
  `<组ID>/shadow/<节点ID>`（订阅即得最新状态，断线入 Outbox 补传）。
* **真实端点管理**：Web API 状态（端口/OpenAPI 清单）、TDengine 连通实测与建库、
  诊断导出、恢复出厂（二次确认）均为真实后端操作。

---

### 6. 🔍 在线参数诊断 (Parameter Diagnose)
* 类似工控机/上位机的在线监视功能，支持实时读取/写入 PLC 内部寄存器与变量，用于现场工程师调试与信号点检。

---

### 7. 📜 配方管理系统 (Recipe Management)
* 支持建立与维护多套工艺配方（包含工艺目标值、转速、温度、浓度等参数），支持一键批量下载下发到 PLC，适用于柔性生产与多品种换线。
* **版本管理**：参数集变更自动递增版本号（v1→v2…），仅改名称/说明不动版本；下发记录持久化（操作人/时间/成功数，最近 200 条）。
* **导入导出/复制**：JSON 导出（位号 id+名双写，跨网关可导入）、导入（重名 409、位号按 id/名匹配、失败中文明细）、一键复制副本。

---

### 8. 📜 边缘脚本扩展引擎 (JS 沙箱，决策 D5)
* 内置 JavaScript 规则脚本编辑器（`node:vm` 沙箱 + 1s 超时 + 白名单 API：`Read/Write/log`），
  触发方式支持周期 / 位号变化 / 手动；写操作脚本结束后批量下发。
* **运行监控与崩溃自愈**：执行次数/耗时/错误统计实时展示；连续 3 次失败自动停用脚本
  （落配置 + system 审计），修复后一键重新启用。

---

### 9. 🆕 近期迭代摘要 (2026-09)

* **存储任务**：周期 / 死区 / 边沿 / **条件表达式**（位号按名引用、白名单校验、上升沿写行）四种触发；
  运行状态监控（写入数/近 1 分钟速率/最近写入/错误计数）。
* **采集调度**：每通道帧级 TX/RX/错误/超时率/最近通讯/平均周期延迟；相位错开启动 + 一键重均衡。
* **连接测试**：六协议真实分步握手；S7 全位号单 PDU 批量探针、OPC UA MonitoredItem 订阅采样探针。
* **通道管理**：JSON 导入导出（协议参数 schema 校验 + 地址语法预校验）、点位表实时值列（值变化 400ms 高亮）、地址逐键在线校验。
* **告警**：high/low/deviation/ROC 四类规则、确认机制、四渠道通知（Webhook/钉钉加签/企微/邮件）+ **消息模板变量**。
* **认证安全**：会话持久化、首登强制改密、全局限速、登录失败 5 次锁定 10 分钟、审计全程落盘。
* **工程化**：中英双语 i18n（662 键零缺失）、统一 Toast/应用内确认与输入对话框、Vitest 47 例、CI。

---

## 🛠️ 技术栈 (Technology Stack)

* **前端框架**: React 19, TypeScript, Vite（hash 路由 + 视图级懒加载分包）
* **可视化图表与动画**: Recharts, Canvas API, Lucide React
* **样式系统**: Tailwind CSS (现代工业级高对比度/暗色工程主题规范)
* **工业协议概念与后端模型**:
  * 协议栈：Siemens S7 (RFC1006), Rockwell CIP, Mitsubishi MC 3E/1E, Omron FINS, OPC UA, Modbus TCP, MQTT/Sparkplug B, BACnet/IP, IEC 104
  * 时序存储引擎：TDengine (STable + 子表)
  * 消息中间件：MQTT / Sparkplug B (Reliable Outbox, QoS 1)
  * 脚本沙箱：node:vm（决策 D5）；测试：Vitest（47 例）

---

## 🚀 快速启动 (Getting Started)

> 项目为 pnpm monorepo：`apps/console`（Web 控制台）+ `apps/gateway-go`（Go 网关）+ `tools/sim`（Modbus、IEC104 模拟器）。Node 网关与 `packages/shared` 已于 2026-11-09 删除（D0-5），最后版本见 tag `node-final`。

1. **安装依赖**：
   ```bash
   pnpm install
   ```

2. **一键启动（网关 8080 + 控制台 3000）**：
   ```bash
   pnpm dev
   ```

3. **（可选）启动协议模拟器**：S7 / Modbus / OPC UA / MELSEC / FINS / EtherNet-IP 六协议模拟器，
   让各通道经真实 TCP 采集到数据（Modbus、IEC104 模拟器见 `tools/sim`，其余协议用 ProtoForge）：
   ```bash
   pnpm --filter @iotconnector/gateway s7-sim
   pnpm dev:modbus-sim
   pnpm --filter @iotconnector/gateway opcua-sim
   ```

4. **访问控制台**：
   在浏览器中打开 `http://localhost:3000`。Dashboard 顶栏徽章显示网关连接状态；"Live Equipment Status" 中的实时位号（pH/温度/压力/转速/电流）由网关推送驱动。

### 生产部署（服务化常驻）

网关支持以系统服务方式常驻（开机自启、崩溃自动拉起、优雅停机落盘）：
Linux systemd 单元见 `deploy/systemd/`，Windows WinSW 包装见 `deploy/windows/`，
完整步骤与健康检查/故障排查速查表见 **`deploy/README.md`**。
演示/试点亦可使用 `docker-compose.yml` 一键栈（网关 + 控制台 nginx + TDengine + 协议模拟器）。

### 环境变量（网关）

| 变量 | 说明 | 默认 |
|---|---|---|
| `GATEWAY_PORT` | REST+WS 端口 | 8080 |
| `TDENGINE_URL` | taosAdapter REST 地址（如 `http://127.0.0.1:16041`），未设置则存储管道禁用 | — |
| `TDENGINE_DB` / `TDENGINE_STABLE` | 目标库与超级表 | `factory_bridge` / `st_factory_equipment` |

### TDengine 存储与历史查询（Phase 0 已打通）

```bash
# 启动 TDengine（Docker，REST 映射到宿主机 16041 —— 6041 被 VMware vmnat 占用）
docker run -d --name tdengine --restart unless-stopped -p 16030:6030 -p 16041:6041 tdengine/tdengine:3.3.6.13

# 网关开启存储
TDENGINE_URL=http://127.0.0.1:16041 pnpm --filter @iotconnector/gateway dev
```

- 写入管道：SQL 批量 `INSERT INTO db.tb_x USING <STable> TAGS(...) VALUES ...`，
  按位号哈希自动建子表；断线缓存（10 万点上限）恢复后补写。
  注：TDengine 3.3.6 的 taosAdapter 已移除 schemaless REST 端点（迁往 WebSocket），
  故采用等价的 SQL 方式，超级表/子表架构与 PRD FR-M4-03 一致。
- 历史查询 API：`GET /api/history?tagIds=1,5,8&start=<ms>&end=<ms>&interval=<秒可选>`
  —— 服务端窗口聚合（AVG/MIN/MAX/点数，粒度自动降采样至 ~150 点）+ 统计包络
  （Min/Max/均值/标准差/点数），对应 PRD FR-M7-03/05。


### 已知问题：gopcua 版模拟器与外部 OPC UA 栈互操作

`D:\Cursor\Project\ProDB\opcua-simulator`（gopcua v0.8.0 / v0.9.1 服务端）的 opc.tcp 端点在收到
OPN（打开安全通道）帧后会直接断开连接——node-opcua 客户端与裸二进制协议实现均被断链，
仅 gopcua 自家客户端与 HTTP API 可用。PoC 期间已用 node-opcua v0.9.1 重新构建验证，行为一致，
属 gopcua server 包的互操作缺陷。当前使用 `scripts/opcua-sim-node.ts`（node-opcua 服务器，
节点命名与 gopcua 版兼容）联调；修复 gopcua 后仅需把通道 `endpointUrl` 切回即可，驱动零改动。

### 北向 MQTT/Sparkplug B + Reliable Outbox（决策 D7，已实现）

- 发布器：NBIRTH/DBIRTH/DDATA/NDEATH（Will）+ seq 单调 + REBIRTH 响应；
  手写 Sparkplug B protobuf 编码器（无第三方依赖，vitest 覆盖）。
- Reliable Outbox：断线期间 DDATA 入持久队列（outbox.jsonl，上限 1 万条），
  broker 恢复后按序补传；报文内保留原始采样时间戳。
- 状态/配置：`GET|PUT /api/northbound`、`POST /api/northbound/rebirth`；System Config 页有配置卡片。
- 验证 broker：`pnpm --filter @iotconnector/gateway mqtt-broker`（最小 MQTT broker，打印收到的发布）。

### S7 驱动选型说明

PRD 原定 node-snap7（native snap7 绑定），但其在 pnpm 下需要放行构建脚本且 Windows 编译依赖
MSVC 工具链，不利交付。已改用 **nodes7**（同作者的纯 JS S7comm 实现，零原生依赖），
天然满足 Linux/Windows 双平台要求；若后续需要 native 性能，可在驱动接口内替换，
引擎代码无需改动。地址语法转换：`DB301.Real10 → DB301,REAL10`、`DB301.DBX20.0 → DB301,X20.0`。
