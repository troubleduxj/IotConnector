#!/usr/bin/env node
/**
 * 自带环境的 e2e（E4）：在容器里起网关 + IEC104 模拟器，装入固定测试配置、建测试账号，
 * 用 Playwright 官方镜像跑 e2e，结束后拆除。不依赖本机已运行的网关、控制台或 Edge。
 *
 * 用法（仓库根目录）：
 *   pnpm e2e:docker                 构建发布包 → 起栈 → 测试 → 拆栈
 *   pnpm e2e:docker --keep          测试后保留栈，便于排查（docker compose -p fbe2e down -v 清理）
 *   pnpm e2e:docker --skip-build    复用 dist/release 里最新的 linux/amd64 包
 *
 * 报告：.tmp/e2e-report/html（Playwright HTML 报告）、.tmp/e2e-report/results（失败时的截图与 trace）。
 * 退出码：0 全部通过；1 测试失败；2 环境准备失败。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const keep = args.has('--keep');
const compose = ['compose', '-p', 'fbe2e', '-f', path.join(root, 'e2e', 'docker-compose.e2e.yml')];
const user = 'e2e-admin';
// 每次随机生成，满足口令策略（大小写、数字、符号、长度）。
const password = `E2e-${randomBytes(9).toString('base64url')}-9a`;

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...options.env }, input: options.input });
  return result.status ?? 1;
}

function capture(cmd, cmdArgs, options = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input });
}

function latestLinuxPackage() {
  const releaseDir = path.join(root, 'dist', 'release');
  if (!existsSync(releaseDir)) return '';
  const candidates = [];
  for (const version of readdirSync(releaseDir)) {
    const dir = path.join(releaseDir, version);
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (entry.endsWith('-linux-amd64') && statSync(full).isDirectory()) candidates.push(full);
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!args.has('--skip-build')) {
    log('构建 linux/amd64 发布包');
    if (run(process.execPath, [path.join(root, 'scripts', 'release.mjs'), 'linux/amd64']) !== 0) return 2;
  }
  const pkg = latestLinuxPackage();
  if (!pkg) {
    log('没有找到 dist/release/*/…-linux-amd64，先去掉 --skip-build 构建');
    return 2;
  }
  // compose 的 build context 是仓库根目录，PKG 必须是相对仓库根的正斜杠路径。
  const env = { FB_PKG: path.relative(root, pkg).split(path.sep).join('/'), E2E_USER: user, E2E_PASSWORD: password };
  log(`使用发布包 ${env.FB_PKG}`);
  rmSync(path.join(root, '.tmp', 'e2e-report'), { recursive: true, force: true });
  mkdirSync(path.join(root, '.tmp', 'e2e-report'), { recursive: true });

  run('docker', [...compose, 'down', '-v', '--remove-orphans'], { env });
  try {
    log('构建镜像并启动网关');
    if (run('docker', [...compose, 'up', '-d', '--build', 'gateway'], { env }) !== 0) return 2;

    // 先停网关进程装入测试配置：网关在容器里以 nonroot 运行，配置文件经 docker cp 写入数据卷。
    log('装入测试配置并创建测试账号');
    if (run('docker', [...compose, 'stop', 'gateway'], { env }) !== 0) return 2;
    const container = capture('docker', [...compose, 'ps', '-a', '-q', 'gateway'], { env }).trim();
    if (run('docker', ['cp', path.join(root, 'e2e', 'fixtures', 'config.json'), `${container}:/data/config.json`]) !== 0) return 2;
    if (run('docker', [...compose, 'start', 'gateway'], { env }) !== 0) return 2;
    // 启动后容器需要一点时间进入 running；exec 在此之前会报 "service is not running"，重试几次。
    let created;
    for (let attempt = 1; attempt <= 15; attempt++) {
      await sleep(1000);
      created = spawnSync('docker', [...compose, 'exec', '-T', 'gateway', '/opt/factorybridge/factorybridge', 'user', 'create', '--name', user, '--role', 'admin', '--data-dir', '/data', '--password-stdin'], {
        cwd: root,
        env: { ...process.env, ...env, MSYS_NO_PATHCONV: '1' },
        input: `${password}
`,
        encoding: 'utf8',
      });
      if (created.status === 0) break;
    }
    if (created.status !== 0) {
      log(`创建测试账号失败：${created.stderr || created.stdout}`);
      run('docker', [...compose, 'logs', '--tail', '20', 'gateway'], { env });
      return 2;
    }

    log('启动 IEC104 模拟器，等待采集到数据');
    if (run('docker', [...compose, 'up', '-d', 'iec104-sim'], { env }) !== 0) return 2;
    // 历史查询用例需要 Bool 位号已有采样；IEC104 通道周期 3 秒，留出几个周期。
    await sleep(15000);

    log('运行 Playwright');
    const code = run('docker', [...compose, '--profile', 'test', 'run', '--rm', 'playwright'], { env: { ...env, MSYS_NO_PATHCONV: '1' } });
    log(code === 0 ? '全部通过' : `测试失败（退出码 ${code}），报告见 .tmp/e2e-report/html`);
    if (code !== 0) {
      run('docker', [...compose, 'logs', '--tail', '40', 'gateway', 'iec104-sim'], { env });
    }
    return code === 0 ? 0 : 1;
  } finally {
    if (keep) {
      log('按 --keep 保留测试栈；清理：docker compose -p fbe2e down -v');
    } else {
      run('docker', [...compose, '--profile', 'test', 'down', '-v', '--remove-orphans'], { env });
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(2);
  },
);
