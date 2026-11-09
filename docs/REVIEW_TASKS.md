# 项目评审任务清单（2026-11-06）

> 状态：**待讨论**。本清单只记录评审发现和建议动作，未做任何代码修改。
> 讨论确定范围后，再逐项决定"修 / 不修 / 推迟"。
> 位置引用以当前工作区代码为准（`apps/gateway-go` 尚未入库）。

优先级：P0 = 现场部署前必须解决；P1 = 试点期内解决；P2 = 择机。
工作量：S ≤ 半天；M 1–2 天；L 3 天以上。

## A. 仓库与流程

| ID | 问题 | 位置 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| A1 | ✅ 已提交（阶段 0，92b746e 等 6 个提交）；本地 bare 备份仓库待你指定路径。Go 网关整个目录未入库，主用代码只存在本机磁盘；`GO_REFACTOR_PLAN.md`、9 个运维脚本及 22 个已修改文件未提交 | `apps/gateway-go/`、`scripts/`、`docs/` | 先做 A3，再分批提交；另建一个本地 bare 仓库（放在另一块盘或 NAS）作为 `origin` 并推送，防止单盘损坏丢代码 | P0 | S |
| A2 | ✅ 已完成（阶段 0）：主分支改名 `main`；本地门禁 `pnpm ci:local`（`scripts/ci-local.mjs`），`.githooks/pre-push` 推送前跑快速模式；`ci.yml` 保留待有远端时启用。注意：用户级 `~/.npmrc` 的 `script-shell=cmd.exe` 会让非交互环境下的 pnpm 脚本不执行却返回 0，门禁脚本已在命令行清空该项 | `scripts/ci-local.mjs`、`.githooks/` | 新克隆后执行 `pnpm hooks:install` 启用钩子 | P0 | S |
| A3 | ✅ 已完成（阶段 0，10ac5c9）。`.gitignore` 未覆盖 `factorybridge.exe`（25 MB）、`.tmp`（31 MB）、`.playwright-cli`（69 MB）、`testdata/**/history.jsonl`（22.9 万行），根目录散落模拟器日志 | `.gitignore` | 补忽略规则，清理根目录日志 | P0 | S |
| A4 | ✅ 已完成（默认 apps/gateway-go/data，首次启动从 Node 目录复制）。Go 默认数据目录是 Node 的 `apps/gateway/data`，两套网关状态文件混放 | `cmd/factorybridge/main.go:272-282` | Go 使用独立数据目录，首次启动从 Node 目录导入配置 | P1 | S |
| A5 | ✅ 已完成（删除 metadata.json，.env.example 改为网关环境变量参考）。`.env.example`、`metadata.json` 是 Gemini/AI Studio 模板残留 | 仓库根 | 改为本项目真实环境变量说明 | P2 | S |
| A6 | ✅ 已完成（ca132c3 及本次提交；TDengine 默认口令仍在，见下）。`admin123` 硬编码在种子配置、e2e 和 5 个脚本中；compose 使用 TDengine 默认 `root:taosdata` | `config.ts:199`、`e2e/`、`scripts/`、`docker-compose.yml` | 脚本改读环境变量；种子账号强制首登改密 | P1 | S |

## B. Go 网关安全（主用运行时）

| ID | 问题 | 位置 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| B1 | ✅ 已修复（阶段 1，eae395d）。WebSocket `write` 只检查"已订阅"，不检查角色，viewer 可写 PLC | `internal/api/websocket.go:168-183` | `wsClient` 记录角色，写入要求 operator；补测试 | P0 | S |
| B2 | ✅ 已修复（阶段 1，eae395d、acb3ca1）。WS `CheckOrigin` 恒为 true；CORS 只拦预检，简单跨域 POST 仍会执行；JSON 不校验 Content-Type | `websocket.go:85`、`server.go:418-423` | Origin 同源 + 白名单；POST/PUT 强制 `application/json` | P0 | S |
| B3 | ✅ 已完成（阶段 2，8ac541c）。未配置 Token/密码时"开放模式"按 admin 放行全部请求 | `server.go:941`、`websocket.go:213` | Q3 已决定：去掉"没配就放行"的隐式开放，改为显式开发模式，规则见 H 组 H5 | P0 | S |
| B4 | ✅ 已修复（阶段 1，a495b8f）。敏感信息可读：`/api/config` 返回完整原始配置，`/api/northbound`、`/api/notifications` 返回 MQTT/SMTP/钉钉密钥；`/api/system/info` 无鉴权且含 TDengine URL | `server.go:514-520,1078`、`northbound.go:16`、`notifications.go:20` | 密码字段只写不读（省略即保留原值）；system/info 去掉内部地址 | P0 | M |
| B5 | ✅ 已修复（阶段 1，acb3ca1）。登录未调用限速；失败计数 map 不清理；无请求体大小限制；`http.Server` 无读写超时 | `server.go:317-354,1014-1024`、`main.go:140-145` | 登录按 IP+用户名限速；`MaxBytesReader`；设置 Read/WriteTimeout | P0 | S |
| B6 | ✅ 已完成（阶段 2，8ac541c）。审计操作者取自客户端 `X-User` 头，可伪造 | `server.go:935,1041` | 从会话取用户名 | P1 | S |
| B7 | ✅ 已完成（阶段 2，8ac541c）。鉴权按路由各自调用，缺统一"默认拒绝"中间件 | `server.go:252` 起 62 条路由 | 统一中间件 + 公开路由白名单；RBAC 矩阵测试 | P1 | M |
| B8 | ✅ 已完成（e3ad71f，环境变量白名单；内存上限推迟）。脚本子进程继承全部环境变量（含密钥），无内存上限；inline 模式写入次数不限 | `scripts.go:213-221,315` | 子进程只传白名单环境变量；设内存上限；inline 模式仅限开发 | P1 | S |
| B9 | ✅ 已完成（370fc70，30 秒一次性票据；?token= 暂留并告警）。WS Token 比较非常量时间；Token 可经 query string 传递 | `websocket.go:218,224` | `subtle.ConstantTimeCompare`；改用首帧认证或短期票据 | P2 | S |

