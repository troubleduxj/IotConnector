#!/usr/bin/env node
/**
 * 本地门禁：与 .github/workflows/ci.yml 同口径，仓库无远端时替代 CI。
 *
 * 用法：
 *   node scripts/ci-local.mjs            全量
 *   node scripts/ci-local.mjs --quick    跳过控制台构建（pre-push 默认）
 *   node scripts/ci-local.mjs --race     Go 测试加 -race（需要 C 编译器，CGO_ENABLED=1）
 *
 * Windows 与 Linux 通用；任一步失败即退出码 1。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goDir = path.join(root, 'apps', 'gateway-go');
const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const race = args.has('--race');
const isWin = process.platform === 'win32';

const buildDir = mkdtempSync(path.join(tmpdir(), 'fb-ci-'));
const binary = path.join(buildDir, isWin ? 'factorybridge.exe' : 'factorybridge');

// 用户级 .npmrc 若设置了 script-shell=cmd.exe，非交互环境下 pnpm 只会打开一个空 cmd、脚本不执行。
// 这里在命令行清空该项，使用 pnpm 默认 shell，不改动用户的全局配置。
const pnpmArgs = (...a) => ['--config.script-shell=', ...a];

const steps = [
  { name: 'typecheck (pnpm -r)', cmd: 'pnpm', args: pnpmArgs('-r', 'typecheck'), cwd: root },
  { name: 'vitest', cmd: 'pnpm', args: pnpmArgs('test'), cwd: root },
  ...(quick ? [] : [{ name: 'console build', cmd: 'pnpm', args: pnpmArgs('--filter', '@iotconnector/console', 'build'), cwd: root }]),
  { name: 'go vet', cmd: 'go', args: ['vet', './...'], cwd: goDir },
  {
    name: race ? 'go test -race' : 'go test',
    cmd: 'go',
    args: ['test', ...(race ? ['-race'] : []), '-count=1', './...'],
    cwd: goDir,
    env: race ? { CGO_ENABLED: '1' } : {},
  },
  // 输出到临时目录，避免在工作区留下二进制
  { name: 'go build', cmd: 'go', args: ['build', '-o', binary, './cmd/factorybridge'], cwd: goDir },
];

const results = [];
let failed = false;
for (const step of steps) {
  const started = Date.now();
  console.log(`\n=== ${step.name} ===`);
  // Windows 下 pnpm 是 .cmd，需要经 shell 解析；参数都是脚本内常量，拼成一条命令即可。
  // stdin 必须关闭：pnpm 的 script-shell 若配置为 cmd.exe，继承 stdin 时在非交互环境会一直等待输入。
  const r = isWin
    ? spawnSync([step.cmd, ...step.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '), {
        cwd: step.cwd,
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: true,
        env: { ...process.env, ...(step.env ?? {}) },
      })
    : spawnSync(step.cmd, step.args, {
        cwd: step.cwd,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, ...(step.env ?? {}) },
      });
  const ok = r.status === 0;
  results.push({ name: step.name, ok, sec: ((Date.now() - started) / 1000).toFixed(1) });
  if (!ok) {
    failed = true;
    break;
  }
}

rmSync(buildDir, { recursive: true, force: true });

console.log('\n=== 本地门禁结果 ===');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.sec}s)`);
const skipped = steps.slice(results.length).map((s) => s.name);
if (skipped.length) console.log(`未执行：${skipped.join('、')}`);
if (!race) console.log('提示：未运行 -race（需要 C 编译器），完整并发检查请加 --race。');
process.exit(failed ? 1 : 0);
