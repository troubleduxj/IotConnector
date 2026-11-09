# 安全验收清单

现场调试完成、交付前使用。每一项按顺序核对，通过后打勾。命令在网关所在主机执行，
`<数据目录>` 替换为实际路径，`<主机>` 替换为网关的 IP 或域名。

判断标准：每项的“期望”都满足才算通过。有一项不满足，记录原因，修复后重新验收该项。

Windows 上的命令用 PowerShell 执行。Linux 上的命令用 bash 执行。

## 一、账号与认证

- [ ] 没有默认账号或弱口令账号
  - 验证：`factorybridge user list --data-dir <数据目录>`
  - 期望：列表中只有现场确认过的账号。没有 `dev` 账号（`dev` 只在开发模式下创建）。没有 `admin` 以外用户名的默认账号，除非现场有明确用途。

- [ ] 初始管理员口令已更换，且不是默认值
  - 验证：用初始口令在控制台登录，应失败。用当前口令登录，应成功。
  - 期望：旧口令登录返回错误。`user list` 中该账号的 STATE 为 `active`，不是 `pending`。

- [ ] 所有账号的口令满足策略（至少 12 个字符，含大小写字母、数字和特殊字符）
  - 验证：对每个账号执行 `factorybridge user passwd --name <用户名> --data-dir <数据目录>`，设置一个新口令，确认策略拒绝弱口令（例如 `abc`）。
  - 期望：弱口令被拒绝并提示 `password must be at least 12 characters` 或相应的字符类型提示。
  - 注意：`passwd` 会使该用户的现有会话失效，并要求下次登录时修改口令。只在维护窗口执行。

- [ ] 账号角色按最小权限分配
  - 验证：`factorybridge user list --data-dir <数据目录>`，逐个核对角色。
  - 期望：
    - 只看数据的人员为 `viewer`。
    - 现场操作员（确认告警、运行脚本、写位号）为 `operator`。
    - 工程师（修改通道、位号、告警、脚本、配方、北向）为 `engineer`。
    - `admin` 只分配给需要管理用户、审计和备份恢复的人员，人数不超过现场运维负责人。
  - 角色依据：`internal/auth/users.go`。`admin` 的权限包括用户与会话管理、审计、配置备份与恢复、恢复出厂。

- [ ] 至少有一个启用的管理员，且管理员数量符合要求
  - 验证：`factorybridge user list --data-dir <数据目录>`，统计角色为 `admin` 且 STATE 不为 `disabled` 的账号。
  - 期望：数量至少为 1，且与现场确认的管理员名单一致。网关会拒绝删除或降级最后一个启用的管理员。

- [ ] 连续失败的登录会锁定账号，锁定的账号能按需解锁
  - 验证：用错误口令连续登录同一账号。然后执行 `factorybridge user unlock --name <用户名> --data-dir <数据目录>`。
  - 期望：达到失败次数后登录返回锁定错误（`account temporarily locked`）。解锁后可以用正确口令登录。
  - 依据：`internal/auth/users.go` 中 `MaxFailures` 默认值为 5。

- [ ] 离职或不再使用的账号已禁用或删除
  - 验证：`factorybridge user list --data-dir <数据目录>`。
  - 期望：这些账号的 STATE 为 `disabled`，或已被 `factorybridge user delete` 删除。

- [ ] 会话列表中没有不明来源的活动会话
  - 验证：管理员登录后调用 `GET /api/auth/sessions`。
  - 期望：只有现场人员的会话。异常会话通过 `DELETE /api/auth/sessions/{sessionID}` 撤销。

## 二、网络与传输

- [ ] 对外监听时使用 HTTPS
  - 验证：`curl -vk https://<主机>:18080/api/health`，然后 `curl -v http://<主机>:18080/api/health`。
  - 期望：HTTPS 请求返回 `200`。HTTP 请求返回 `400`，正文为 `Client sent an HTTP request to an HTTPS server.`（已实测）。
  - 说明：`--host` 设为非回环地址时，网关强制 HTTPS。端口 `18080` 是默认值，如果改过端口，请替换。

- [ ] 生产环境使用企业 CA 签发的站点证书，不使用自签名证书
  - 验证：启动参数中是否有 `--tls-cert` 与 `--tls-key`（`sc qc factorybridge` 或 `systemctl cat factorybridge` 查看）。然后执行
    `openssl x509 -in <证书文件> -noout -subject -issuer -enddate`。
  - 期望：启动参数包含 `--tls-cert` 与 `--tls-key`。`issuer` 不是 `FactoryBridge gateway (self-signed)`。证书的 `enddate` 晚于当前日期，并留有足够余量。
  - 说明：如果没有 `--tls-cert`，网关使用 `<数据目录>/tls/selfsigned.crt`。该证书仅适用于测试。

