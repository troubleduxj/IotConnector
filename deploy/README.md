# Factory Bridge 部署指南

> 自 2026-11-07（阶段 4）起，主用运行时为 Go 网关单一可执行文件 `factorybridge`。
> Node 网关（`apps/gateway`）已于 2026-11-09 删除（最后版本见 git tag `node-final`），不作为部署方式。本目录下 `windows/`（WinSW）是已删除的 Node 网关的服务文件，仅作历史参考；
> `systemd/factory-bridge-gateway.service` 是 `factorybridge service install` 在 Linux 上生成内容的参考副本。
> 两个平台都请直接使用 `factorybridge service install`。

本文说明如何安装、配置、升级和维护 Go 网关。环境变量的完整列表见仓库根目录的 `.env.example`，本文不重复。
安全验收项见 `docs/SECURITY_ACCEPTANCE.md`，现场交付前逐项核对。

## 系统要求

- 操作系统：Windows（amd64），或 Linux（amd64、arm64）。Linux 上服务安装依赖 systemd。
- 权限：安装服务需要管理员（Windows）或 root（Linux）。日常运维的 `user`、`run` 命令不需要。
- 磁盘：数据目录需要可写，SQLite 状态库（`gateway.db`）与 WAL 文件都放在数据目录下。
- 网络：对外监听时，客户端所在网段要能访问网关端口，默认 `18080`。
- TDengine（可选）：只有需要把历史数据写入 TDengine 时才需要，见下文「TDengine」。
- 构建环境：只在从源码打包时需要 Go 与 pnpm，现场部署不需要。

## 获取发布包

```bash
pnpm release                      # 构建 windows/amd64、linux/amd64、linux/arm64
pnpm release linux/amd64          # 只构建指定平台
```

产物在 `dist/release/<版本>/`：每个平台一个压缩包，`SHA256SUMS` 覆盖压缩包和可执行文件。
部署前核对哈希。Linux 用 `sha256sum -c SHA256SUMS`；Windows 用 `Get-FileHash -Algorithm SHA256 <文件>` 与 `SHA256SUMS` 比对。

## 发布包内容与目录布局

每个压缩包解压后是一个目录，名称为 `factorybridge-<版本>-<系统>-<架构>`：

```text
factorybridge-<版本>-windows-amd64/      （Linux 为 factorybridge，无 .exe）
├── factorybridge.exe                    单一可执行文件（Linux 为 factorybridge）
├── web/                                 控制台静态文件（含 index.html）
├── README.md                            网关的 README（apps/gateway-go/README.md，不是本文）
└── INSTALL.txt                          本包的简要安装步骤
```

- 压缩包格式：Windows 为 `.zip`，Linux 为 `.tar.gz`。
- `web/` 必须与可执行文件在同一目录。网关在可执行文件旁查找 `web/`，找不到时只提供 API。
- 发布包不包含数据目录和配置文件。数据目录在首次运行时由网关创建。

## 首个管理员账号

系统没有默认账号。部署后第一件事是创建管理员：

```bash
factorybridge user create --name admin --role admin --data-dir <数据目录>
```

- 口令交互输入两次，不回显。脚本中可用 `--password-stdin` 从标准输入读取第一行。
- 口令至少 12 个字符，必须同时包含大写字母、小写字母、数字和特殊字符。
- 命令行创建的账号不要求首次登录改密，口令由操作者本人设定。
- `--role` 默认为 `viewer`，可选值见下文「角色」。
- 管理员账号可以在网关运行中创建，也可以在停止网关后创建。两种情况下数据库都是同一个 `gateway.db`。

角色说明（来自 `internal/auth`）：

| 角色 | 能做什么 |
| --- | --- |
| `viewer` | 只读：查看通道、位号、历史、告警、脚本输出、实时数据 |
| `operator` | viewer 的全部权限，加上确认告警、运行脚本、写位号、下载配方、查看通道报文 |
| `engineer` | operator 的全部权限，加上修改通道、位号、告警、脚本、配方、北向配置等 |
| `admin` | engineer 的全部权限，加上用户与会话管理、审计日志、配置备份与恢复、恢复出厂、系统诊断、删除通道、修改驱动 |