## C. Go 网关正确性与可靠性

| ID | 问题 | 位置 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| C1 | ✅ 已修复（阶段 1，827ad1e）。`esc()` 先把 `'` 转成 `\'` 再把 `\` 换成 `_`，留下裸引号；位号名或告警文本含 `'` 时整批写入失败并在队首无限重试，堵死全部存储 | `internal/storage/tdengine.go:463` | 修正转义（单引号双写）或改参数化写入；补测试 | P0 | S |
| C2 | ✅ 已修复（阶段 1，91bba6e）。`config.Raw` map 被采样/告警协程无锁读、API 加锁写，会触发 Go 致命错误使进程退出；`onSample` 无锁遍历 `config.Tags` | `store.go:70-72`、`scripts.go:125`、`notifications.go:75`、`server.go:151,170,835` | 配置改为不可变快照（atomic.Pointer），修改时写时复制；CI 跑 `-race` | P0 | M |
| C3 | ✅ 已完成（阶段 3，16a5fb1）。每个样本同步写盘：history 每点 fsync 且不轮转；outbox 每次入队重写整个队列（最多 10 万点）；shadow、northbound 状态同样 | `monitoring.go:72-78`、`tdengine.go:232,410-433`、`shadow.go:69`、`publisher.go:226` | 批量刷盘（按时间/条数）；history 轮转；outbox 改追加分段 | P1 | M |
| C4 | ✅ 已完成（阶段 3，16a5fb1）。outbox 分段先删旧再写新，中间崩溃丢数据；northbound/shadow/password 写入非原子或无 fsync | `tdengine.go:417-420`、`publisher.go:337`、`shadow.go:162`、`password.go:140` | 统一使用"临时文件 + fsync + rename"工具函数 | P1 | S |
| C5 | ✅ 已完成（8b7fe20）。改配置先改内存再保存，失败不回滚；每次改通道/位号重启全部驱动且持锁；北向发布器和 CMD 处理只认启动时配置 | `server.go:834-845`、`engine.go:114`、`main.go:90,93` | 保存成功后再切换快照；按通道增量重载；北向订阅配置变更 | P1 | M |
| C6 | ✅ 已完成（f9b0e9b）。Patch 接口可改写 `id`/`channelId`，跳过端口和通道校验 | `server.go:568-569,772-773` | 禁止修改主键字段；更新后重新跑校验 | P1 | S |
| C7 | ✅ 已完成（e30583f，100ms 合并，新增丢弃计数指标）。WS 每个样本单独发一条消息；客户端缓冲（32）满时静默丢弃 | `server.go:176`、`websocket.go:75-78` | 按 50–100 ms 合并批次；记录丢弃计数 | P1 | S |
| C8 | ✅ 已完成（94d202c、21bc203、8d4d7ac）。单个 Modbus 位号出错导致整个通道 offline | `acquisition/modbus.go:99-101` | 位号级质量码，通道状态只反映连接 | P1 | S |
| C9 | ✅ 已完成（87b5054）。脚本 `AutoDisabled` 重新启用后不复位 | `scripts.go:185,357` | 启用时清零崩溃计数 | P2 | S |
| C10 | ✅ 已完成（阶段 3，16a5fb1）。关停时不停止北向发布器和脚本定时器，不做最终刷盘 | `main.go:155-165` | 有序关停 + 最终 flush | P2 | S |
| C11 | ✅ 已完成（ac1b327、2eb3a70）。`/api/scheduler`、`/api/channels/{id}/test` 返回占位数据 | `server.go:825-828,892-898` | 实现或在 UI 标注"未实现" | P2 | M |

## D. Node 网关（已决定：冻结后下线）

> Q1 已决定（2026-11-06）：Node 冻结后下线。下表问题**不修复**，留作记录；
> 冻结期间 Node 不得在生产网段启动（D1/D2 可远程写 PLC、执行代码）。

| ID | 下线动作 | 优先级 | 工作量 |
|---|---|---|---|
| D0-1 | ✅ 已完成（阶段 4，d815b8f）。打冻结标签（如 `node-final`），之后 `apps/gateway` 只读 | P1 | S |
| D0-2 | ✅ 已完成（阶段 4，d815b8f）。`scripts/start-node-rollback.ps1`、`switch-console-gateway.ps1` 标记废弃；回滚改为"回退到上一个 Go 版本" | P1 | S |
| D0-3 | ✅ 已完成（阶段 4，d815b8f）。根 `package.json` 的 `dev`/`dev:gateway`、compose 的 `gateway` 服务改指 Go；模拟器脚本迁出 `apps/gateway`（e2e 和故障矩阵依赖它们） | P1 | M |
| D0-4 | ✅ 已完成（2026-11-09，并入控制台 `apps/console/src/shared`）。`packages/shared` 的类型改为由 Go API 契约生成，或改为前端私有 | P2 | M |
| D0-5 | ✅ 已完成（2026-11-09，tag `node-final` 保留最后版本）。确认 Go 补齐 Node 独有功能（用户管理、会话管理、审计查询、通道导入导出、备份恢复、恢复出厂）后，删除 `apps/gateway` 及其 vitest 测试 | P2 | L |

以下为 Node 已知问题，仅供参考，不修复：