- [ ] 自签名证书的私钥只有服务账号可读
  - 验证：Linux 执行 `ls -l <数据目录>/tls/`。Windows 执行 `icacls <数据目录>\tls`。
  - 期望：Linux 上 `selfsigned.key` 权限为 `600`，属主为服务账号。Windows 上只有管理员和服务账号 `NT SERVICE\<服务名>` 有访问权限。
  - 说明：仅在使用自签名证书时需要检查。使用企业证书时，把私钥文件也按同样方式限制。

- [ ] 监听地址与端口符合现场规划
  - 验证：`ss -ltnp | grep 18080`（Linux），或 `Get-NetTCPConnection -LocalPort 18080 -State Listen`（Windows）。
  - 期望：只监听规划的地址。如果只有本机使用，监听地址为 `127.0.0.1`。

- [ ] 已设置访问白名单 `--allow-cidr`，且只包含管理网段
  - 验证：查看服务启动参数（`sc qc factorybridge` 或 `systemctl cat factorybridge`）。从白名单之外的主机执行 `curl -k https://<主机>:18080/api/health`。
  - 期望：启动参数包含 `--allow-cidr`，且网段与现场管理网段一致。白名单外的主机收到 `403`，错误信息为 `client address not allowed`。
  - 说明：回环地址始终允许，本机的 `user` 命令不受影响。

- [ ] 启动日志中没有“未设置 --allow-cidr”的警告
  - 验证：查看启动日志（Linux 用 `journalctl -u factorybridge`，Windows 前台运行 `factorybridge run` 时看标准输出）。
  - 期望：没有 `listening on a non-loopback address without --allow-cidr` 警告。

- [ ] CORS 来源只包含实际使用的控制台站点
  - 验证：查看 `GATEWAY_GO_CORS_ORIGINS` 的值（环境变量设置位置见下文“三、运行配置”）。
  - 期望：未设置，或只包含现场确实使用的控制台站点地址。不包含 `*`。

## 三、运行配置

- [ ] 开发模式未开启
  - 验证：查看服务启动参数。执行 `factorybridge run --help` 不能判断实际运行状态，所以检查启动参数和环境变量：`GATEWAY_GO_DEV`。
  - 期望：启动参数中没有 `--dev` 或 `--dev-no-auth`，`GATEWAY_GO_DEV` 未设置或为 `false`。
  - 说明：`--dev` 和 `--dev-no-auth` 只允许在回环地址运行，而且服务安装时就会被拒绝（`service install` 会报错）。这一项只需确认现场没有绕过的方式，例如前台运行的开发实例占用了同一端口。

- [ ] 静态 API 令牌未设置，除非现场有明确的集成需要
  - 验证：
    - Windows：`[Environment]::GetEnvironmentVariables('Machine').Keys | Where-Object { $_ -like 'GATEWAY_GO_*_TOKEN' -or $_ -eq 'GATEWAY_GO_API_TOKEN' }`，并检查用户级环境变量。
    - Linux：`systemctl show factorybridge -p Environment`，并检查 `/etc/systemd/system/factorybridge.service.d/` 下的覆盖文件。
  - 期望：`GATEWAY_GO_API_TOKEN`、`GATEWAY_GO_VIEWER_TOKEN`、`GATEWAY_GO_OPERATOR_TOKEN`、`GATEWAY_GO_ADMIN_TOKEN` 均未设置。
  - 说明：静态令牌不会过期，且绕过用户账号和会话。`GATEWAY_GO_API_TOKEN` 的权限是 `operator`。如果确需设置，令牌长度足够长，只授予需要的最低角色，并记录用途和持有人。

- [ ] 脚本内联执行开关未开启
  - 验证：同上，检查服务环境中的 `GATEWAY_GO_SCRIPT_INLINE`。
  - 期望：未设置。只有值为 `1` 时脚本才在网关进程内执行，绕过子进程隔离。

- [ ] 会话有效期符合现场要求
  - 验证：检查 `GATEWAY_GO_SESSION_TTL` 的值。
  - 期望：未设置（默认 8 小时，见 `internal/auth/users.go`）或设置为现场确认的时长。

## 四、数据库与口令

- [ ] 设置了 TDengine 时，TDengine root 密码已修改，且 `TDENGINE_PASSWORD` 已设置
  - 验证：检查服务环境中的 `TDENGINE_URL` 与 `TDENGINE_PASSWORD` 是否都设置。用旧的默认密码 `taosdata` 尝试连接 TDengine REST 接口（`curl -u root:taosdata http://<TDengine 地址>:6041/rest/sql -d "show databases"`），应失败。
  - 期望：
    - 若设置了 `TDENGINE_URL`，则 `TDENGINE_PASSWORD` 也已设置。只设置 URL 时网关以退出码 `3` 退出。
    - 旧默认密码无法登录 TDengine。
  - 说明：`docker-compose.yml` 的默认值 `${TDENGINE_PASSWORD:-taosdata}` 只适用于演示栈。