查看与修改账号：

```bash
factorybridge user list --data-dir <数据目录>
factorybridge user role --name <用户名> --role <角色> --data-dir <数据目录>
factorybridge user passwd --name <用户名> --data-dir <数据目录>      # 重置口令，用户下次登录须改密
factorybridge user disable|enable|unlock|delete --name <用户名> --data-dir <数据目录>
```

系统保证至少保留一个启用的管理员。试图降级或禁用最后一个管理员会失败。

## 数据目录

数据目录保存配置、状态库和证书。目录位置按以下规则确定：

1. 指定 `--data-dir` 或环境变量 `GATEWAY_GO_DATA_DIR` 时，使用该目录。
2. 未指定时，从仓库内运行（当前目录有 `apps/gateway-go`，或在仓库根、`apps/gateway-go` 下有 `go.mod` 与 `cmd/factorybridge`）
   使用 `apps/gateway-go/data`，或仓库根下的 `data`。
3. 其它位置（发布包）使用可执行文件旁的 `data/`。

数据目录中的主要文件：

| 文件 | 内容 |
| --- | --- |
| `gateway.db`、`gateway.db-wal`、`gateway.db-shm` | SQLite 状态库：用户、会话、历史、告警、审计、待发送队列、北向队列、影子数据 |
| `config.json` | 通道、位号、通知、北向等配置 |
| `tls/selfsigned.crt`、`tls/selfsigned.key` | 自动生成的自签名证书（仅在未提供证书时生成） |
| `outbox.json`、`alarm-outbox.json` | TDengine 写入队列（仅在设置 `TDENGINE_URL` 时使用） |
| `northbound.json` | 北向相关状态的旧版文件，首次启动导入库后改名为 `*.migrated` |

首次复制旧数据：未显式指定数据目录，且目标目录里还没有 `config.json` 与 `gateway.db` 时，网关会从旧的 Node 网关目录
`apps/gateway/data` 复制状态（只复制，不移动，旧目录不改动）。这个规则只在仓库内运行时生效。发布包不会复制旧数据。
要从旧版迁移，把旧目录的 `config.json`、`auth.json` 等文件手工放入新数据目录，网关会在启动时导入。

显式指定 `--data-dir` 或 `GATEWAY_GO_DATA_DIR` 后，不做任何复制。

服务安装时必须给出绝对路径的数据目录，例如 `D:\FactoryBridge\data` 或 `/var/lib/factorybridge`。

## Windows 安装

以管理员身份打开命令行，进入解压后的目录：

```powershell
cd D:\FactoryBridge\factorybridge-<版本>-windows-amd64
.\factorybridge.exe user create --name admin --role admin --data-dir D:\FactoryBridge\data
.\factorybridge.exe run --data-dir D:\FactoryBridge\data        # 可选：前台试运行，Ctrl+C 停止
```

注册服务：

```powershell
.\factorybridge.exe service install --data-dir D:\FactoryBridge\data -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
.\factorybridge.exe service start
.\factorybridge.exe service status          # 普通用户也可以查询
.\factorybridge.exe service stop
.\factorybridge.exe service restart
.\factorybridge.exe service uninstall       # 只删除服务，数据目录和账号保留
```

- `service install` 需要管理员权限。服务名默认 `factorybridge`，用 `--name` 改名。
- 服务的执行文件是安装时正在运行的 `factorybridge.exe` 的真实路径。请在最终安装位置执行 `service install`，
  移动可执行文件后需要卸载再重装。
- 运行账号是虚拟账号 `NT SERVICE\<服务名>`，不是 LocalSystem。安装时会给该账号授予数据目录的修改权限（`icacls ... (OI)(CI)M`）。
- 启动类型为延迟自动启动。异常退出后 10 秒、30 秒、60 秒各重启一次。
- `--` 之后是传给 `run` 的参数（`--host`、`--port`、`--allow-cidr`、`--tls-cert` 等）。这些参数在安装时固化，
  改参数需要 `service uninstall` 后重新 `install`。
- 服务参数中不允许 `--dev` 开头的参数，也不允许把 `--data-dir` 放在 `--` 之后。

## Linux 安装