| ID | 问题 | 位置 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| D1 | `/ws` 无鉴权即可写 PLC；CORS `origin: true` | `apps/gateway/src/index.ts:241,296-326` | WS 握手鉴权 + 角色检查 + Origin 校验 | P0* | S |
| D2 | 脚本运行在 `node:vm`，可经暴露函数拿到 `process`，等同远程执行代码 | `apps/gateway/src/scripts.ts:184-185` | 改用子进程/isolated-vm，或回滚实例禁用脚本 | P0* | M |
| D3 | 配置解析失败时用种子覆盖原文件（通道丢失、账号回到默认口令）；`saveConfig` 非原子 | `apps/gateway/src/config.ts:254-264` | 解析失败时保留原文件并拒绝启动；原子写入 | P0* | S |
| D4 | 大部分 GET 无鉴权，返回密钥和脚本代码 | `index.ts:850,857,908,1650` | 同 B4 / B7 | P0* | M |
| D5 | 注销/踢出会话不持久化，重启后复活；改角色、删用户不失效其会话 | `auth.ts:111,131,186` | 同步持久化；会话按用户版本号失效 | P1 | S |
| D6 | `alarm_events` 两处建表语句列名不一致，INSERT 失败被静默吞掉 | `index.ts:223`、`tdengine.ts:137` | 统一表结构，检查返回码 | P1 | S |
| D7 | Modbus 驱动无超时、重连时 interval 叠加、3x 地址用 FC03、写入固定 FC06 | `engine/drivers/modbus-tcp.ts:83,99,135,149` | 按问题逐项修复 | P1 | M |
| D8 | IEC104 断线后不重连，无 TESTFR 保活，逐帧打印十六进制日志 | `engine/drivers/iec104.ts:51-66` | 补重连和保活，日志降级 | P1 | S |

`P0*`：仅在 Node 继续承担回滚时为 P0。

## E. 测试与质量

| ID | 问题 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|
| E1 | 本机无 gcc，`go test -race` 从未运行 | CI（Linux）加 `-race` | P0 | S |
| E2 | 部分完成（cmd 57%、api 62%，全量路由×角色矩阵 4defa80）。Go 无路由级 RBAC 测试；config 包、cmd 无测试；api 覆盖率 27% | 表驱动 RBAC 矩阵测试（每条路由 × 每个角色） | P1 | M |
| E3 | ✅ 已完成（阶段 1–3 随附：esc_test、outbox 重启/导入测试、concurrency_test）。无 `esc`/SQL、outbox 崩溃恢复、并发改配置测试 | 针对 C1/C2/C4 补测试 | P1 | S |
| E4 | e2e 仅 87 行，依赖本机已启动服务且绑定 Edge，进不了 CI | e2e 自带启动（Go + 模拟器 + 静态控制台），CI 用 Chromium | P2 | M |

## F. 部署形态（参考 koike-gateway；Q2 已决定，CLI 与跨平台见 H 组）

| ID | 内容 | 建议动作 | 优先级 | 工作量 |
|---|---|---|---|---|
| F1 | ✅ 已完成（阶段 4，101b59f）。Go 网关不托管控制台，生产需另起 `npx serve`，compose 中控制台跑的是 Vite 开发服务器 | Go 网关可选托管 `web/` 静态目录（`os.Root`、CSP、缓存策略），也可独立部署到 Nginx/IIS | P1 | S |
| F2 | ✅ 已完成（阶段 4，68f3e94）。监听地址写死 `127.0.0.1`，只有 HTTP | 监听地址可配置；HTTPS（企业证书 / 自签名回退）；客户端网段白名单 | P1 | M |
| F3 | ✅ 已完成（阶段 4，26603e5）。没有发布包 | 由 H6 覆盖：Windows/Linux 两套发布包 | P1 | S |
| F4 | ✅ 已完成（阶段 2，8ac541c）。有默认账号 | 由 H4、H5 覆盖：生产模式无默认账号，用 `user create` 或初始化码创建首个管理员 | P1 | M |
| F5 | ✅ 已完成（f91f68b）。API 无版本、错误格式不统一 | `/api/v1` + 统一错误体 `{error,message,requestId}`；保留 `/api` 兼容期 | P2 | M |
| F6 | ✅ 已完成（2026-11-09，抽出 Runtime；未做无 API 运行模式）。API 与告警/脚本调度耦合在 `api.Server` 中 | 抽出运行时接口（参考 koike `Runtime`），关闭管理 API 时采集、告警、北向照常运行 | P2 | L |

**依赖关系：F1/F2 必须在 B1–B5 之后。** 在默认拒绝的鉴权落地前把监听地址放开到 `0.0.0.0`，等于把 PLC 写入口暴露到全网段。

## G. 存储改造（Q4 决定：SQLite 分两步）

| ID | 内容 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|
| G1 | ✅ 已完成（阶段 2，a629c88）。引入 `modernc.org/sqlite`，新建 `internal/db`：单一 `gateway.db`、WAL 模式、`busy_timeout`、带版本号的 schema 迁移；数据目录独立于 Node（合并 A4） | — | P1 | M |
| G2 | ✅ 已完成（阶段 3，11cd43c）。outbox 迁入 SQLite：按序追加、批量出队删除、上限和最大时长裁剪、丢弃计数；启动时导入旧 `outbox.json` 和分段文件 | G1 | P1 | M |
| G3 | ✅ 已完成（阶段 3，4ddc6ea）。history 缓冲、告警事件、审计迁入 SQLite，按时间索引、按保留期清理；导入旧 `history.jsonl`、`alarms.jsonl*`、`audit.jsonl` 时跳过损坏行 | G1 | P1 | M |
| G4 | ✅ 已完成（阶段 3，16a5fb1）。会话、shadow、北向序号迁入 SQLite；写入改为批量刷盘（按时间或条数），不再每个样本写一次 | G1 | P1 | S |
| G5 | ✅ 已完成（阶段 3，2e23456）。迁移完成后把旧 JSON 文件改名为 `*.migrated` 保留，不直接删除；补导入测试和崩溃恢复测试 | G2–G4 | P1 | S |
| G6 | 第二步：`Raw` 字段全部类型化，通道、位号、告警规则、北向、通知配置迁入 SQLite；JSON 只保留为导入导出和备份格式 | C2、G1 | P2 | L |

