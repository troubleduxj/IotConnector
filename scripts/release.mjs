#!/usr/bin/env node
/**
 * 发布包构建（H6）：交叉编译网关并打包控制台，产出可直接部署的压缩包。
 *
 * 用法：
 *   node scripts/release.mjs                 构建全部目标
 *   node scripts/release.mjs windows/amd64   只构建指定目标（可多个）
 *   node scripts/release.mjs --skip-console  复用已有 apps/console/dist
 *
 * 产物在 dist/release/<版本>/：
 *   factorybridge-<版本>-<os>-<arch>.zip|tar.gz  内含可执行文件、web/、README、config 样例
 *   SHA256SUMS                                     各压缩包与可执行文件的 sha256
 *
 * 版本号取自 git describe；工作区有未提交改动时追加 -dirty，避免误发未提交代码。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goDir = path.join(root, 'apps', 'gateway-go');
const consoleDist = path.join(root, 'apps', 'console', 'dist');
const isWin = process.platform === 'win32';

const ALL_TARGETS = ['windows/amd64', 'linux/amd64', 'linux/arm64'];
const args = process.argv.slice(2);
const skipConsole = args.includes('--skip-console');
const targets = args.filter((a) => !a.startsWith('--'));
for (const t of targets) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`unknown target ${t}; supported: ${ALL_TARGETS.join(', ')}`);
    process.exit(2);
  }
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(isWin && cmd === 'pnpm' ? [cmd, ...cmdArgs].join(' ') : cmd, isWin && cmd === 'pnpm' ? [] : cmdArgs, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    shell: isWin && cmd === 'pnpm',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`\n${cmd} ${cmdArgs.join(' ')} failed (exit ${r.status})`);
    process.exit(1);
  }
  return (r.stdout ?? '').trim();
}

// 只认 vX.Y.Z 形式的发布 tag；仓库里的 v0.2.0-phase1-core 是历史里程碑，不当作版本号
const describe = run('git', ['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', '*-*', '--always', '--dirty'], { capture: true });
const commit = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true });
const baseVersion = readFileSync(path.join(goDir, 'internal', 'version', 'version.go'), 'utf8').match(/Version\s+=\s+"([^"]+)"/)[1];
// 有 tag 时用 tag，否则用代码中的版本号加提交号
const version = /^v\d+\.\d+\.\d+/.test(describe) ? describe.replace(/^v/, '') : `${baseVersion}+${describe}`;
const buildTime = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const outRoot = path.join(root, 'dist', 'release', version);

console.log(`version ${version} (commit ${commit})`);
if (version.includes('dirty')) console.warn('warning: working tree has uncommitted changes; package is marked -dirty');

if (!skipConsole) {
  console.log('\n=== console build ===');
  run('pnpm', ['--config.script-shell=', '--filter', '@iotconnector/console', 'build']);
}
if (!existsSync(path.join(consoleDist, 'index.html'))) {
  console.error('apps/console/dist/index.html not found; run without --skip-console');
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });
const sums = [];
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

for (const target of targets.length ? targets : ALL_TARGETS) {
  const [goos, goarch] = target.split('/');
  const name = `factorybridge-${version}-${goos}-${goarch}`;
  const stage = path.join(outRoot, name);
  const exe = goos === 'windows' ? 'factorybridge.exe' : 'factorybridge';
  console.log(`\n=== ${target} ===`);
  mkdirSync(stage, { recursive: true });
  const pkg = 'github.com/factorybridge/iotconnector/gateway-go/internal/version';
  run('go', ['build', '-trimpath', '-ldflags', `-s -w -X ${pkg}.Version=${version} -X ${pkg}.Commit=${commit} -X ${pkg}.BuildTime=${buildTime}`,
    '-o', path.join(stage, exe), './cmd/factorybridge'], { cwd: goDir, env: { GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' } });
  cpSync(consoleDist, path.join(stage, 'web'), { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
  cpSync(path.join(goDir, 'README.md'), path.join(stage, 'README.md'));
  writeFileSync(path.join(stage, 'INSTALL.txt'), installNotes(goos, exe, version), 'utf8');
  sums.push(`${sha256(path.join(stage, exe))}  ${name}/${exe}`);

  const archive = goos === 'windows' ? `${name}.zip` : `${name}.tar.gz`;
  if (goos === 'windows') {
    // 用 Windows 自带的 bsdtar 写 zip。Git Bash/MSYS 的 PATH 上排在前面的 tar 是 GNU tar：
    // 它不认 -a、会写出扩展名为 .zip 的普通 tar 包，Windows 资源管理器打不开。
    const bsdtar = isWin ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
    run(bsdtar, ['-a', '-c', '--options', 'zip:compression=deflate', '-f', archive, name], { cwd: outRoot });
  } else {
    run('tar', ['-czf', archive, name], { cwd: outRoot });
  }
  sums.push(`${sha256(path.join(outRoot, archive))}  ${archive}`);
  const size = (statSync(path.join(outRoot, archive)).size / 1024 / 1024).toFixed(1);
  console.log(`${archive}  ${size} MiB`);
}

writeFileSync(path.join(outRoot, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(`\noutput: ${path.relative(root, outRoot)}`);
for (const entry of readdirSync(outRoot)) console.log(`  ${entry}`);

function installNotes(goos, exe, ver) {
  const bin = goos === 'windows' ? `.\\${exe}` : `./${exe}`;
  const dataDir = goos === 'windows' ? 'D:\\FactoryBridge\\data' : '/var/lib/factorybridge';
  return `FactoryBridge ${ver}

1. 解压到安装目录（web/ 必须与可执行文件放在同一目录）。
2. 创建首个管理员（系统没有默认账号）：
     ${bin} user create --name admin --role admin --data-dir ${dataDir}
3. 前台试运行（Ctrl+C 停止）：
     ${bin} run --data-dir ${dataDir}
   浏览器打开 http://127.0.0.1:18080/ 。
   对外提供服务时加 --host 0.0.0.0 --allow-cidr <管理网段>；非回环地址强制 HTTPS，
   未指定 --tls-cert/--tls-key 时自动生成自签名证书。
4. 注册为${goos === 'windows' ? ' Windows 服务（管理员命令行）' : ' systemd 服务（root）'}：
     ${bin} service install --data-dir ${dataDir} -- --host 0.0.0.0 --allow-cidr 10.0.0.0/8
     ${bin} service start
5. 从旧版本升级：先停服务，替换可执行文件与 web/，再启动；旧 JSON 状态文件会在首次启动时自动导入。

完整说明见 README.md。校验：SHA256SUMS。
`;
}