Linux 上使用 `factorybridge service install` 注册 systemd 服务；`deploy/systemd/factory-bridge-gateway.service` 是该命令生成内容的参考副本，手工安装时可以以它为起点。

```bash
sudo ./factorybridge user create --name admin --role admin --data-dir /var/lib/factorybridge
sudo ./factorybridge service install --data-dir /var/lib/factorybridge -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
sudo ./factorybridge service start
./factorybridge service status              # 也可用 systemctl status factorybridge
journalctl -u factorybridge -f
```

`service install` 做的事：

- 如果运行账号 `factorybridge` 不存在，用 `useradd --system --no-create-home --shell /usr/sbin/nologin` 创建。
  `--user` 可以指定其它账号。
- 把数据目录的属主改为该账号（`chown -R`）。
- 生成 `/etc/systemd/system/factorybridge.service`，执行 `systemctl daemon-reload` 和 `systemctl enable`。

生成的单元文件的加固项：`NoNewPrivileges=true`、`ProtectSystem=strict`、`ProtectHome=true`、`PrivateTmp=true`，
`ReadWritePaths` 只包含数据目录。`AmbientCapabilities=CAP_NET_BIND_SERVICE` 只在需要监听 1024 以下端口时才有用，
默认端口 18080 用不到。异常退出后 5 秒重启，60 秒内最多启动 5 次。

`service uninstall` 会停止并禁用服务、删除单元文件，但不删除数据目录和账号。

## 对外监听与 HTTPS

默认只监听 `127.0.0.1:18080`，走 HTTP。对外提供服务时，需要设置监听地址和白名单：

```bash
factorybridge run --host 0.0.0.0 --allow-cidr 10.0.0.0/8,192.168.1.20
```

- 监听非回环地址（不是 `127.0.0.1`、`::1` 或 `localhost`）时，网关强制使用 HTTPS。
- 设置 `--tls-cert` 时，即使监听回环地址也使用 HTTPS。`--tls-cert` 和 `--tls-key` 必须成对给出。
- 未指定证书时，网关在 `<数据目录>/tls/` 下生成 ECDSA P-256 自签名证书，有效期 825 天。证书过期前 30 天会重新生成。
  证书的 SAN 包含 `localhost`、本机主机名，以及 `--host` 指定的 IP；`--host 0.0.0.0` 时写入本机所有非回环接口地址。
  自签名证书只适合测试，浏览器会提示不受信任。
- 生产环境使用企业 CA 签发的证书：

  ```bash
  factorybridge run --host 0.0.0.0 --tls-cert /etc/fb/site.crt --tls-key /etc/fb/site.key --allow-cidr 10.0.0.0/8
  ```

  TLS 最低版本为 TLS 1.2，只启用带前向保密的 AEAD 套件。

### 访问白名单

`--allow-cidr` 接受逗号分隔的网段或单个地址，例如 `10.0.0.0/8,192.168.1.20`。环境变量 `GATEWAY_GO_ALLOW_CIDRS` 等效。

- 白名单按 TCP 对端地址判断，不信任 `X-Forwarded-For`。
- 不在白名单内的来源会收到 HTTP 403，错误信息为 `client address not allowed`。
- 回环地址（`127.0.0.0/8`、`::1`）始终允许，本机的 `user` 命令、健康检查不会被挡住。
- 监听非回环地址但没有设置 `--allow-cidr` 时，启动日志会给出警告。

### 控制台

`web/` 与可执行文件同目录时，网关在同一端口提供控制台。也可用 `--web-dir` 指定目录，或设置 `GATEWAY_GO_WEB_DIR`。

如果控制台放在另一台 Web 服务器（Nginx、IIS）上，需要在 `GATEWAY_GO_CORS_ORIGINS` 中加入该站点的来源，逗号分隔。

## TDengine

TDengine 是可选的历史存储。配置方式：

- `TDENGINE_URL`：TDengine REST 地址，例如 `http://tdengine:6041`。设置后网关启用写入，并使用 `outbox.json` 做离线缓存。
- `TDENGINE_PASSWORD`：必须与 `TDENGINE_URL` 同时设置。只设置 URL 不设置密码时，网关记录错误并以退出码 `3` 退出，不会回退到默认密码。
- `TDENGINE_USER`（默认 `root`）、`TDENGINE_DB`、`TDENGINE_STABLE` 可选。