G2–G4 完成后，C3 和 C4 关闭。C2（配置改为不可变快照）不依赖 G 组，可以先做。

## H. 跨平台 CLI 与运行模式（Q2、Q3 决定）

目标：一个可执行文件 `factorybridge`（Windows 下为 `.exe`），Windows 和 Linux 上用同一套子命令完成部署、运维和排障，不依赖 PowerShell 脚本或 Node。

### 命令体系（草案）

| 命令 | 说明 |
|---|---|
| `run [--config 路径] [--dev]` | 前台运行；`--dev` 进入开发模式（见 H5） |
| `init [--dir 路径]` | 生成 `config.yaml` 样例、`data/`、`logs/`、`secrets/` 目录，并设置权限 |
| `config check [--offline]` / `config show` / `config export` / `config import 文件` | 校验配置，不加 `--offline` 时测试 TDengine、MQTT 和各通道连通性；查看生效配置（密码打码）；导出导入（不含密码） |
| `user create\|list\|passwd\|unlock\|disable\|enable\|delete` | 用户管理，口令交互输入、不回显；服务运行中也能执行，记审计 |
| `token create\|list\|revoke` | 管理 API Key，供脚本和第三方系统只读调用 |
| `service install\|uninstall\|start\|stop\|restart\|status [--name 名称]` | Windows 注册为服务，Linux 生成并启用 systemd 单元；同机多实例用不同名称 |
| `backup [--out 文件]` / `restore 文件` | 全量备份恢复：配置、SQLite、证书，生成 tar.gz 并附 sha256 |
| `migrate [--from 路径]` | 从旧 JSON/JSONL 数据导入 SQLite（G2–G5），也用于从 Node 数据目录迁移 |
| `simulate <协议> [--listen 地址]` | 内置协议模拟器，替代 `apps/gateway/scripts/*-sim`（D0-3） |
| `doctor` | 环境自检：端口占用、目录权限、证书有效期、TDengine/MQTT 可达性、磁盘余量 |
| `version` | 版本号、构建提交、构建时间 |

### 任务

| ID | 内容 | 依赖 | 优先级 | 工作量 |
|---|---|---|---|---|
| H1 | ✅ 已完成（阶段 2，00668a8）。命令框架：拆分 `cmd/factorybridge/main.go`，子命令分文件；统一 `--config`、`--data-dir`、`--log-level`；退出码规范（0 成功、1 一般错误、2 参数错误、3 配置错误） | — | P1 | M |
| H2 | ✅ 已完成（2026-11-09）。配置改为 `config.yaml`（采集配置仍走 API 和 SQLite，见 G6）；优先级：命令行 > 环境变量（`FB_` 前缀）> 配置文件 > 默认值；现有 26 个 `GATEWAY_GO_*` 等变量保留一个版本的兼容期并打印弃用提示 | H1 | P1 | M |
| H3 | ✅ 已完成（阶段 4，fb06c51）。路径与平台：默认目录 Windows 为程序所在目录，Linux 为 `/etc/factorybridge`、`/var/lib/factorybridge`、`/var/log/factorybridge`；`service` 子命令 Windows 走 SCM（`golang.org/x/sys/windows/svc`，替代 WinSW），Linux 生成 systemd 单元（专用用户、`ProtectSystem=strict`、`ReadWritePaths`）；平台差异用 build tag 隔离 | H1 | P1 | M |
| H4 | ✅ 已完成（阶段 2，8ac541c）。认证体系：多用户 + 角色（viewer / operator / engineer / admin，与控制台已有的 `engineer` 对齐）；口令用 argon2id 或 bcrypt，加口令策略；访问令牌短期有效 + 刷新令牌轮换；API Key 最高只能是 operator；密钥文件放 `secrets/`，Windows 用 DPAPI 加密，Linux 用 0600 权限；统一鉴权中间件（合并 B7） | B1–B5、G1 | P0 | L |
| H5 | ✅ 已完成（阶段 2，8ac541c）。运行模式：见下方规则 | H4 | P0 | M |
| H6 | ✅ 已完成（阶段 4，26603e5）。发布：`build` 脚本交叉编译 `windows/amd64`、`linux/amd64`、`linux/arm64`（`CGO_ENABLED=0`，依赖 G1 选纯 Go 的 SQLite）；产出 zip/tar.gz，内含二进制、`web/`、`config.example.yaml`、文档、sha256；`version` 注入提交号 | H1、F1 | P1 | S |
| H7 | ✅ 已完成（a206729）。文档：部署手册、快速部署步骤、安全验收说明（参考 koike `docs/`），Windows 和 Linux 各一节 | H1–H6 | P2 | M |
| H8 | CLI 测试：命令解析表驱动测试；`service` 在两个平台各做一次安装、启动、卸载的冒烟测试 | H1–H3 | P2 | S |

### H5 运行模式规则

