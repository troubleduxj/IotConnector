import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@iotconnector/shared';
import type { AlarmRule, Channel, Tag } from '@iotconnector/shared';
import { Engine } from './engine/engine';
import { loadConfig, saveConfig } from './config';
import { AlarmEngine } from './alarms';
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
  // 可变配置引用：CRUD 路由原地修改这些数组，引擎通过 syncConfig/引用共享读取
  const channels = config.channels;
  const tags = config.tags;
  const getTag = (id: string): Tag | undefined => tags.find((t) => t.id === id);

  const alarmEngine = new AlarmEngine(config.alarms ?? []);

  const storage = new TDengineWriter({
    url: process.env.TDENGINE_URL, // 未设置 → 管道禁用（状态 disabled）
    user: process.env.TDENGINE_USER ?? 'root',
    password: process.env.TDENGINE_PASSWORD ?? 'taosdata',
    database: process.env.TDENGINE_DB ?? 'factory_bridge',
    superTable: process.env.TDENGINE_STABLE ?? 'st_factory_equipment',
  });

  const engine = new Engine(channels, tags);
  engine.start();
  storage.start();

  engine.onEvaluate = (tag, value, quality) => alarmEngine.evaluate(tag, value, quality);

  const persist = (): void => {
    saveConfig({ channels, tags, alarms: alarmEngine.getRules() });
  };

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
      const tag = getTag(v.id);
      if (tag) storage.enqueue(v, tag);
    }
  };
  engine.onStatus = (status) => broadcast({ type: 'channel-status', status });
  alarmEngine.onEvent = (event) => broadcast({ type: 'alarm', event });

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
      const tag = getTag(tagId);
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
        engMin: tag.engMin ?? null,
        engMax: tag.engMax ?? null,
        intervalSec,
        points,
        stats: { min: s[0] ?? null, max: s[1] ?? null, avg: s[2] ?? null, stdDev: s[3] ?? null, count: s[4] ?? 0 },
      });
    }
    return { ok: true, start, end, intervalSec, series };
  });

  // ===== 配置 CRUD：持久化 + 通道热重载（PRD FR-M2-01 / FR-M2-06）=====
  const broadcastConfigChanged = (): void => broadcast({ type: 'config-changed' });

  app.post('/api/channels', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<Channel>;
    if (!b.name || !b.protocol) return reply.code(400).send({ ok: false, error: 'name & protocol required' });
    if (channels.some((c) => c.name === b.name)) return reply.code(409).send({ ok: false, error: 'channel name already exists' });
    const channel: Channel = {
      id: `ch_${Date.now()}`,
      name: b.name,
      protocol: b.protocol,
      host: b.host ?? '127.0.0.1',
      port: Number(b.port ?? 502),
      enabled: b.enabled ?? true,
      pollIntervalMs: Number(b.pollIntervalMs ?? 1000),
      params: b.params ?? {},
    };
    channels.push(channel);
    persist();
    void engine.reloadChannel(channel.id);
    broadcastConfigChanged();
    return reply.code(201).send(channel);
  });

  app.put('/api/channels/:id', async (req, reply) => {
    const channel = channels.find((c) => c.id === (req.params as { id: string }).id);
    if (!channel) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const b = (req.body ?? {}) as Partial<Channel>;
    if (b.name !== undefined) channel.name = b.name;
    if (b.host !== undefined) channel.host = b.host;
    if (b.port !== undefined) channel.port = Number(b.port);
    if (b.enabled !== undefined) channel.enabled = Boolean(b.enabled);
    if (b.pollIntervalMs !== undefined) channel.pollIntervalMs = Number(b.pollIntervalMs);
    if (b.params !== undefined) channel.params = b.params;
    persist();
    void engine.reloadChannel(channel.id);
    broadcastConfigChanged();
    return channel;
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const i = channels.findIndex((c) => c.id === id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'channel not found' });
    channels.splice(i, 1);
    const kept = tags.filter((t) => t.channelId !== id);
    const removedCount = tags.length - kept.length;
    tags.splice(0, tags.length, ...kept);
    alarmEngine.setRules(alarmEngine.getRules().filter((r) => kept.some((t) => t.id === r.tagId)));
    persist();
    await engine.removeChannel(id);
    broadcastConfigChanged();
    return { ok: true, removedTags: removedCount };
  });

  app.post('/api/tags', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<Tag>;
    if (!b.channelId || !b.name || !b.address) return reply.code(400).send({ ok: false, error: 'channelId, name & address required' });
    if (!channels.some((c) => c.id === b.channelId)) return reply.code(404).send({ ok: false, error: 'channel not found' });
    if (tags.some((t) => t.name === b.name)) return reply.code(409).send({ ok: false, error: 'tag name already exists' });
    const tag: Tag = {
      id: `tag_${Date.now()}`,
      channelId: b.channelId,
      name: b.name,
      address: b.address,
      dataType: b.dataType ?? 'Float',
      unit: b.unit ?? '',
      scale: Number(b.scale ?? 1),
      offset: Number(b.offset ?? 0),
      engMin: b.engMin,
      engMax: b.engMax,
      description: b.description ?? '',
    };
    tags.push(tag);
    persist();
    engine.upsertTagRuntime(tag);
    void engine.reloadChannel(tag.channelId);
    broadcastConfigChanged();
    return reply.code(201).send(tag);
  });

  app.put('/api/tags/:id', async (req, reply) => {
    const tag = getTag((req.params as { id: string }).id);
    if (!tag) return reply.code(404).send({ ok: false, error: 'tag not found' });
    const b = (req.body ?? {}) as Partial<Tag>;
    if (b.name !== undefined) tag.name = b.name;
    if (b.address !== undefined) tag.address = b.address;
    if (b.dataType !== undefined) tag.dataType = b.dataType;
    if (b.unit !== undefined) tag.unit = b.unit;
    if (b.scale !== undefined) tag.scale = Number(b.scale);
    if (b.offset !== undefined) tag.offset = Number(b.offset);
    if (b.engMin !== undefined) tag.engMin = b.engMin === null ? undefined : Number(b.engMin);
    if (b.engMax !== undefined) tag.engMax = b.engMax === null ? undefined : Number(b.engMax);
    if (b.description !== undefined) tag.description = b.description;
    persist();
    engine.upsertTagRuntime(tag);
    void engine.reloadChannel(tag.channelId);
    broadcastConfigChanged();
    return tag;
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const tag = getTag(id);
    if (!tag) return reply.code(404).send({ ok: false, error: 'tag not found' });
    tags.splice(tags.findIndex((t) => t.id === id), 1);
    alarmEngine.setRules(alarmEngine.getRules().filter((r) => r.tagId !== id));
    persist();
    engine.removeTagRuntime(id);
    void engine.reloadChannel(tag.channelId);
    broadcastConfigChanged();
    return { ok: true };
  });

  // ===== 告警（PRD FR-M10-01）=====
  app.get('/api/alarms', async () => ({
    rules: alarmEngine.getRules(),
    active: alarmEngine.getActive(),
    history: alarmEngine.getHistory(50),
  }));

  app.post('/api/alarms', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<AlarmRule>;
    if (!b.tagId || !b.kind || b.threshold === undefined) {
      return reply.code(400).send({ ok: false, error: 'tagId, kind & threshold required' });
    }
    if (!getTag(b.tagId)) return reply.code(404).send({ ok: false, error: 'tag not found' });
    const rule: AlarmRule = {
      id: `alm_${Date.now()}`,
      tagId: b.tagId,
      kind: b.kind,
      threshold: Number(b.threshold),
      hysteresis: Math.max(0, Number(b.hysteresis ?? 0)),
      enabled: b.enabled ?? true,
      message: b.message,
    };
    alarmEngine.upsertRule(rule);
    persist();
    broadcastConfigChanged();
    return reply.code(201).send(rule);
  });

  app.put('/api/alarms/:id', async (req, reply) => {
    const rule = alarmEngine.getRules().find((r) => r.id === (req.params as { id: string }).id);
    if (!rule) return reply.code(404).send({ ok: false, error: 'alarm rule not found' });
    const b = (req.body ?? {}) as Partial<AlarmRule>;
    if (b.kind !== undefined) rule.kind = b.kind;
    if (b.threshold !== undefined) rule.threshold = Number(b.threshold);
    if (b.hysteresis !== undefined) rule.hysteresis = Math.max(0, Number(b.hysteresis));
    if (b.enabled !== undefined) rule.enabled = Boolean(b.enabled);
    if (b.message !== undefined) rule.message = b.message;
    alarmEngine.upsertRule(rule);
    persist();
    broadcastConfigChanged();
    return rule;
  });

  app.delete('/api/alarms/:id', async (req, reply) => {
    const ok = alarmEngine.removeRule((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ ok: false, error: 'alarm rule not found' });
    persist();
    broadcastConfigChanged();
    return { ok: true };
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
