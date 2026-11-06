import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const targets = (process.env.GATEWAYS ?? 'http://127.0.0.1:18080,http://127.0.0.1:18081').split(',').map((v) => v.trim()).filter(Boolean);
const durationMs = Number(process.env.DURATION_MS ?? 30 * 60 * 1000);
const intervalMs = Number(process.env.INTERVAL_MS ?? 5000);
const output = resolve(process.env.OUTPUT_FILE ?? 'docs/artifacts/gateway-stability-30m.json');
const startedAt = new Date().toISOString();
const samples = [];

async function observe(base) {
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }), signal: AbortSignal.timeout(4000) });
    if (!login.ok) throw new Error(`login HTTP ${login.status}`);
    const token = (await login.json()).token;
    const headers = { authorization: `Bearer ${token}` };
    const [healthResponse, channelsResponse, liveResponse] = await Promise.all([
      fetch(`${base}/api/health`, { headers, signal: AbortSignal.timeout(4000) }),
      fetch(`${base}/api/channels`, { headers, signal: AbortSignal.timeout(4000) }),
      fetch(`${base}/api/tags/live`, { headers, signal: AbortSignal.timeout(4000) }),
    ]);
    if (!healthResponse.ok || !channelsResponse.ok || !liveResponse.ok) throw new Error(`HTTP ${healthResponse.status}/${channelsResponse.status}/${liveResponse.status}`);
    const health = await healthResponse.json();
    const channels = await channelsResponse.json();
    const live = await liveResponse.json();
    const values = Array.isArray(live) ? live : Array.isArray(live?.values) ? live.values : [];
    return {
      url: base,
      ok: true,
      channels: channels.length,
      online: channels.filter((c) => ['online', 'connected'].includes(c.state ?? c.status)).length,
      offline: channels.filter((c) => ['offline', 'error'].includes(c.state ?? c.status)).length,
      liveCount: values.length,
      badQuality: values.filter((v) => v.quality && v.quality !== 'Good').length,
      storageState: health.storage?.state ?? 'unknown',
      queued: health.storage?.queued ?? null,
      written: health.storage?.written ?? null,
    };
  } catch (error) {
    return { url: base, ok: false, error: String(error?.message ?? error) };
  }
}

const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
  const observedAt = new Date().toISOString();
  const result = await Promise.all(targets.map(observe));
  samples.push({ observedAt, targets: result });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
}

const targetSummary = targets.map((url) => {
  const rows = samples.flatMap((sample) => sample.targets).filter((row) => row.url === url);
  const failures = rows.filter((row) => !row.ok);
  const badQuality = rows.filter((row) => row.ok && row.badQuality > 0);
  const storageOffline = rows.filter((row) => row.ok && row.storageState !== 'online');
  const liveCounts = rows.filter((row) => row.ok).map((row) => row.liveCount);
  const queuedCounts = rows.filter((row) => row.ok).map((row) => row.queued ?? 0);
  return { url, observations: rows.length, failures: failures.length, badQualityObservations: badQuality.length, storageOfflineObservations: storageOffline.length, minLiveCount: liveCounts.length > 0 ? Math.min(...liveCounts) : 0, maxQueued: queuedCounts.length > 0 ? Math.max(...queuedCounts) : 0 };
});
const report = { startedAt, finishedAt: new Date().toISOString(), durationMs, intervalMs, targets: targetSummary, samples, pass: targetSummary.every((row) => row.failures === 0 && row.badQualityObservations === 0 && row.storageOfflineObservations === 0 && row.minLiveCount > 0) };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, samples: `[${samples.length} samples omitted from stdout; written to ${output}]` }, null, 2));
process.exitCode = report.pass ? 0 : 1;