| 项目 | 开发模式（`run --dev` 或 `mode: development`） | 生产模式（默认） |
|---|---|---|
| 认证 | 认证体系照常加载；启动时自动创建开发账号 `dev`，随机口令打印到控制台，或用 `FB_DEV_PASSWORD` 指定 | 无默认账号；首个管理员用 `user create` 或初始化码创建 |
| 免登录 | 可选 `--dev-no-auth`，所有请求按 admin 处理 | 不支持 |
| 监听地址 | 强制 `127.0.0.1`；绑定其他地址时拒绝启动 | 按配置 |
| 传输 | 允许 HTTP | 默认 HTTPS；用 HTTP 需显式配置并打印警告 |
| CORS | 自动允许 `http://localhost:*`（Vite 开发服务器） | 只允许白名单 |
| 写 PLC | 允许，审计中标记 `dev` | 按角色 |
| 可见性 | 启动日志、`/api/system/info`、控制台顶部横幅都标明"开发模式" | — |
| 防误用 | 以服务方式运行时拒绝进入开发模式 | — |

## 待讨论的问题

- **Q1** ✅ 已决定：Node 冻结后下线，D 组只做下线动作，不修复已知问题。
- **Q2** ✅ 已决定（2026-11-06）：对齐 koike 的单可执行文件形态，同时支持 Windows 和 Linux，提供一套独立的 CLI 操作体系。对应 H 组（并覆盖 F3、F4）。
- **Q3** ✅ 已决定（2026-11-06）：保留便于开发的开发模式，同时具备完整的认证体系；去掉隐式开放模式。对应 H4、H5。
- **Q4** ✅ 已决定（2026-11-06）：SQLite 分两步。
  第一步，把高频写入的状态数据迁到 SQLite（`modernc.org/sqlite`，纯 Go，不需要 cgo）：outbox、history 缓冲、告警事件、审计、会话、shadow、北向序号。这一步直接解决 C3 和 C4。
  第二步，等 `Raw` 字段全部类型化后，再把通道和位号配置迁入 SQLite。在此之前配置仍用 JSON，同时改成不可变快照（C2）。
  时序历史仍放 TDengine；JSON 只保留为导入导出和备份格式。
  对应任务见 G 组。
- **Q5** ✅ 已决定（2026-11-06）：仓库先放在本地，主分支改名为 `main`。对应 A1、A2。

## 建议执行顺序（全部问题已决定，待确认后开工）

| 阶段 | 内容 | 说明 |
|---|---|---|
| 0 仓库收口 | A3 → A1 → A2 | 先补 `.gitignore`，再提交、改名 `main`、建本地 bare 仓库和本地门禁脚本。半天内可完成，后续所有改动都在版本控制下进行 |
| 1 P0 止血 | C1、B1、B2、B5、B4、C2，同时做 E1 | 每项改动小、风险集中；`-race` 需要 C 编译器，本机可装 MinGW-w64 或在 WSL 中运行 |
| 2 CLI 与认证 | H1 → H4、H5（同时关闭 B3、B6、B7） | 认证体系依赖 G1 的 SQLite，可先把 G1 拉到本阶段开头 |
| 3 存储改造 | G1–G5（关闭 C3、C4） | 迁移命令放在 H 组的 `migrate` 子命令里 |
| 4 跨平台交付 | H2、H3、H6、F1、F2，然后 D0-1 ~ D0-3 | 认证落地后才放开监听地址；模拟器迁入 `simulate` 子命令后才能冻结 Node |
| 5 收尾 | C5–C11、E2–E4、G6、H7、H8、F5、F6、D0-4、D0-5 | 按现场反馈调整顺序 |

## 阶段 2 决定（2026-11-07）

- 范围：本轮只做认证链路：H1 命令框架、G1 SQLite、H4 多用户与统一鉴权、H5 开发模式。H2、H3、G2–G5 留到后续阶段。
- 旧账号：只迁移 Go 现有的 `auth.json`（单个 admin），保留其口令哈希；Node `config.json` 中的 engineer、operator 不导入，由管理员重新创建。
- 角色：四级 viewer < operator < engineer < admin，路由权限对齐 Node 网关：
  - 配置类写操作（通道、位号、告警、配方、脚本、存储任务、北向、通知）要求 engineer。
  - 用户、会话、审计、驱动切换、系统运维要求 admin。
  - 写值、告警确认、脚本运行、配方下发要求 operator。

## 阶段 3 记录（2026-11-07）

- 状态数据（outbox、历史缓冲、告警事件、审计、影子、北向队列）全部迁入 `gateway.db`，写入经 `db.Batch` 每秒合并为一个事务。
- 实测：
  - 硬杀进程后库完整（`integrity_check` 为 ok），重启后队列恢复。
  - 正常关停时，信号前内存队列 498 条，退出后库中 498 条。
- 用主用数据目录副本跑 `migrate`：
  - 审计导入 1391 条，其中 1317 条为 Node 格式。
  - 影子导入 55 条；北向队列 622 条中 614 条为空帧，已丢弃，导入 8 条。
  - `history.jsonl` 的 126.9 万点全部超出 7 天保留期，未导入（这些数据最晚到 2026-09-25）。
- 仍未关闭：
  - C5 的“按通道增量重载”和“北向订阅配置变更”。
  - G6：配置迁入 SQLite。

## 阶段 4 决定（2026-11-07）

- 模拟器：改用 ProtoForge（`D:\Projects\sim-foundry-main`），本项目不再维护 Node 模拟器。ProtoForge 没有 IEC104，IEC104 模拟器暂留 `apps/gateway/scripts`。故障矩阵与 compose 改指 ProtoForge 后，Node 网关即可冻结（D0）。
- HTTPS：默认仍只监听 127.0.0.1、走 HTTP。`--host` 设为非回环地址时强制 HTTPS：未提供证书则自动生成自签名证书；可配置客户端网段白名单。