Docker Compose 演示栈（`docker-compose.yml`）中，`TDENGINE_PASSWORD` 默认值为 `${TDENGINE_PASSWORD:-taosdata}`，
即 TDengine 镜像的默认密码。这只适用于演示。生产环境必须修改 TDengine 的 root 密码，并显式设置 `TDENGINE_PASSWORD`。

## 北向 MQTT

北向 MQTT 在控制台的北向配置中设置（对应接口 `PUT /api/northbound`，需要 engineer 权限）。保存后立即生效，不需要重启网关。
配置变更后，网关会重新连接 MQTT broker。MQTT 密码是只写字段，读取时返回空值，见安全验收清单。

## 升级

1. 停止服务：`factorybridge service stop`（Linux 也可 `sudo ./factorybridge service stop`）。
2. 备份数据目录（见下文「备份与恢复」）。
3. 替换可执行文件 `factorybridge.exe`（或 `factorybridge`）与 `web/` 目录。
4. 启动服务：`factorybridge service start`。

- 数据库迁移在网关打开状态库时自动执行，不需要单独步骤。
- 从旧版本升级时，旧的 JSON/JSONL 状态文件在首次启动时导入 `gateway.db`，原文件改名为 `*.migrated`。
- 在启动前可以离线查看待导入的旧文件：

  ```bash
  factorybridge migrate --data-dir <数据目录> --dry-run
  ```

  `--dry-run` 只列出待导入的旧状态文件，不修改任何内容，也不显示数据库迁移。
- 不带 `--dry-run` 执行 `migrate` 会立即导入旧文件。建议先停止网关再执行。

## 备份与恢复

### 备份内容

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 整个数据目录 | `<数据目录>` | 最完整的备份。包括用户、会话、历史、告警、审计、配置和证书 |
| 状态库 | `gateway.db`、`gateway.db-wal`、`gateway.db-shm` | 三个文件要一起复制。只复制 `gateway.db` 可能丢失 WAL 中未合并的数据 |
| 配置 | `config.json` | 通道、位号、通知、北向等配置 |
| 证书 | `tls/` | 自签名证书或site证书所在目录 |

控制台的配置备份（`GET /api/system/config-backup`，需要 admin 权限）只导出配置，不导出数据库。它返回一个 JSON 文件，
文件名 `factorybridge-config.json`，格式为 `factorybridge-config@1`，包含 `schemaVersion`、`channels`、`tags` 和配置的其它部分。
不包含 `users`。它不包含用户、会话、历史、告警、审计和待发送队列。对应的恢复接口是 `POST /api/system/config-restore`（需要 admin 权限）。

配置备份默认不含口令（北向 MQTT 密码、通知邮箱密码、钉钉密钥与 webhook 地址、通道口令等）：这些字段为空，并带 `<字段>Set` 标记说明原本已设置。在同一台网关上恢复时沿用本机现有口令；恢复到另一台网关时，响应里的 `secretsMissing` 列出需要重新填写的项，控制台恢复后会提示。
迁移到新网关、确需连同口令一起备份时，用 `GET /api/system/config-backup?includeSecrets=1`（需要 admin 权限，审计日志记录 `includeSecrets`）。这样的文件要按口令材料保管。
`config.json` 本身仍以明文保存口令，数据目录的权限只开放给网关服务账号和运维人员。

### 备份操作

完整备份的推荐做法是停止服务后复制整个数据目录：

```bash
factorybridge service stop
cp -a /var/lib/factorybridge /backup/factorybridge-$(date +%Y%m%d)
factorybridge service start
```

网关运行时也可以复制，但必须同时复制 `gateway.db`、`gateway.db-wal` 和 `gateway.db-shm`，否则备份可能不一致。
停止服务后复制最简单可靠。

### 恢复

1. 停止服务。
2. 把备份的数据目录内容复制回数据目录，确保 `gateway.db` 与 `-wal`、`-shm` 来自同一次备份。
3. 启动服务。
4. 用 `factorybridge user list --data-dir <数据目录>` 确认用户存在。

