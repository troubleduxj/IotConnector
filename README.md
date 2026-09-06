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
[4. 实时流消息总线 (Redis Stream Buffer & Pipeline)]
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
* **协议辅助工具**：内置各协议标准地址语法说明表 (Address Syntax Reference)、实时通讯链路握手测试 (Connection Test) 与十六进制协议诊断抓包分析器。

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
* **Redis 实时流总线 (Stream Pipeline)**：配置高速内存消息管道，作为本地采集与上层逻辑的解耦中枢。
* **MQTT 断网续传 (Reliable Outbox)**：开启后，在离线状态下本地缓冲遥测数据，并在网络恢复后可靠顺序推送到云端。
* **设备影子 (Device Shadow)**：边缘端维持各设备的最新 JSON 状态快照与期望值对比。

---

### 6. 🔍 在线参数诊断 (Parameter Diagnose)
* 类似工控机/上位机的在线监视功能，支持实时读取/写入 PLC 内部寄存器与变量，用于现场工程师调试与信号点检。

---

### 7. 📜 配方管理系统 (Recipe Management)
* 支持建立与维护多套工艺配方（包含工艺目标值、转速、温度、浓度等参数），支持一键批量下载下发到 PLC，适用于柔性生产与多品种换线。

---

### 8. 🐍 边缘脚本扩展引擎 (Python Scripts)
* 内置 Python 规则脚本编辑器，允许编写复杂的跨设备联动与告警逻辑（如温升超限联锁切断加热棒、启停辅助循环泵等），赋予边缘网关轻量级 SCADA 控制能力。

---

## 🛠️ 技术栈 (Technology Stack)

* **前端框架**: React 18, TypeScript, Vite
* **可视化图表与动画**: Recharts, Canvas API, Lucide React
* **样式系统**: Tailwind CSS (现代工业级高对比度/暗色工程主题规范)
* **工业协议概念与后端模型**:
  * 协议栈：Siemens S7 (RFC1006), Rockwell CIP, Mitsubishi MC 3E/1E, Omron FINS, OPC UA, Modbus TCP, MQTT/Sparkplug B, BACnet/IP, IEC 104
  * 时序存储引擎：TDengine (STable) / PostgreSQL
  * 消息中间件：Redis Stream, MQTT (with Outbox & QoS 1/2)

---

## 🚀 快速启动 (Getting Started)

1. **安装依赖**：
   ```bash
   npm install
   ```

2. **启动开发服务器**：
   ```bash
   npm run dev
   ```

3. **访问控制台**：
   在浏览器中打开提示的本地地址 (通常为 `http://localhost:3000`) 即可体验全套企业级工业网关配置与监控平台。
