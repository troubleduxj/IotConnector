#!/usr/bin/env node
/**
 * 故障矩阵（阶段 4 起改用 ProtoForge 作为模拟器）。
 *
 * 对每个协议：确认通道在线 → 让模拟器停止服务 → 等网关报 offline/error → 恢复模拟器 →
 * 等网关回到 online 且有实时数据。结果写入 OUTPUT_FILE（默认 docs/artifacts/fault-matrix-latest.json）。
 *
 * 模拟器控制：
 *   - ProtoForge（D:\Projects\sim-foundry-main）：POST /api/v1/protocols/{name}/stop|start，
 *     start 时按网关通道配置的端口启动，所以 ProtoForge 不需要事先配好端口。
 *   - IEC 60870-5-104：ProtoForge 没有该协议，仍用 apps/gateway/scripts/iec104-sim.ts（按 PID 停止、重新拉起）。
 *
 * 环境变量（凭据不再写死在脚本里）：
 *   GATEWAY_URL        默认 http://127.0.0.1:18080
 *   GATEWAY_USER       默认 admin
 *   GATEWAY_PASSWORD   必填
 *   PROTOFORGE_URL     默认 http://127.0.0.1:8000
 *   PROTOFORGE_USER    默认 admin
 *   PROTOFORGE_PASSWORD 必填（ProtoForge 首次启动时打印，或用 PROTOFORGE_ADMIN_PASSWORD 指定）
 *   PROTOCOLS          逗号分隔的网关协议名，默认全部 ProtoForge 支持的协议
 *   TIMEOUT_MS / HOLD_MS
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18080';
const protoforge = process.env.PROTOFORGE_URL ?? 'http://127.0.0.1:8000';
const output = process.env.OUTPUT_FILE ?? resolve(root, 'docs/artifacts/fault-matrix-latest.json');
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 30000);
const holdMs = Number(process.env.HOLD_MS ?? 2000);

// 网关协议名 → ProtoForge 协议标识
const PROTOFORGE_NAMES = {
  'Modbus TCP': 'modbus_tcp',
  'Siemens Profinet': 's7',
  'Mitsubishi MELSEC': 'mc',
  'Omron FINS': 'fins',
  'EtherNet/IP (Rockwell)': 'ab',
  'OPC UA': 'opcua',
  SNMP: 'snmp',
  'BACnet/IP': 'bacnet',
  'MQTT / Sparkplug B': 'mqtt',
};
const LOCAL_SIMULATORS = { 'IEC 60870-5-104': { script: 'apps/gateway/scripts/iec104-sim.ts', portEnv: 'IEC104_SIM_PORT' } };

const protocols = (process.env.PROTOCOLS ?? Object.keys(PROTOFORGE_NAMES).join(','))
  .split(',').map((value) => value.trim()).filter(Boolean);

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

async function http(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${base}${path}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const gwAuth = await http(gateway, '/api/auth/login', json({ username: process.env.GATEWAY_USER ?? 'admin', password: required('GATEWAY_PASSWORD') }));
const gwHeaders = { authorization: `Bearer ${gwAuth.token}` };
let pfHeaders = null;
if (protocols.some((p) => PROTOFORGE_NAMES[p])) {
  const pfAuth = await http(protoforge, '/api/v1/auth/login', json({ username: process.env.PROTOFORGE_USER ?? 'admin', password: required('PROTOFORGE_PASSWORD') }));
  pfHeaders = { authorization: `Bearer ${pfAuth.access_token}`, 'content-type': 'application/json' };
}

const channels = () => http(gateway, '/api/channels', { headers: gwHeaders });
async function liveCount(channelId, tagIds) {
  const values = await http(gateway, '/api/tags/live', { headers: gwHeaders });
  return (Array.isArray(values) ? values : values?.values ?? []).filter((v) => tagIds.has(v.id)).length;
}
async function state(id) {
  const row = (await channels()).find((item) => item.id === id);
  return row?.state ?? 'unknown';
}
async function waitFor(predicate, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---- 模拟器控制 ----
async function simStop(protocol) {
  const name = PROTOFORGE_NAMES[protocol];
  if (name) {
    await http(protoforge, `/api/v1/protocols/${name}/stop`, { method: 'POST', headers: pfHeaders });
    // ProtoForge 的部分协议 stop 后监听端口不释放（已知：fins 只取消任务、不关 TCP server），
    // 网关仍能连上，故障注入就是无效的。这里提前判定，避免把模拟器问题报成网关问题。
    const port = simPorts.get(protocol);
    if (await waitFor(async () => !listenerPid(port), 5000) === false) {
      throw new Error(`ProtoForge ${name} stop did not release port ${port}; simulator bug, fault not injected`);
    }
    return;
  }
  const pid = listenerPid(simPorts.get(protocol));
  if (!pid) throw new Error(`no listener for ${protocol}`);
  execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
}
async function simStart(protocol, port) {
  const name = PROTOFORGE_NAMES[protocol];
  if (name) {
    const result = await http(protoforge, `/api/v1/protocols/${name}/start`, { method: 'POST', headers: pfHeaders, body: JSON.stringify({ host: '127.0.0.1', port }) });
    if (result.port_changed) throw new Error(`ProtoForge started ${name} on ${result.actual_port} instead of ${port} (port busy)`);
    return;
  }
  const local = LOCAL_SIMULATORS[protocol];
  if (!local) throw new Error(`no simulator for ${protocol}`);
  const tsx = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd');
  const child = spawn(tsx, [local.script], { cwd: root, env: { ...process.env, [local.portEnv]: String(port) }, detached: true, stdio: 'ignore', windowsHide: true, shell: true });
  child.unref();
}
const simPorts = new Map();
function listenerPid(port) {
  const text = execFileSync('cmd.exe', ['/d', '/c', 'netstat -ano'], { encoding: 'utf8' });
  const match = text.match(new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'm'));
  return Number(match?.[1] ?? 0);
}

// ---- 主流程 ----
const report = { generatedAt: new Date().toISOString(), gateway, protoforge, scenarios: [], pass: true };
const config = await http(gateway, '/api/config', { headers: gwHeaders });
for (const protocol of protocols) {
  const channel = config.channels.find((item) => item.protocol === protocol);
  const scenario = { protocol, simulator: PROTOFORGE_NAMES[protocol] ? `protoforge:${PROTOFORGE_NAMES[protocol]}` : 'local', channelId: channel?.id, port: channel?.port, before: null, offline: null, recovered: null, liveBefore: 0, liveAfter: 0, pass: false, error: null };
  try {
    if (!channel) throw new Error(`channel not found: ${protocol}`);
    simPorts.set(protocol, channel.port);
    const tagIds = new Set(config.tags.filter((t) => t.channelId === channel.id).map((t) => t.id));
    scenario.before = await state(channel.id);
    if (scenario.before !== 'online') throw new Error(`channel not online before test (${scenario.before}); start the simulator on port ${channel.port} first`);
    scenario.liveBefore = await liveCount(channel.id, tagIds);
    const started = Date.now();
    await simStop(protocol);
    const offlineObserved = await waitFor(async () => ['offline', 'error'].includes(await state(channel.id)));
    scenario.offline = await state(channel.id);
    scenario.offlineMs = Date.now() - started;
    await new Promise((r) => setTimeout(r, holdMs));
    const restartAt = Date.now();
    await simStart(protocol, channel.port);
    const recoveredObserved = await waitFor(async () => (await state(channel.id)) === 'online');
    scenario.recovered = await state(channel.id);
    scenario.recoveryMs = Date.now() - restartAt;
    await waitFor(async () => (await liveCount(channel.id, tagIds)) > 0, 10000);
    scenario.liveAfter = await liveCount(channel.id, tagIds);
    scenario.pass = offlineObserved && recoveredObserved && scenario.liveAfter > 0;
    if (!scenario.pass) throw new Error(`offline=${offlineObserved} recovered=${recoveredObserved} liveAfter=${scenario.liveAfter}`);
  } catch (error) {
    scenario.error = String(error?.message ?? error);
  }
  if (!scenario.pass) report.pass = false;
  report.scenarios.push(scenario);
  console.log(`${scenario.pass ? 'PASS' : 'FAIL'}  ${protocol}${scenario.error ? `  ${scenario.error}` : `  offline ${scenario.offlineMs}ms, recovered ${scenario.recoveryMs}ms`}`);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.exitCode = report.pass ? 0 : 1;
