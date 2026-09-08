/**
 * Factory Bridge 网关 Windows 服务入口（node-windows 包装）。
 * 通过 tsx ESM loader 以服务进程方式拉起 src/index.ts（ESM）。
 */
const { register } = require('tsx/esm/api');
register();
// 服务上下文：工作目录由 node-windows options 设置为 apps/gateway
import('../src/index.ts').catch((e) => {
  console.error('[service] gateway 启动失败:', e);
  process.exit(1);
});