## 阶段 4 记录（2026-11-07）

- F1：网关同端口托管控制台，`--web-dir` 缺省找可执行文件旁的 `web/`。
- F2：非回环地址强制 HTTPS，自签名证书写在数据目录下；新增 `--allow-cidr` 白名单。
  - 实测绑定 172.17.96.1：HTTP 访问 400，TLS 1.1 握手失败，指定 CA 后返回 200。
- H3：`service` 子命令，Windows 走 SCM，Linux 走 systemd。本机无管理员权限，install/start 未在真实 SCM 上验证。
- H6：`pnpm release` 产出三个平台的包，8.0–8.8 MiB，SHA256SUMS 校验通过。Windows 包解压后可直接运行并托管控制台。
- D0：
  - Node 网关打 tag `node-final` 并冻结。
  - 故障矩阵改用 ProtoForge：6 个协议中 5 个通过；FINS 因 ProtoForge 停止后不释放端口而失败。
  - Compose 改为 Go 网关加 ProtoForge，只做了语法校验。
- 未完成：
  - D0-4（`packages/shared` 归属）。
  - D0-5（删除 Node 目录，前提是补齐功能并迁出 IEC104 模拟器）。
  - 故障矩阵中 OPC UA、BACnet、MQTT、IEC104 四个协议未覆盖。

## 剩余任务梳理（2026-11-07，阶段 4 切换后）

按“是否影响现在正在用的东西”分组。Node 网关已冻结，D1–D8 不修，不列入。

### 第一组：控制台功能缺口（用户点了会报错）

> ✅ 2026-11-07 已全部补齐（11fc2b7、ac1b327、df1126e、2eb3a70、c05f9e6）。见文末“控制台功能缺口补齐记录”。

控制台调用了以下 9 个 Node 接口，Go 网关没有实现，对应页面按钮在 Go 上返回 404：

- 通道导入导出：`channels/import`、`channels/{id}/export`
- 抓包帧：`channels/{id}/frames`
- 配置备份恢复：`system/config-backup`、`system/config-restore`
- 恢复出厂：`system/factory-reset`
- 诊断与 OpenAPI：`system/diag`、`system/openapi.json`
- 调度：`scheduler/rebalance`

另外 C11：`/api/scheduler` 与连接测试接口返回的是占位数据，调度页吞吐恒为 0。

这一组也是 D0-5（删除 Node 目录）的前提。

### 第二组：运维与安全收尾（工作量小）

- A6：`admin123` 仍写死在 5 个脚本、2 个 e2e 用例中；主用 admin 口令仍为 `admin123`。
- A4：Go 默认数据目录仍是 `apps/gateway/data`。
- B8：脚本子进程继承全部环境变量，无内存上限。
- B9：控制台把会话令牌放在 WS 的 `?token=` 查询参数里，会进代理和访问日志；可改为短期一次性票据。
- C6、C8、C9、C7：小缺陷，各半天以内。
- A5：模板残留文件。

### 第三组：验证缺口（做过但没实测）

- E1：`go test -race` 从未运行（本机无 C 编译器）。
- H3/H8：`service install/start` 未在真实 SCM 和 systemd 上执行（需要管理员权限或 Linux 机器）。
- Compose 栈未实际启动（Docker 未运行）。
- 故障矩阵：FINS（ProtoForge 缺陷）、OPC UA、BACnet、MQTT、IEC104 未覆盖。
- E2：api 包覆盖率 38.7%，acquisition 43.8%，cmd 28.3%。
- E4：e2e 依赖本机服务，进不了 CI。

### 第四组：结构性改造（大，按需）

- C5：✅ 已完成（2026-11-09）。改配置时重启全部驱动；北向配置变更要重启网关才生效。
- G6：配置迁入 SQLite。
- H2：`config.yaml` 与 `FB_` 环境变量前缀。
- F5：✅ 已完成（f91f68b）。`/api/v1` 版本化与统一错误体。
- F6：拆分 `api.Server`。
- D0-4：`packages/shared` 归属。
- H7：✅ 已完成。部署手册与安全验收文档。

## 控制台功能缺口补齐记录（2026-11-07）

9 个接口与调度统计全部补齐，在隔离网关 + Modbus 模拟器上实测：

- 调度页：吞吐、累计采样、平均周期都是真实值，原来全部为 0。
- 报文诊断：显示实时 TX/RX；“清空”按钮修复后可用。
- 通道导出、导入：导入得到新 ID，点位一起导入，同名通道返回 409。
- 备份恢复：往返成功。
- 诊断包与 OpenAPI 文档：能下载，OpenAPI 共 62 个路径。
- 重平衡：返回已重载的通道数。

分工：
- 子任务（Haiku）实现了导入导出、诊断包、OpenAPI、备份恢复、恢复出厂、重平衡。
- 主会话实现了报文抓包与通讯统计，并负责核查。核查发现两处问题，均已修复：
  - 恢复配置后，变化率告警的上一次取值没有清零。
  - 控制台“清空”按钮用的是裸 fetch，没带令牌，请求被 401 拒绝。

限制：
- 报文抓包只覆盖 TCP 驱动（Modbus、MELSEC、FINS、EtherNet/IP、IEC104）。S7、OPC UA、SNMP、BACnet、MQTT 的诊断面板为空。
- 导出的通道包里口令已脱敏，导入后需要重新填写。
- `tx` 与 `rx` 都按成功轮询周期数统计，不是真实的报文数。

## 第二组完成记录（2026-11-07）

在隔离网关（18099）+ Modbus 模拟器上实测：

