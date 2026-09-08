/**
 * 注册/卸载 Factory Bridge 网关 Windows 服务（node-windows）。
 * 用法（管理员 PowerShell/CMD）：
 *   node scripts/windows/install-gateway-service.cjs install
 *   node scripts/windows/install-gateway-service.cjs uninstall
 * 前置：仓库根已 pnpm install（tsx 为运行时加载器）。
 */
const path = require('node:path');
const Service = require('node-windows').Service;

const GW_DIR = path.resolve(__dirname, '..', '..');
const action = process.argv[2] ?? 'install';

const svc = new Service({
  name: 'FactoryBridgeGateway',
  displayName: 'Factory Bridge Gateway',
  description: 'Factory Bridge IIoT Edge Gateway (REST + WebSocket :8080)',
  script: path.join(GW_DIR, 'scripts', 'service-entry.cjs'),
  scriptOptions: [],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'GATEWAY_PORT', value: process.env.GATEWAY_PORT ?? '8080' },
    { name: 'TDENGINE_URL', value: process.env.TDENGINE_URL ?? 'http://127.0.0.1:16041' },
    { name: 'TDENGINE_DB', value: process.env.TDENGINE_DB ?? 'factory_bridge' },
  ],
  workingDirectory: GW_DIR, // data/ 按 cwd 解析，必须指向 apps/gateway
  maxRetries: 10,
  maxRestarts: 10,
  restartDelay: 5000,
  wait: 2,
  grow: 0.5,
});

svc.on('install', () => {
  console.log('[service] 已注册，正在启动…');
  svc.start();
});
svc.on('alreadyinstalled', () => console.log('[service] 服务已存在（先 uninstall 再 install）'));
svc.on('start', () => {
  console.log('[service] FactoryBridgeGateway 已启动（net stop FactoryBridgeGateway 可停止）');
  process.exit(0);
});
svc.on('error', (e) => {
  console.error('[service] 错误:', e);
  process.exit(1);
});
svc.on('remove', () => console.log('[service] 服务已卸载（数据目录 data/ 保留）'));

if (action === 'uninstall') svc.uninstall();
else svc.install();
