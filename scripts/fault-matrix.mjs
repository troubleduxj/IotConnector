import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gateway = process.env.GATEWAY_URL ?? 'http://127.0.0.1:18080';
const output = process.env.OUTPUT_FILE ?? resolve(root, 'docs/artifacts/fault-matrix-latest.json');
const protocols = (process.env.PROTOCOLS ?? 'Mitsubishi MELSEC,Omron FINS,EtherNet/IP (Rockwell),MQTT / Sparkplug B')
  .split(',').map((value) => value.trim()).filter(Boolean);
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 30000);
const holdMs = Number(process.env.HOLD_MS ?? 2000);

async function request(path, options = {}) {
  const response = await fetch(`${gateway}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: HTTP ${response.status}`);
  return response.json();
}

const auth = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const headers = { authorization: `Bearer ${auth.token}` };

async function config() { return request('/api/config', { headers }); }
async function channels() { return request('/api/channels', { headers }); }
async function liveCount() {
  const value = await request('/api/tags/live', { headers });
  return Array.isArray(value) ? value.length : Array.isArray(value?.values) ? value.values.length : 0;
}
async function state(id) {
  const rows = await channels();
  const row = rows.find((item) => item.id === id);
  return row?.state ?? row?.status ?? 'unknown';
}
function listenerPid(port) {
  const text = execFileSync('cmd.exe', ['/d', '/c', 'netstat -ano'], { encoding: 'utf8' });
  const tcpPattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}\\s+(?:0\\.0\\.0\\.0|\\[::\\]):0\\s+LISTENING\\s+(\\d+)`, 'm');
  const udpPattern = new RegExp(`UDP\\s+(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}\\s+\\*:\\*\\s+(\\d+)`, 'm');
  return Number(text.match(tcpPattern)?.[1] ?? text.match(udpPattern)?.[1] ?? 0) || 0;
}
function portIsUp(port) { return listenerPid(port) > 0; }
function stopPid(pid) { execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); }
function restart(protocol, port) {
  const env = { ...process.env };
  let file;
  let args;
  if (protocol === 'Mitsubishi MELSEC') {
    env.MELSEC_SIM_PORT = String(port); file = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd'); args = ['apps/gateway/scripts/melsec-sim.ts'];
  } else if (protocol === 'Siemens Profinet') {
    env.S7_SIM_PORT = String(port); file = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd'); args = ['apps/gateway/scripts/s7-sim.ts'];
  } else if (protocol === 'Omron FINS') {
    env.FINS_SIM_PORT = String(port); file = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd'); args = ['apps/gateway/scripts/fins-sim.ts'];
  } else if (protocol === 'EtherNet/IP (Rockwell)') {
    env.ENIP_SIM_PORT = String(port); file = process.execPath; args = ['apps/gateway/scripts/enip-sim.cjs'];
  } else if (protocol === 'MQTT / Sparkplug B') {
    env.MQTT_BROKER_PORT = String(port); file = process.execPath; args = ['apps/gateway/scripts/mqtt-dev-broker.cjs'];
  } else if (protocol === 'SNMP') {
    env.SNMP_SIM_PORT = String(port); file = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd'); args = ['apps/gateway/scripts/snmp-sim.ts'];
  } else if (protocol === 'BACnet/IP') {
    env.BACNET_SIM_PORT = String(port); file = process.execPath; args = ['apps/gateway/scripts/bacnet-sim.cjs'];
  } else if (protocol === 'OPC UA') {
    env.OPC_SIM_PORT = String(port); file = resolve(root, 'apps/gateway/node_modules/.bin/tsx.cmd'); args = ['apps/gateway/scripts/opcua-sim-node.ts'];
  } else throw new Error(`no simulator restart command for ${protocol}`);
  const child = spawn(file, args, { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true, shell: file.endsWith('.cmd') });
  child.unref();
}
async function waitFor(predicate, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return false;
}

const report = { generatedAt: new Date().toISOString(), gateway, scenarios: [], pass: true };
const currentConfig = await config();
for (const protocol of protocols) {
  const channel = currentConfig.channels.find((item) => item.protocol === protocol);
  const scenario = { protocol, channelId: channel?.id, port: channel?.port, before: null, stoppedPid: 0, offline: null, recovered: null, liveBefore: 0, liveAfter: 0, pass: false, error: null };
  try {
    if (!channel) throw new Error(`channel not found: ${protocol}`);
    scenario.before = await state(channel.id);
    scenario.liveBefore = await liveCount();
    const pid = listenerPid(channel.port);
    scenario.stoppedPid = pid;
    if (!pid) throw new Error(`no listener on port ${channel.port}`);
    const started = Date.now();
    stopPid(pid);
    const offlineObserved = await waitFor(async () => ['offline', 'error'].includes(await state(channel.id)));
    scenario.offline = await state(channel.id);
    scenario.offlineMs = Date.now() - started;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
    restart(protocol, channel.port);
    const portObserved = await waitFor(() => portIsUp(channel.port));
    const recoveredObserved = portObserved && await waitFor(async () => (await state(channel.id)) === 'online');
    scenario.recovered = await state(channel.id);
    scenario.recoveryMs = Date.now() - started - scenario.offlineMs;
    scenario.liveAfter = await liveCount();
    scenario.pass = offlineObserved && recoveredObserved && scenario.liveAfter > 0;
    if (!scenario.pass) throw new Error('offline/recovery/live assertion failed');
  } catch (error) {
    scenario.error = String(error?.message ?? error);
    report.pass = false;
  }
  if (!scenario.pass) report.pass = false;
  report.scenarios.push(scenario);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