每次上线前至少在测试环境完整做一次恢复，确认能启动、能登录、配置与备份时一致。

## 回滚

回滚需要两样东西：旧版本的可执行文件和升级前的数据目录备份。

1. `factorybridge service stop`
2. 把数据目录恢复为升级前的备份。
3. 替换为旧版本的 `factorybridge` 可执行文件和 `web/`。
4. `factorybridge service start`

数据库迁移只能追加，不能修改已发布的条目。旧版本能否打开新版本迁移过的数据库没有保证，因此回滚时以升级前的数据目录备份为准，
不要只换可执行文件。

## 日志与排错

### 退出码

退出码定义在 `cmd/factorybridge/cli.go`：

| 退出码 | 含义 |
| --- | --- |
| `0` | 正常退出，或命令成功 |
| `1` | 运行期错误，例如 HTTP 服务异常停止、状态库写入失败、服务管理器操作失败 |
| `2` | 命令或参数错误，例如未知命令、未知参数、开发模式参数不合法、非回环地址上的开发模式 |
| `3` | 配置或数据文件错误，例如 `config.json` 解析失败、状态库打开失败、TLS 证书加载失败、`TDENGINE_URL` 设置但缺少 `TDENGINE_PASSWORD` |

### 日志位置

- 前台运行（`factorybridge run`）：日志输出到标准输出，格式为 `slog` 文本。级别由 `--log-level` 或 `GATEWAY_GO_LOG_LEVEL` 控制。
- Linux 服务：标准输出由 systemd 收集，用 `journalctl -u factorybridge -f` 查看。
- Windows 服务：服务进程的标准输出不会写入文件。网关不写 Windows 事件日志或日志文件（代码中没有相应实现）。
  需要持久日志时，要在服务外层做重定向或由现场规范补充，这一点当前版本没有内置方案。
- 审计日志不在文本日志里。审计事件写入状态库的审计表，管理员可用 `GET /api/audit?limit=<条数>` 查看，最多 2000 条。
  审计日志保留 365 天（见 `internal/audit`）。

### 常见问题

- 启动后无法访问：检查 `--host` 与 `--port`。默认只监听回环地址，远程访问需要 `--host 0.0.0.0`。
  Windows 防火墙也要放行端口。
- 浏览器提示证书不受信任：使用了自签名证书，换成企业 CA 证书，见「对外监听与 HTTPS」。
- 请求返回 403 `client address not allowed`：客户端地址不在 `--allow-cidr` 中。
- 退出码 `3` 且日志提到 `TDENGINE_PASSWORD`：设置了 `TDENGINE_URL`，但没有设置密码。
- 服务无法启动，Windows 上 `service start` 超时：用 `factorybridge run --data-dir <数据目录>` 前台运行，直接看错误输出。
- 服务无法写数据库：检查数据目录的权限。Windows 上服务账号 `NT SERVICE\<名称>` 需要修改权限；Linux 上数据目录属主应为服务账号。

## 环境变量

完整列表见仓库根目录的 `.env.example`，包括 `GATEWAY_GO_*`、`TDENGINE_*` 和 `FB_DEV_PASSWORD`。
命令行参数的优先级高于环境变量，环境变量高于默认值。

## 开发模式

`--dev` 和 `--dev-no-auth` 只用于开发。它们只允许在回环地址上运行，并且不能作为服务运行。现场部署不要使用。

## 模拟器

联调与故障矩阵使用 ProtoForge（`D:\Projects\sim-foundry-main`，或镜像 `suoten/protoforge`），覆盖
Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、OPC UA、SNMP、BACnet、MQTT。ProtoForge 没有 IEC 60870-5-104，
该协议仍用 `tools/sim/iec104-sim.ts`。

故障矩阵：`node scripts/fault-matrix.mjs`，所需环境变量见脚本头注释。

## Docker Compose 演示栈

`docker-compose.yml`：Go 网关 + TDengine + ProtoForge 协议模拟器 + IEC104 模拟器。用法见文件头注释。
演示栈的端口只绑定 `127.0.0.1`，并使用 TDengine 的默认密码。生产环境不要使用该栈，见上文「TDengine」。
