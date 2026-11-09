# Factory Bridge

[![CI](https://github.com/troubleduxj/IotConnector/actions/workflows/ci.yml/badge.svg)](https://github.com/troubleduxj/IotConnector/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

Factory Bridge 是一套工业物联网（IIoT）边缘网关：一个 Go 编写的单文件网关，负责采集 PLC、仪表和楼宇设备的数据，写入时序库、上报北向 MQTT；配套一个 Web 控制台，用来配置通道和位号、查看实时值与历史曲线、管理告警、配方和边缘脚本。

> **许可**：本项目仅允许个人、学习、研究等**非商业用途**，禁止商用。详见 [许可协议](#许可协议)。

---

## 功能

- **10 种南向协议**：Siemens S7、Modbus TCP、Mitsubishi MELSEC、Omron FINS、EtherNet/IP（Rockwell）、OPC UA、MQTT、SNMP、BACnet/IP、IEC 60870-5-104。全部为 Go 原生驱动。
- **采集调度**：按通道周期轮询，相位错开启动，可一键重均衡；每通道统计收发帧数、错误、超时和平均周期延迟。
- **位号质量**：单个位号读失败只标记该位号为 Bad，不让整个通道离线。
- **配置热更新**：修改通道或位号只重启受影响的通道，其余通道继续采集；北向 MQTT 设置改后立即生效。
- **时序存储**：写入 TDengine 超级表，网关断线期间点位进入本地队列，恢复后补写；首次连接自动建库建表。
- **历史查询**：多位号同屏对比、原始值与归一化两种刻度、统计包络（最小、最大、均值、标准差），可导出 PNG、SVG、CSV。
- **告警**：高限、低限、偏差、变化率四类规则；确认机制；Webhook、钉钉、企业微信、邮件四种通知渠道。
- **北向 MQTT / Sparkplug B**：NBIRTH、DBIRTH、DDATA、NDEATH，离线排队后补发；设备影子同时发布 reported 与 desired 值。
- **配方**：多套工艺参数，版本号自动递增，一键下发到控制器，下发记录可追溯。
- **边缘脚本**：JavaScript（goja），在隔离子进程中运行；限时 1 秒、内存上限 64 MB，脚本失败时本次写值全部丢弃，连续失败 3 次自动停用。
- **存储任务**：周期、死区、边沿、条件表达式四种触发方式。
- **安全**：四级角色（viewer、operator、engineer、admin）、全部路由按角色授权、一次性 WebSocket 票据、登录失败锁定、审计日志；非回环地址强制 HTTPS，可设访问白名单；口令只写不读，配置备份默认不含口令。
- **配置版本**：采集配置每次保存在 `gateway.db` 中留一个版本，可列出、导出和回退。

---

## 架构

```
现场设备（PLC / 仪表 / 变频器 / 楼宇 / 电力）
   │  S7 · Modbus TCP · MELSEC · FINS · EtherNet/IP · OPC UA · MQTT · SNMP · BACnet/IP · IEC 104
   ▼
┌──────────────────────────── factorybridge（Go 单文件网关）────────────────────────────┐
│  采集引擎（按通道调度、位号质量）                                                       │
│     │                                                                                   │
│     ├─▶ 实时推送（WebSocket，100 ms 合并）──────────────▶ Web 控制台（同端口托管）        │
│     ├─▶ 时序存储（TDengine，断线排队补写）                                               │
│     ├─▶ 告警 → 通知（Webhook / 钉钉 / 企微 / 邮件）                                       │
│     ├─▶ 存储任务、边缘脚本（隔离子进程）、配方下发                                        │
│     └─▶ 北向 MQTT / Sparkplug B（离线排队）与设备影子                                     │
│                                                                                         │
│  状态库 gateway.db（SQLite）：用户、会话、配置版本、历史、告警、审计、队列                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### 目录结构

| 目录 | 内容 |
|---|---|
| `apps/gateway-go` | Go 网关：`cmd/factorybridge`（命令行入口）与 `internal/`（采集、API、存储、北向、认证等） |
| `apps/console` | Web 控制台：React 19、TypeScript、Vite、Tailwind CSS |
| `tools/sim` | Modbus TCP 与 IEC 104 模拟器（开发与测试用） |
| `e2e` | 端到端测试（Playwright）与自带测试环境 |
| `deploy` | 部署手册、Docker 镜像、systemd 参考单元、运行参数配置示例 |
| `docs` | 安全验收清单、评审任务记录、需求与设计文档 |
| `scripts` | 本地门禁、发布打包、压测、故障矩阵等脚本 |

---

## 快速开始

### 环境要求

- Go 1.26 或更高
- Node.js 22 与 pnpm 10
- （可选）Docker：运行 TDengine、模拟器、e2e 测试

### 本地开发

```bash
pnpm install
pnpm dev:gateway        # Go 网关，开发模式，http://127.0.0.1:18080（只监听回环地址）
pnpm dev                # 控制台开发服务器，http://localhost:3000
```

开发模式会自动创建开发账号，口令打印在网关日志里；也可以设 `FB_DEV_PASSWORD` 指定。浏览器打开 `http://localhost:3000` 登录。

### 启动模拟器（可选）

```bash
pnpm --filter @iotconnector/sim modbus-sim    # Modbus TCP，默认 127.0.0.1:15020
pnpm --filter @iotconnector/sim iec104-sim    # IEC 104，默认 :2404
```

其余协议可用 [ProtoForge](https://hub.docker.com/r/suoten/protoforge) 模拟，用法见 [deploy/README.md](deploy/README.md) 的"模拟器"一节。

### 启用时序存储（可选）

```bash
docker run -d --name tdengine -p 16041:6041 tdengine/tdengine:3.3.6.13
FB_TDENGINE_URL=http://127.0.0.1:16041 FB_TDENGINE_PASSWORD=<口令> pnpm dev:gateway
```

设置了 `FB_TDENGINE_URL` 时必须同时提供口令，网关不使用内置默认口令。首次连接会自动建库建表。

---

## 部署

发布包是单个可执行文件加控制台静态文件，网关在同一端口托管控制台。

```bash
pnpm release                     # 产出 dist/release/<版本>/ 下的 Windows 与 Linux 包
factorybridge user create --name admin --role admin --data-dir <数据目录>    # 系统没有默认账号
factorybridge service install --data-dir <数据目录> -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
factorybridge service start
```

- Windows 注册为系统服务，以虚拟账号运行，数据目录只对 SYSTEM、Administrators 和服务账号开放。
- Linux 注册为 systemd 服务，以专用系统账号运行，并启用 systemd 的沙箱选项。
- 监听非回环地址时强制 HTTPS，未提供证书则自动生成自签名证书。

完整步骤、升级、备份恢复、回滚和排错见 **[deploy/README.md](deploy/README.md)**；上线前请对照 **[docs/SECURITY_ACCEPTANCE.md](docs/SECURITY_ACCEPTANCE.md)** 逐项验收。

### Docker Compose 演示栈

`docker-compose.yml` 一次起网关、TDengine、ProtoForge 和 IEC 104 模拟器，仅用于演示和联调，端口只绑定在 127.0.0.1。用法见文件开头的注释。

---

## 命令行

```
factorybridge run       前台运行网关
factorybridge service   安装、卸载、启停系统服务（Windows 服务或 systemd）
factorybridge user      管理用户（create / list / passwd / role / unlock / disable / enable / delete）
factorybridge config    查看与导出配置版本（list / export）
factorybridge migrate   把旧 JSON 状态文件导入 gateway.db
factorybridge version   显示版本、提交号与构建时间
```

每个命令加 `-h` 查看参数。退出码：0 成功，1 运行错误，2 参数错误，3 配置错误。

## 配置

运行参数的优先级：命令行参数 > 环境变量 > 配置文件 > 默认值。

- **环境变量**：统一用 `FB_` 前缀，例如 `FB_PORT`、`FB_DATA_DIR`、`FB_TDENGINE_URL`。完整列表见 [.env.example](.env.example)。旧名 `GATEWAY_GO_*`、`TDENGINE_*` 本版本仍可用，启动时会提示弃用。
- **配置文件**：`factorybridge run --config <文件>`，YAML 格式，示例见 [deploy/factorybridge.example.yaml](deploy/factorybridge.example.yaml)。口令、令牌和开发模式只能用环境变量设置。
- **采集配置**（通道、位号、告警、脚本等）通过控制台或 API 修改，保存在数据目录的 `gateway.db` 中，`config.json` 是同步写出的镜像。

## API

- 所有接口可通过 `/api/v1/...` 访问，与 `/api/...` 等价。
- 错误统一返回 `{"ok": false, "error": "<说明>", "code": "<代码>"}`。
- 接口清单可在控制台"系统配置"里下载 OpenAPI 文档，或请求 `GET /api/system/openapi.json`。

---

## 开发与测试

```bash
node scripts/ci-local.mjs --quick    # 本地门禁：类型检查、单元测试、go vet、go test、go build
pnpm test                            # 控制台单元测试（Vitest）
cd apps/gateway-go && go test ./...  # 网关单元测试
pnpm e2e:docker                      # 端到端测试，见下
```

### 端到端测试

```bash
pnpm e2e:docker                 # 构建 linux 发布包 → 容器里起网关与 IEC 104 模拟器 → Playwright 跑测试 → 拆除
pnpm e2e:docker --skip-build    # 复用 dist/release 里最新的 linux/amd64 包
pnpm e2e:docker --keep          # 测试后保留测试栈便于排查（docker compose -p fbe2e down -v 清理）
```

只需要 Docker，不依赖本机已运行的网关、控制台或浏览器。测试账号和口令每次随机生成，测试配置在 `e2e/fixtures/config.json`。失败时的 HTML 报告、截图和 trace 在 `.tmp/e2e-report/`。

针对本机已运行的网关（使用系统 Edge）：`E2E_BASE_URL=http://127.0.0.1:18080 E2E_USER=<用户> E2E_PASSWORD=<口令> pnpm e2e`。

### 持续集成

[GitHub Actions](https://github.com/troubleduxj/IotConnector/actions) 在每次推送到 `main` 和每个 Pull Request 上运行两个任务：

- `build`：类型检查、控制台测试与构建、`go vet`、`go test -race`、构建网关。
- `e2e`：运行 `pnpm e2e:docker`，失败时上传测试报告。

---

## 技术栈

| 部分 | 选型 |
|---|---|
| 网关 | Go 1.26；SQLite（modernc.org/sqlite，纯 Go）；goja（脚本）；gos7、gopcua、gosnmp、paho.mqtt 等协议库 |
| 控制台 | React 19、TypeScript、Vite、Tailwind CSS 4、Recharts、Zustand |
| 时序库 | TDengine 3.3（超级表 + 子表） |
| 测试 | Go testing、Vitest、Playwright |

---

## 许可协议

本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)**。

- ✅ 允许：个人使用、学习、研究、试验，以及慈善机构、教育机构、公共研究机构、政府机构等非营利组织使用；可以修改和分发，分发时须附带许可协议与 [NOTICE](NOTICE) 中的版权声明。
- ❌ 禁止：任何商业用途，包括在企业生产环境中部署、作为产品或服务的一部分对外提供、用于营利目的的项目。

如需商业授权，请在 [Issues](https://github.com/troubleduxj/IotConnector/issues) 中联系版权人。

> 本协议禁止商用，因此不属于 OSI 认可的"开源许可证"，更准确的说法是"源码公开"。以上中文说明仅供理解，具体权利义务以英文原文 [LICENSE](LICENSE) 为准。

Copyright © 2026 troubleduxj. 第三方依赖遵循各自的许可协议。