- [ ] 未设置 `TDENGINE_URL` 时，网关不尝试连接 TDengine
  - 验证：检查服务环境中的 `TDENGINE_URL`。
  - 期望：未设置，或为现场确认的 TDengine 地址。

- [ ] 北向 MQTT 密码在 GET 响应中不可见
  - 验证：管理员登录后调用 `GET /api/northbound`，查看返回的 `config` 字段。
  - 期望：`password` 为空字符串，并附带 `passwordSet: true`（如已设置）。

- [ ] 通知通道的密钥在 GET 响应中不可见
  - 验证：调用 `GET /api/notifications`，检查邮件密码、钉钉密钥、企微或钉钉 webhook 地址。
  - 期望：这些字段为空字符串，并带有对应的 `...Set` 布尔标记。Webhook 地址（含 access_token）同样不返回。

- [ ] 完整配置在 GET 响应中不泄露密钥
  - 验证：调用 `GET /api/config`，搜索 `password`、`secret`、`token`、`apiKey`。`GET /api/channels` 返回的是运行状态，不是配置。
  - 期望：这些键的值为空，并带有 `...Set` 标记，或不出现。

- [ ] 配置备份文件的保管符合要求
  - 验证：`GET /api/system/config-backup` 下载的文件，以及 `<数据目录>/config.json`，检查是否含口令。
  - 期望：配置备份接口不做脱敏，文件中可能含明文口令（北向、通知等）。文件存放位置的权限只开放给运维人员，不随意发送。
  - 说明：`config.json` 同样可能含明文口令。这一项是确认现场知道这个事实并已控制访问，而不是要求文件不含口令。

- [ ] 数据目录权限符合要求
  - 验证：
    - Linux：`ls -ld <数据目录>` 与 `ls -l <数据目录>`。
    - Windows：`icacls <数据目录>`。
  - 期望：Linux 上数据目录属主为服务账号 `factorybridge`，目录权限 `750`，`gateway.db` 与审计文件权限 `640`。Windows 上只有管理员、服务账号 `NT SERVICE\<服务名>` 和运维人员有权限，普通用户没有读取权限。

## 五、脚本沙箱

- [ ] 用户脚本在独立子进程中执行
  - 验证：运行一个脚本（需要 operator 权限，调用 `POST /api/scripts/{scriptID}/run`），同时观察进程列表，查找 `factorybridge` 子进程。
  - 期望：脚本运行期间出现独立子进程，子进程的环境变量 `GATEWAY_GO_SCRIPT_WORKER=1`。依据：`internal/api/scripts.go` 中的 `runIsolated`。

- [ ] 子进程只继承白名单内的环境变量
  - 验证：查看 `internal/api/scripts.go` 中的 `scriptWorkerAllowedEnv`。在服务环境中设置一个无关的变量（例如 `TDENGINE_PASSWORD`），运行脚本，确认脚本无法读取它（可通过脚本输出验证）。
  - 期望：子进程只有 `PATH`、`SYSTEMROOT`、`WINDIR`、`TEMP`、`TMP`、`HOME`、`USERPROFILE`、`LANG`、`LC_ALL`、`TZ` 与 `GATEWAY_GO_SCRIPT_WORKER`。数据库密码、管理员令牌不会被传入。

- [ ] 脚本执行超时为 1 秒
  - 验证：提交一个死循环脚本，运行后观察返回。
  - 期望：约 1 秒后返回失败，错误信息包含 `script timeout`。依据：`internal/scriptworker/worker.go` 中的 `time.AfterFunc(time.Second, ...)`。

- [ ] 脚本内存限制：软限制 64 MB，硬限制 128 MB
  - 验证：提交一个分配大量内存的脚本（例如循环拼接长字符串）。
  - 期望：超过 64 MB 时脚本被中断。超过 128 MB 时子进程直接退出。依据：`internal/scriptworker/worker.go` 中的 `maxHeapBytes` 与 `hardHeapBytes`。

- [ ] 脚本失败时，本次写入被丢弃
  - 验证：提交一个先写位号、再抛出异常的脚本，运行后检查目标位号的值。
  - 期望：位号值不变。依据：`internal/api/scripts.go` 中 `!response.OK` 时 `response.Writes = nil`，失败的脚本不会部分写入 PLC。

- [ ] 脚本代码大小限制为 64 KB
  - 验证：提交超过 64 KB 的脚本。
  - 期望：返回 `413`，错误信息 `script code exceeds 64 KiB`。

