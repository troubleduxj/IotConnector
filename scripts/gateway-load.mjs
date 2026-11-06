import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const targets = (process.env.GATEWAYS ?? 'http://127.0.0.1:18080,http://127.0.0.1:18081').split(',').map((v) => v.trim()).filter(Boolean);
const concurrency = Number(process.env.CONCURRENCY ?? 10);
const requestsPerGateway = Number(process.env.REQUESTS ?? 100);
const output = process.env.OUTPUT_FILE ?? resolve('docs/artifacts/gateway-load-latest.json');

async function login(base) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  if (!response.ok) throw new Error(`${base} login HTTP ${response.status}`);
  return (await response.json()).token;
}

async function runTarget(base) {
  const token = await login(base);
  const headers = { authorization: `Bearer ${token}` };
  const latencies = [];
  let completed = 0;
  let errors = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= requestsPerGateway) return;
      const started = performance.now();
      try {
        const response = await fetch(`${base}/api/tags/live`, { headers, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const count = Array.isArray(body) ? body.length : Array.isArray(body?.values) ? body.values.length : 0;
        if (count === 0) throw new Error('empty live sample set');
        completed++;
      } catch {
        errors++;
      } finally {
        latencies.push(performance.now() - started);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requestsPerGateway) }, worker));
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  return { url: base, requests: requestsPerGateway, concurrency, completed, errors, errorRate: errors / requestsPerGateway, minMs: latencies[0] ?? 0, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: latencies.at(-1) ?? 0 };
}

const report = { generatedAt: new Date().toISOString(), targets: [], pass: true };
for (const target of targets) {
  try {
    const result = await runTarget(target);
    report.targets.push(result);
    if (result.errors > 0) report.pass = false;
  } catch (error) {
    report.targets.push({ url: target, error: String(error?.message ?? error) });
    report.pass = false;
  }
}
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.pass ? 0 : 1;