- C8：在模拟器 1000 个寄存器之外加一个位号（41500）。通道保持 online，详情为 "OK 0ms, 1/4 tags bad"；只有该位号质量为 Bad，其余 3 个为 Good。
- C7：5 秒内收到 6 个批次、共 24 个值；`factorybridge_websocket_dropped_total` 为 0。
- B9：票据可建立连接，重复使用被拒。
- C6、B8、C9：单元测试覆盖（patch_test、scripts_env_test、scripts_reenable_test）。
- A6：压测、长稳、e2e 和 3 个 PowerShell 脚本改读环境变量（GATEWAY_PASSWORD、E2E_PASSWORD），未设置时报错或跳过。

分工：A6、B8、C6、C8 由子任务（Haiku）实现，主会话核查。核查发现并修复：一次提交引用了不存在的测试辅助函数（8d4d7ac 修复）；周期延迟解析不认带逗号的状态详情（b0e1991）。首次 C8 实测用的地址 40500 在模拟器范围内，没有测到坏位号路径，已改用 41500 重测。

A4、A5 随后完成：
- A4：默认数据目录改为 `apps/gateway-go/data`（发布包为可执行文件旁的 `data/`）。新目录为空时，从 `apps/gateway/data` 复制 `config.json`、`gateway.db`（只读打开，VACUUM INTO 快照）和未导入的旧状态文件；旧目录不改动。显式 `--data-dir` 不导入。在仓库副本上实测：用户与配置随之迁移，旧目录的 gateway.db、WAL 和 config.json 字节不变。
- A5（子任务 Haiku 实现，主会话核查）：删除 `metadata.json`；`.env.example` 改为网关实际读取的环境变量参考。核查改正了两处：数据目录默认值、outbox 超限时丢弃的是最旧的点。

未完成：
- 主用网关 admin 口令需在现场更换。
- 主用网关 18080 仍运行 a893f69，未包含本组修复。

## 收尾记录（2026-11-09）

- A6 剩余（子任务 Haiku 实现，主会话核查）：网关不再内置 TDengine 口令 `taosdata`。设置了 `TDENGINE_URL` 而未设 `TDENGINE_PASSWORD` 时拒绝启动（退出码 3），已用二进制实测。`start-go-local.ps1` 增加 `-TDenginePassword`。compose 演示栈仍沿用镜像默认口令，并注明生产必须修改。
- B8 剩余：脚本子进程加内存上限。看门狗每 10ms 读堆占用，超过 64 MB 中断脚本（返回 "script memory limit exceeded"，丢弃该次写值）；超过 128 MB 直接退出子进程（应对单次巨大分配，中断来不及生效）。实测循环分配走中断路径，`'x'.repeat(1<<29)` 走退出路径，普通脚本不受影响。
- E2 部分（子任务 Haiku 实现，主会话核查）：cmd/factorybridge 覆盖率 31.0% → 57.1%，scriptworker 81.6%。子任务报告的问题中，`user` 未知子命令会先打开（新建）数据库，已修复；其余为风格问题未改（envInt 直接写 stderr、migrate 中未使用的 users 变量、开发账号随机口令写入日志）。

仍未做：E1 `-race`（本机无 C 编译器）、Compose 实启（Docker 未运行）、H3/H8 真实服务安装、第四组结构性改造。

## C5 配置热更新（2026-11-09）

- 采集：新增 `Engine.Apply`，只重启参数或位号有变化的通道；新增、删除、停用通道分别启动、停止。未变化通道的连接和采集不中断，位号快照保留。所有经 API 的配置修改（通道、位号、导入、恢复）都走这条路径；"重平衡"仍按原意全部重载。
- 北向：`PUT /api/northbound` 立即生效。地址、账号、组/节点 ID 或启用状态变化时断开重连；只改刷新间隔不重连。停用时同时停止 paho 的自动重试。点表随配置更新，有变化时重发 BIRTH；MQTT 下发命令按当前点表查位号，启动后新增的位号也能下发。
- 测试：acquisition 5 个、northbound 5 个新用例（含真实 TCP 监听验证重连到新地址、停用后不再重试）。
- 实测（隔离网关 + Modbus 模拟器）：新建、修改、删除一个 Modbus 通道，日志里每次只重启该通道；mb-01 的接收计数在此期间持续增长（54 → 58）。北向启用后立即开始连接（bdSeq 1），停用后停止。

## 脚本失败时丢弃写值（2026-11-09）

隔离子进程模式（默认）下，脚本在 `Write(...)` 之后抛异常或超时，之前登记的写值仍会写入 PLC；inline 模式原本就不执行。现在两种模式一致：脚本只要失败（异常、超时、内存超限），本次运行的写值全部丢弃。网关侧再按 `ok` 判断一次，即使子进程返回了写值也不执行。用编译后的子进程实测：抛异常、死循环超时都返回 `writes: null`，正常脚本照常写值。

门禁偶发失败：本次有 1 次 `go test` 失败，输出未保留，之后门禁 8 次、全量测试 5 次、高负载下计时相关用例 8 次均通过，未能复现。下次出现时保留 `.tmp/gate-*.log` 定位。

## F5 与 H7（2026-11-09）

