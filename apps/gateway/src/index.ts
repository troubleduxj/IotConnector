import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@iotconnector/shared';
import { Engine } from './engine/engine';
import { loadConfig } from './config';
import { TDengineWriter } from './storage/tdengine';

/** ws 连接的最小接口（@fastify/websocket v11 传入 ws.WebSocket） */
interface WsLike {
  readyState: number;
  send(data: string): void;
  on(event: 'message', cb: (raw: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
}

const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const OPEN = 1;

async function main(): Promise<void> {
  const config = loadConfig();
  const tagById = new Map(config.tags.map((t) => [t.id, t]));

  const storage = new TDengineWriter({
    url: process.env.TDENGINE_URL, // 未设置 → 管道禁用（状态 disabled）
    user: process.env.TDENGINE_USER ?? 'root',
    password: process.env.TDENGINE_PASSWORD ?? 'taosdata',
    database: process.env.TDENGINE_DB ?? 'factory_bridge',
    superTable: process.env.TDENGINE_STABLE ?? 'st_factory_equipment',
  });

  const engine = new Engine(config.channels, config.tags);
  engine.start();
  storage.start();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const clients = new Set<WsLike>();
  const broadcast = (msg: ServerMessage): void => {
    const data = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === OPEN) client.send(data);
    }
  };

  engine.onBatch = (values) => {
    broadcast({ type: 'tags-batch', values });
    for (const v of values) {
      const tag = tagById.get(v.id);
      if (tag) storage.enqueue(v, tag);
    }
  };
  engine.onStatus = (status) => broadcast({ type: 'channel-status', status });

  app.get('/ws', { websocket: true }, (socket: WsLike) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'hello',
        serverTime: Date.now(),
        channels: engine.statusesList(),
        storage: storage.status,
      } satisfies ServerMessage),
    );
    socket.on('message', (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === 'subscribe') {
        // 订阅即推全量快照，保证新客户端首屏立即可见
        const snapshot = engine.snapshot();
        if (snapshot.length && socket.readyState === OPEN) {
          socket.send(JSON.stringify({ type: 'tags-batch', values: snapshot } satisfies ServerMessage));
        }
      } else if (msg.type === 'write') {
        void engine.write(msg.tagId, msg.value).then((result) => {
          if (socket.readyState === OPEN) {
            socket.send(JSON.stringify({ type: 'write-result', tagId: msg.tagId, ...result } satisfies ServerMessage));
          }
        });
      }
    });
    socket.on('close', () => clients.delete(socket));
  });

  app.get('/api/health', async () => ({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    channels: engine.statusesList().length,
    tags: config.tags.length,
    storage: storage.status,
  }));

  app.get('/api/channels', async () => engine.statusesList());
  app.get('/api/tags', async () => config.tags);
  app.get('/api/tags/live', async () => engine.snapshot());

  app.post('/api/tags/:id/write', async (req, reply) => {
    const { value } = (req.body ?? {}) as { value?: number | string | boolean };
    if (value === undefined) return reply.code(400).send({ ok: false, error: 'body.value required' });
    return engine.write((req.params as { id: string }).id, value);
  });

  /**
   * Historian 聚合查询（PRD FR-M7-03）：服务端窗口聚合 + 自动降采样。
   * GET /api/history?tagIds=1,5&start=<ms>&end=<ms>&interval=<秒，可选>
   */
  app.get('/api/history', async (req, reply) => {
    if (storage.status.state !== 'online') {
      return reply.code(503).send({ ok: false, error: `storage offline (${storage.status.state})`, storage: storage.status });
    }
    const q = (req.query ?? {}) as { tagIds?: string; start?: string; end?: string; interval?: string };
    const tagIds = (q.tagIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!tagIds.length) return reply.code(400).send({ ok: false, error: 'query.tagIds required (max 8)' });

    const end = q.end ? Number(q.end) : Date.now();
    const start = q.start ? Number(q.start) : end - 3600_000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return reply.code(400).send({ ok: false, error: 'invalid start/end (epoch ms)' });
    }
    // 目标 ~150 点，吸附到常用粒度
    const AUTO_STEPS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const rawSec = (end - start) / 1000 / 150;
    const intervalSec = q.interval
      ? Math.max(1, Number(q.interval))
      : AUTO_STEPS.find((s) => s >= rawSec) ?? Math.ceil(rawSec);

    const db = process.env.TDENGINE_DB ?? 'factory_bridge';
    const stable = process.env.TDENGINE_STABLE ?? 'st_factory_equipment';

    const series = [];
    for (const tagId of tagIds) {
      const tag = tagById.get(tagId);
      if (!tag) {
        series.push({ tagId, error: 'unknown tag' });
        continue;
      }
      const tn = tag.name.replace(/'/g, "''");
      const where = `WHERE tag_name='${tn}' AND ts >= ${start} AND ts <= ${end}`;
      const agg = await storage.query(
        `SELECT _wstart, AVG(val), MIN(val), MAX(val), COUNT(*) FROM ${db}.${stable} ${where} INTERVAL(${intervalSec}s)`,
      );
      const stats = await storage.query(
        `SELECT MIN(val), MAX(val), AVG(val), STDDEV(val), COUNT(*) FROM ${db}.${stable} ${where}`,
      );
      if (agg.code !== 0) {
        series.push({ tagId, error: agg.msg ?? `TDengine error ${agg.code}` });
        continue;
      }
      const points = (agg.data ?? []).map((row) => {
        const [t, avg, min, max, n] = row as [number, number, number, number, number];
        return { t: new Date(t).toISOString(), avg, min, max, n };
      });
      const s = (stats.data?.[0] ?? []) as number[];
      series.push({
        tagId,
        name: tag.name,
        unit: tag.unit,
        intervalSec,
        points,
        stats: { min: s[0] ?? null, max: s[1] ?? null, avg: s[2] ?? null, stdDev: s[3] ?? null, count: s[4] ?? 0 },
      });
    }
    return { ok: true, start, end, intervalSec, series };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[gateway] REST+WS listening on http://0.0.0.0:${PORT}  (ws://localhost:${PORT}/ws)`);
  console.log(`[gateway] channels: ${config.channels.length}, tags: ${config.tags.length}, storage: ${storage.status.state}`);

  const shutdown = async (): Promise<void> => {
    await engine.stop();
    storage.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((e) => {
  console.error('[gateway] fatal:', e);
  process.exit(1);
});