- [ ] 连续失败的脚本会被自动禁用
  - 验证：让一个脚本连续失败，观察其状态。
  - 期望：连续失败 3 次后脚本被自动禁用（配置中 `enabled` 变为 `false`，控制台显示为停用）。重新启用时清零失败计数。

## 六、审计与可追溯性

- [ ] 审计日志存在且有记录
  - 验证：管理员调用 `GET /api/audit?limit=50`。然后做一次无害的操作（例如修改一个用户的角色后再改回），再次查询。
  - 期望：返回 `events` 列表，包含登录、用户变更、配置变更等事件，且新操作出现在列表前部。
  - 说明：审计事件写入状态库的审计表，保留 365 天。`limit` 最大 2000。

- [ ] 只有管理员能查看审计日志
  - 验证：分别用 `viewer`、`operator`、`engineer` 账号调用 `GET /api/audit`。
  - 期望：返回 `403`，错误信息 `insufficient role`。

- [ ] 审计文件（如有）权限不宽松
  - 验证：`ls -l <数据目录>/audit.jsonl`（如果存在）。
  - 期望：权限 `640`。该文件只在旧版本迁移后可能存在，迁移完成后会改名为 `.migrated`。

## 七、备份与恢复

- [ ] 备份方案已确定，并包含 `gateway.db`、`gateway.db-wal`、`gateway.db-shm`、`config.json` 与 `tls/`
  - 验证：查看现场备份任务的配置。
  - 期望：备份任务覆盖整个数据目录，或至少包含上述文件。只复制 `gateway.db` 而缺少 `-wal` 文件不符合要求。

- [ ] 备份已在测试环境完整恢复过一次
  - 验证：在另一台主机或测试目录，把备份复制回数据目录，启动网关，登录，检查通道、位号和用户列表。
  - 期望：网关启动成功，`factorybridge user list` 显示的账号与备份时一致，通道和位号数量一致。

- [ ] 备份文件存放在有访问控制的位置
  - 验证：检查备份目录的权限。
  - 期望：只有运维人员可以读取。备份中含口令材料。

## 八、服务运行账号

- [ ] 服务不以 LocalSystem 或 root 运行
  - 验证：
    - Windows：`sc qc <服务名>`，查看 `SERVICE_START_NAME`。
    - Linux：`systemctl show <服务名> -p User`。
  - 期望：Windows 上为 `NT SERVICE\<服务名>`。Linux 上为 `factorybridge`（或 `--user` 指定的系统账号），不是 `root`。
  - 依据：Windows 安装时使用虚拟账号；Linux 安装时创建专用系统账号，单元文件中有 `NoNewPrivileges=true` 与 `ProtectSystem=strict`。

- [ ] 服务账号没有多余的管理员权限
  - 验证：
    - Windows：`whoami /groups` 无法直接对服务账号执行，改用 `sc qprivs <服务名>` 查看特权。检查 `NT SERVICE\<服务名>` 不在 `Administrators` 组中（`net localgroup Administrators`）。
    - Linux：`id factorybridge`，确认不在 `sudo`、`wheel`、`root` 组中。
  - 期望：服务账号不在管理员组，也不在 sudo 组。

- [ ] 服务只能写入数据目录
  - 验证：Linux 上 `systemctl cat factorybridge` 查看 `ReadWritePaths`。Windows 上 `icacls` 检查可执行文件所在目录，服务账号对可执行文件目录只有读取和执行权限。
  - 期望：Linux 上 `ReadWritePaths` 只包含数据目录。Windows 上服务账号对安装目录没有写入权限。
  - 说明：Windows 安装时只为服务账号授予数据目录的修改权限。

- [ ] 服务已设置为异常退出后自动重启
  - 验证：Windows 上 `sc qfailure <服务名>`。Linux 上 `systemctl show <服务名> -p Restart`。
  - 期望：Windows 上异常退出后 10 秒、30 秒、60 秒重启。Linux 上为 `on-failure`。

## 九、可执行文件与发布包

- [ ] 可执行文件与发布包哈希与 `SHA256SUMS` 一致
  - 验证：Linux 执行 `sha256sum -c SHA256SUMS`。Windows 执行 `Get-FileHash -Algorithm SHA256 .\factorybridge.exe`，与 `SHA256SUMS` 中的值比对。
  - 期望：校验全部通过。

- [ ] 版本号符合预期
  - 验证：`factorybridge version`。
  - 期望：输出的版本号与发布说明一致，不带 `-dirty` 后缀。带 `-dirty` 的包是从未提交的工作区构建的，不应上线。

---

## 验收记录

| 项目 | 结果 | 验收人 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| | | | | |