- F5：`/api/v1/...` 与 `/api/...` 指向同一组处理函数（在鉴权、白名单、CORS 之前改写路径，权限一致），响应头 `API-Version: 1`。所有 `/api` 错误响应统一为 `{"ok":false,"error":"…","code":"…"}`：原有 `error` 文字不变（控制台照旧读取），按状态码补 `code`，原有额外字段保留；ServeMux 的纯文本 404/405 改写为 JSON。OpenAPI 文档增加 `Error` 结构。隔离网关实测：错误登录、无令牌、未知路径、405、参数错误、跨站来源都返回统一格式，成功响应不变，控制台页面正常。
- H7（子任务 Haiku 编写，主会话核查）：`deploy/README.md` 扩展为完整部署手册；新增 `docs/SECURITY_ACCEPTANCE.md` 安全验收清单。核查了文中所有 API 路径、命令行参数和环境变量均存在于代码；改正 3 处：明文 HTTP 访问 HTTPS 端口实测返回 400；会话默认 8 小时；脚本自动禁用的表现。
- 配置备份口令（核查时发现，随后修复）：见下节。
- `deploy/systemd/factory-bridge-gateway.service` 已改为 `factorybridge service install` 生成内容的参考副本（2026-11-09）。

## 配置备份不再导出口令（2026-11-09）

- `GET /api/system/config-backup` 默认把口令类字段置空并加 `<字段>Set` 标记（与各配置页"只写不读"一致），响应带 `secretsOmitted: true`。需要完整迁移时显式加 `?includeSecrets=1`，审计日志记录该参数。
- `POST /api/system/config-restore`：文件里为空的口令沿用本机当前值（通道、位号按 ID 对应）；本机也没有、但备份标记原本已设置的，列在响应 `secretsMissing` 中，控制台恢复后提示需重新填写。`<字段>Set` 标记不写入配置。
- 测试 5 个新用例（默认不泄露、显式包含、同机恢复保留口令、新网关列出缺失项、完整备份以文件为准）。隔离网关实测：北向口令写入后，默认备份不含该口令，完整备份含；用默认备份恢复后口令仍在，`passwordSet` 未写入 config.json。

## D0-4、D0-5：删除 Node 网关（2026-11-09，分支 chore/remove-node-gateway）

- D0-4：`packages/shared`（协议元数据、参数表、地址校验、类型）只剩控制台使用，并入 `apps/console/src/shared`，测试移到 `apps/console/test`。不改为由 Go 契约生成：Go 侧没有这些元数据，代价大于收益。
- D0-5：删除 `apps/gateway`（64 个受控文件）与 `packages/shared`。最后版本见 tag `node-final`（eacc6b0）。磁盘上未受控的 `apps/gateway/data`（72 MB，A4 之前的数据目录、首次启动复制的来源）未删除。
- 保留的模拟器：Modbus TCP 与 IEC104 迁到 `tools/sim`（包名 `@iotconnector/sim`，IEC104 编解码一并迁入）。其余协议用 ProtoForge。compose 的 iec104-sim 服务、`scripts/fault-matrix.mjs` 与部署手册已改路径。
- 删除只服务 Node 的脚本：`start-node-rollback.ps1`、`restart-gateways.ps1`、`start-go-gateway.ps1`、`compare-gateways.ps1`、`fault-matrix.ps1`、`protocol-write-probe.ps1`、`start-all.sh`，以及根 `package.json` 的 `dev:node-gateway` 和 Node 网关专用的开发依赖。
- 验证：门禁通过（typecheck、vitest、go vet、go test、go build）；`tools/sim` 类型检查通过，两个模拟器实际启动监听；控制台构建成功。

## H2：配置文件与 FB_ 环境变量（2026-11-09）

- `factorybridge run --config <文件>`（或 `FB_CONFIG`）读取 YAML 运行参数，示例 `deploy/factorybridge.example.yaml`。优先级：命令行 > 环境变量 > 配置文件 > 默认值。配置文件只放运行参数，采集配置仍在 `config.json`（G6 另议）。
- 环境变量统一为 `FB_` 前缀（FB_PORT、FB_DATA_DIR、FB_TDENGINE_URL 等）。旧名 `GATEWAY_GO_*`、`TDENGINE_*` 本版本仍生效，每个旧名首次使用时提示一次弃用；新旧同时设置以新名为准。
- 口令、令牌、开发模式不接受配置文件；未知键拒绝启动（退出码 3），避免拼错后静默不生效。数据目录写在配置文件中视为显式指定，不从旧 Node 目录复制。
- 新增 6 个测试（优先级、弃用提示只出现一次、未知/口令键拒绝、`--config` 解析、配置文件中的数据目录、TDengine 口令新旧名）。用编译后的二进制实测：配置文件端口生效；旧变量覆盖文件并提示弃用；FB_ 新名覆盖旧名；配置文件含口令时退出码 3。
- 已改为新名：`.env.example`、`scripts/start-go-local.ps1`、`docker-compose.yml`、部署手册、安全清单。
- 依赖：`gopkg.in/yaml.v3` 由间接依赖改为直接依赖（本机模块缓存已有，未联网）。

## F6：运行时与 HTTP 层分离（2026-11-09）

- 新增 `internal/api/runtime.go`：`Runtime.onSample` 集中分发采集样本（历史 → 时序库 → 存储任务 → 北向 → 脚本 → 影子 → 告警 → 实时推送），顺序与拆分前一致。原先这段逻辑写在 `NewServerWithOptions` 的回调里；位号查找由两次合并为一次。
- 脚本引擎与存储任务引擎不再持有 `*Server`，只依赖 `runtimeHost` 接口（读写配置、读写位号、时序库）。新测试用一个只实现该接口的假宿主跑通脚本读写，证明依赖已收窄。
- 未做：不启动管理 API 只运行采集的模式（未选）。
- 顺带修复：inline 脚本模式（`FB_SCRIPT_INLINE=1`，仅开发用）下 `Write(tag, 42)` 的整数会被当成字符串 `"42"` 写入 PLC；默认的隔离子进程模式不受影响。`decodeAnyValue` 现在识别各种整数与 float32。这个问题是新测试发现的。
