# Factory Bridge 部署指南

> 自 2026-11-07（阶段 4）起，主用运行时为 Go 网关单一可执行文件 `factorybridge`。
> Node 网关（`apps/gateway`）已冻结，仅作历史参考；本目录下 `systemd/factory-bridge-gateway.service`
> 与 `windows/`（WinSW）是 Node 网关的服务文件，同样冻结，不再更新。

## 获取发布包

```bash
pnpm release                      # 构建 windows/amd64、linux/amd64、linux/arm64
pnpm release linux/amd64          # 只构建指定平台
```

产物在 `dist/release/<版本>/`，每个平台一个压缩包（可执行文件 + `web/` 控制台 + `README.md` + `INSTALL.txt`），
`SHA256SUMS` 覆盖压缩包和可执行文件。部署前用 `sha256sum -c SHA256SUMS` 校验。

## 首次部署

```bash
factorybridge user create --name admin --role admin --data-dir <数据目录>   # 系统没有默认账号
factorybridge run --data-dir <数据目录>                                     # 前台试运行，Ctrl+C 停止
```

- 默认只监听 `127.0.0.1:18080`，走 HTTP。
- 对外提供服务：`--host 0.0.0.0 --allow-cidr <管理网段>`。非回环地址强制 HTTPS；未指定
  `--tls-cert/--tls-key` 时在 `<数据目录>/tls/` 生成自签名证书（仅适合测试，生产请用企业 CA 签发的证书）。
- `web/` 与可执行文件放在同一目录时，网关同端口托管控制台；也可用 `--web-dir` 指定，或把 `web/` 放到
  Nginx/IIS 下并在 `GATEWAY_GO_CORS_ORIGINS` 中加入该站点。

## 注册为系统服务

```bash
# Windows：管理员命令行
factorybridge service install --data-dir D:\FactoryBridge\data -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
factorybridge service start
factorybridge service status            # 普通用户也可查询

# Linux：root
factorybridge service install --data-dir /var/lib/factorybridge -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
factorybridge service start
journalctl -u factorybridge -f
```

- Windows：虚拟账号 `NT SERVICE\<名称>`、延迟自动启动、异常退出后 10s/30s/60s 自动重启。
- Linux：生成 `/etc/systemd/system/<名称>.service`，专用系统账号，`ProtectSystem=strict`，仅数据目录可写。
- `--` 之后是传给 `run` 的参数，安装时固化；改参数需 `service uninstall` 后重新 `install`。
- 同机多实例：每个实例用不同的 `--name` 和 `--data-dir`。

## 升级

1. `factorybridge service stop`
2. 备份数据目录（`gateway.db`、`config.json`、`tls/`）
3. 替换可执行文件与 `web/`
4. `factorybridge service start`

从 Node 网关或早期 Go 版本升级时，旧 JSON/JSONL 状态文件在首次启动时自动导入 `gateway.db`，原文件改名为
`*.migrated`。也可先离线执行 `factorybridge migrate --data-dir <数据目录> --dry-run` 查看待导入内容。

## Docker Compose 演示栈

`docker-compose.yml`：Go 网关 + TDengine + ProtoForge 协议模拟器 + IEC104 模拟器。用法见文件头注释。

## 模拟器

联调与故障矩阵使用 ProtoForge（`D:\Projects\sim-foundry-main`，或镜像 `suoten/protoforge`），覆盖
Modbus TCP、S7、MELSEC、FINS、EtherNet/IP、OPC UA、SNMP、BACnet、MQTT。ProtoForge 没有 IEC 60870-5-104，
该协议仍用 `apps/gateway/scripts/iec104-sim.ts`。

故障矩阵：`node scripts/fault-matrix.mjs`，所需环境变量见脚本头注释。
