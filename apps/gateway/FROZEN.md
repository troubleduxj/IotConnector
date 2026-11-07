# Node 网关已冻结（2026-11-07）

主用运行时已切换为 Go 网关（`apps/gateway-go`，可执行文件 `factorybridge`）。本目录不再接受功能改动与缺陷修复，
仅保留作历史参考。

- 冻结点：git tag `node-final`
- 已知未修复的问题见 `docs/REVIEW_TASKS.md` 的 D 组（WebSocket 无鉴权写值、脚本沙箱可执行任意代码等），
  **不要在生产网段启动本网关**。
- 仍在使用的部分：`scripts/iec104-sim.ts`（ProtoForge 没有 IEC104 模拟器）及其依赖的 `src/engine/drivers/iec104-codec.ts`。
- 回滚方式：回退到上一个 Go 版本（`scripts/rollback-go-local.ps1`），不再回滚到 Node。

删除本目录的前提（D0-5）：Go 补齐用户管理之外剩余的 Node 独有功能（通道导入导出、配置备份恢复、恢复出厂），
并把 IEC104 模拟器迁出。
