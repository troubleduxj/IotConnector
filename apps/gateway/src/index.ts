import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@iotconnector/shared';
import fs from 'node:fs';
import path from 'node:path';
import type { AlarmEvent, AlarmRule, Channel, NotificationConfig, Tag } from '@iotconnector/shared';
import { Engine } from './engine/engine';
import { loadConfig, saveConfig } from './config';
import { AlarmEngine } from './alarms';
import { getFrames, clearFrames } from './diagnostics';
import { dispatchAlarm, sendTestMessage } from './notify';
import { testChannel } from './engine/testers';
import { toNodes7Address } from './engine/drivers/s7';
import { StorageTaskEngine } from './storage-tasks';
import { ScriptEngine } from './scripts';
import type { Recipe, Script, StorageTask } from '@iotconnector/shared';
import type { NorthboundConfig } from './northbound/publisher';
import { NorthboundPublisher } from './northbound/publisher';
import { AuthStore, hashPassword, type Role, type SessionUser } from './auth';
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
  const authStore = new AuthStore(config.users ?? []);
  // 空账号表（旧配置迁移）时注入种子账号
  if (authStore.getUsers().length === 0) {
    authStore.setUsers([
      { id: 'u_admin', username: 'admin', passwordHash: hashPassword('admin123'), role: 'admin', createdAt: Date.now() },
      { id: 'u_engineer', username: 'engineer', passwordHash: hashPassword('engineer123'), role: 'engineer', createdAt: Date.now() },
      { id: 'u_operator', username: 'operator', passwordHash: hashPassword('operator123'), role: 'operator', createdAt: Date.now() },
    ]);
  }
  const AUDIT_FILE = path.resolve(process.cwd(), 'data', 'audit.jsonl');
  const auditLog = (user: SessionUser, action: string, detail: string): void => {
    try {
      fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
      fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: Date.now(), user: user.username, role: user.role, action, detail }) + '\n');
    } catch {
      /* 审计失败不阻塞业务 */
    }
  };
  const notifications: NotificationConfig = config.notifications;

  // 告警事件持久化：JSONL 追加（启动恢复）+ TDengine 审计表（可查询，best-effort）
  const ALARM_FILE = path.resolve(process.cwd(), 'data', 'alarms.jsonl');
  const persistAlarmEvent = (event: AlarmEvent): void => {
    try {
      fs.mkdirSync(path.dirname(ALARM_FILE), { recursive: true });
      fs.appendFileSync(ALARM_FILE, JSON.stringify(event) + '\n');
    } catch (e) {
      console.error('[alarms] jsonl append failed:', String(e));
    }
    void storage
      .query(
        `INSERT INTO ${process.env.TDENGINE_DB ?? 'factory_bridge'}.alarm_events ` +
          `(ts, event_id, rule_id, tag_id, tag_name, channel, status, kind, threshold, val, message) VALUES ` +
          `(${event.ts}, '${event.id}', '${event.ruleId}', '${event.tagId}', '${event.tagName.replace(/'/g, "''")}', ` +
          `'${event.channel}', '${event.state}', '${event.kind}', ${event.threshold}, ${event.value}, ` +
          `'${(event.message ?? '').replace(/'/g, "''")}')`,
      )
      .catch(() => {});
  };
  try {
    if (fs.existsSync(ALARM_FILE)) {
      const events = fs
        .readFileSync(ALARM_FILE, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AlarmEvent);
      alarmEngine.loadHistory(events);
      console.log(`[alarms] restored ${events.length} events from ${ALARM_FILE}`);
    }
  } catch (e) {
    console.error('[alarms] history restore failed:', String(e));
  }
  alarmEngine.onPersist = persistAlarmEvent;

  // ===== 北向 Sparkplug B 发布器（决策 D7）=====
  const northbound: NorthboundConfig = config.northbound ?? {
    enabled: false, url: 'mqtt://127.0.0.1:1883', groupId: 'Factory', edgeNodeId: 'FB_Edge_GW01', dataFlushMs: 1000,
  };
  const STATE_DIR = path.resolve(process.cwd(), 'data');
  const northboundPublisher = new NorthboundPublisher(
    () => northbound,
    {
      statePath: path.join(STATE_DIR, 'northbound.json'),
      outboxPath: path.join(STATE_DIR, 'outbox.jsonl'),
      read: (p) => fs.readFileSync(p, 'utf-8'),
      write: (p, data) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(data, null, 2));
      },
    },
    () => channels,
    () => tags,
  );
  northboundPublisher.loadPersisted();
  northboundPublisher.start();

  // 会话持久化：重启不掉线
  const SESSION_FILE = path.resolve(process.cwd(), 'data', 'sessions.json');
  try {
    if (fs.existsSync(SESSION_FILE)) {
      authStore.loadSessions(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')));
      console.log('[auth] sessions restored');
    }
  } catch { /* ignore */ }
  authStore.onSessionsChanged = (entries) => {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      fs.writeFileSync(SESSION_FILE, JSON.stringify(entries, null, 2));
    } catch { /* ignore */ }
  };

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

  const getValue = (tagId: string): number | string | boolean | undefined =>
    engine.snapshot().find((v) => v.id === tagId)?.value;

  const storageTaskEngine = new StorageTaskEngine(storage, getValue, getTag, process.env.TDENGINE_DB ?? 'factory_bridge');
  storageTaskEngine.sync(config.storageTasks ?? []);

  const scriptEngine = new ScriptEngine(
    (key) => getValue(tags.find((t) => t.name === key || t.id === key)?.id ?? key),
    (key) => tags.find((t) => t.name === key || t.id === key),
    async (tagId, value) => {
      const r = await engine.write(tagId, value);
      if (!r.ok) throw new Error(r.error);
    },
  );
  scriptEngine.setScripts(config.scripts ?? []);

  engine.onTagSample = (tag, value, quality) => {
    storageTaskEngine.onTagSample(tag.id, value);
    scriptEngine.onTagSample(tag.id, value);
  };
  // 告警审计表（事件持久化到 TDengine，best-effort）
  void storage
    .query(
      `CREATE TABLE IF NOT EXISTS ${process.env.TDENGINE_DB ?? 'factory_bridge'}.alarm_events ` +
        `(ts TIMESTAMP, event_id VARCHAR(64), rule_id VARCHAR(64), tag_id VARCHAR(32), tag_name VARCHAR(128), ` +
        `channel VARCHAR(64), state VARCHAR(8), kind VARCHAR(8), threshold DOUBLE, value DOUBLE, message VARCHAR(200))`,
    )
    .catch(() => {});

  engine.onEvaluate = (tag, value, quality) => alarmEngine.evaluate(tag, value, quality);

  const persist = (): void => {
    saveConfig({
      channels, tags, alarms: alarmEngine.getRules(),
      users: authStore.getUsers(), notifications,
      storageTasks: config.storageTasks, recipes: config.recipes, scripts: config.scripts,
    });
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
    // 北向 Sparkplug DDATA（按通道聚合，flush 节奏合并发布）
    const byChannel = new Map<string, typeof values>();
    for (const v of values) {
      const tag = getTag(v.id);
      if (!tag) continue;
      const list = byChannel.get(tag.channelId) ?? [];
      list.push(v);
      byChannel.set(tag.channelId, list);
    }
    for (const [channelId, list] of byChannel) northboundPublisher.enqueueChannelData(channelId, list);
  };
  engine.onStatus = (status) => broadcast({ type: 'channel-status', status });

  // ===== 认证助手（PRD FR-M10-02）=====
  const tokenOf = (req): string | undefined => {
    const h = req.headers.authorization as string | undefined;
    if (h?.startsWith('Bearer ')) return h.slice(7);
    return (req.query as Record<string, string> | undefined)?.token;
  };
  /** 校验失败时已发送响应并返回 null；成功返回会话用户 */
  const requireAuth = (req, reply, minRole: Role): SessionUser | null => {
    const result = authStore.authorize(tokenOf(req), minRole);
    if ('code' in result) {
      void reply.code(result.code).send({
        ok: false,
        error: result.code === 401 ? '未登录或会话已过期' : '权限不足（需要更高角色）',
      });
      return null;
    }
    return result.user;
  };
  alarmEngine.onEvent = (event) => {
    broadcast({ type: 'alarm', event });
    void dispatchAlarm(notifications, event);
  };

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
    if (!requireAuth(req, reply, 'operator')) return;
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
  const broadcastConfigChanged = (): void => {
    broadcast({ type: 'config-changed' });
    northboundPublisher.applyConfig(); // 通道/位号变更 → DBIRTH 刷新
  };

  app.post('/api/channels', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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

  // 真实连接测试（FR-M2-04）：临时连接执行协议握手序列，不干扰采集驱动
  app.post('/api/channels/:id/test', async (req, reply) => {
    if (!requireAuth(req, reply, 'engineer')) return;
    const channel = channels.find((c) => c.id === (req.params as { id: string }).id);
    if (!channel) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const channelTagList = tags.filter((t) => t.channelId === channel.id);
    let s7Probe: { nodes7Addr: string; addrLabel: string } | undefined;
    let opcProbe: string | undefined;
    if (channel.protocol === 'Siemens Profinet' && channelTagList[0]) {
      try {
        s7Probe = { nodes7Addr: toNodes7Address(channelTagList[0].address), addrLabel: `${channelTagList[0].address}` };
      } catch {
        /* 地址不可解析则跳过探针 */
      }
    }
    if (channel.protocol === 'OPC UA' && channelTagList[0]) opcProbe = channelTagList[0].address;
    const result = await testChannel(channel, s7Probe, opcProbe);
    return result;
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
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
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const ok = alarmEngine.removeRule((req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ ok: false, error: 'alarm rule not found' });
    persist();
    broadcastConfigChanged();
    return { ok: true };
  });

  // ===== 完整配置与通知（PRD FR-M9 / M2）=====
  app.get('/api/config', async () => ({
    channels,
    tags,
    alarms: alarmEngine.getRules(),
    notifications,
  }));

  app.get('/api/notifications', async () => notifications);

  app.put('/api/notifications', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as Partial<NotificationConfig>;
    if (b.enabled !== undefined) notifications.enabled = Boolean(b.enabled);
    if (b.webhookUrl !== undefined) notifications.webhookUrl = String(b.webhookUrl);
    persist();
    return notifications;
  });

  // 整体保存通知配置（四渠道）
  app.put('/api/notifications/v2', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as NotificationConfig;
    notifications.enabled = Boolean(b.enabled);
    notifications.webhookUrl = String(b.webhookUrl ?? '');
    if (b.dingtalk) notifications.dingtalk = b.dingtalk;
    if (b.wecom) notifications.wecom = b.wecom;
    if (b.email) notifications.email = b.email;
    persist();
    return notifications;
  });

  // 渠道测试消息
  app.post('/api/notifications/test', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const { channel } = (req.body ?? {}) as { channel?: string };
    try {
      const via = await sendTestMessage(notifications, channel ?? 'webhook');
      return { ok: true, via };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: String((e as Error).message ?? e) });
    }
  });

  // ===== 北向 MQTT/Sparkplug B（决策 D7）=====
  app.get('/api/northbound', async () => ({ config: northbound, status: northboundPublisher.status }));

  app.put('/api/northbound', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as Partial<NorthboundConfig>;
    if (b.enabled !== undefined) northbound.enabled = Boolean(b.enabled);
    if (b.url !== undefined) northbound.url = String(b.url);
    if (b.username !== undefined) northbound.username = String(b.username);
    if (b.password !== undefined) northbound.password = String(b.password);
    if (b.groupId !== undefined) northbound.groupId = String(b.groupId);
    if (b.edgeNodeId !== undefined) northbound.edgeNodeId = String(b.edgeNodeId);
    if (b.dataFlushMs !== undefined) northbound.dataFlushMs = Math.max(500, Number(b.dataFlushMs));
    persist();
    northboundPublisher.applyConfig();
    return { config: northbound, status: northboundPublisher.status };
  });

  app.post('/api/northbound/rebirth', async (req, reply) => {
    if (!requireAuth(req, reply, 'engineer')) return;
    northboundPublisher.applyConfig(); // 触发 BIRTH 重发
    return { ok: true };
  });

  // ===== 认证与用户管理（PRD FR-M10-02）=====
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ ok: false, error: '用户名与口令必填' });
    const result = authStore.login(username, password);
    if (!result) return reply.code(401).send({ ok: false, error: '用户名或口令错误' });
    if (result.ok === false) {
      const code = result.locked === true ? 423 : 401;
      return reply.code(code).send({ ok: false, error: result.error });
    }
    auditLog(result.user, 'login', `${username} 登录成功`);
    return { token: result.token, user: result.user, mustChangePassword: result.mustChangePassword ?? false };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const user = requireAuth(req, reply, 'operator');
    if (!user) return;
    authStore.logout(tokenOf(req));
    auditLog(user, 'logout', `${user.username} 退出登录`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = authStore.verify(tokenOf(req));
    if (!user) return reply.code(401).send({ ok: false, error: '未登录' });
    return user;
  });

  app.get('/api/users', async (req, reply) => {
    if (!requireAuth(req, reply, 'admin')) return;
    return authStore.getUsers().map(({ passwordHash: _ph, ...u }) => u);
  });

  app.post('/api/users', async (req, reply) => {
    const user = requireAuth(req, reply, 'admin');
    if (!user) return;
    const b = (req.body ?? {}) as { username?: string; password?: string; role?: Role };
    if (!b.username || !b.password || !b.role) return reply.code(400).send({ ok: false, error: 'username, password & role required' });
    if (authStore.getUsers().some((u) => u.username === b.username)) {
      return reply.code(409).send({ ok: false, error: '用户名已存在' });
    }
    const created = {
      id: `u_${Date.now()}`,
      username: b.username,
      passwordHash: hashPassword(b.password),
      role: b.role,
      createdAt: Date.now(),
    };
    authStore.setUsers([...authStore.getUsers(), created]);
    persist();
    auditLog(user, 'user.create', `${b.username} (${b.role})`);
    return reply.code(201).send({ id: created.id, username: created.username, role: created.role });
  });

  app.put('/api/users/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const target = authStore.findUser((req.params as { id: string }).id);
    if (!target) return reply.code(404).send({ ok: false, error: 'user not found' });
    const b = (req.body ?? {}) as { password?: string; role?: Role };
    if (b.password) target.passwordHash = hashPassword(b.password);
    if (b.role) target.role = b.role;
    persist();
    auditLog(actor, 'user.update', `${target.username} role=${target.role}`);
    return { id: target.id, username: target.username, role: target.role };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const id = (req.params as { id: string }).id;
    if (id === actor.id) return reply.code(400).send({ ok: false, error: '不能删除当前登录账号' });
    const target = authStore.findUser(id);
    if (!target) return reply.code(404).send({ ok: false, error: 'user not found' });
    authStore.setUsers(authStore.getUsers().filter((u) => u.id !== id));
    persist();
    auditLog(actor, 'user.delete', target.username);
    return { ok: true };
  });

  app.get('/api/audit', async (req, reply) => {
    if (!requireAuth(req, reply, 'admin')) return;
    try {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
      const events = lines.slice(-200).map((l) => JSON.parse(l) as Record<string, unknown>).reverse();
      return { events };
    } catch {
      return { events: [] };
    }
  });

  // ===== 告警历史查询（持久化于 TDengine alarm_events）=====
  app.post('/api/alarms/events/:id/ack', async (req, reply) => {
    if (!requireAuth(req, reply, 'operator')) return;
    const user = requireAuth(req, reply, 'operator');
    if (!user) return;
    const { note } = (req.body ?? {}) as { note?: string };
    const updated = alarmEngine.ack((req.params as { id: string }).id, user.username, note);
    if (!updated) return reply.code(404).send({ ok: false, error: 'event not found' });
    broadcast({ type: 'alarm', event: updated });
    return updated;
  });

  // ===== 报文诊断（PRD FR-M2-20，Modbus 先行）=====
  app.get('/api/channels/:id/frames', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; dir?: string; clear?: string };
    const id = (req.params as { id: string }).id;
    if (q.clear === '1') clearFrames(id);
    const dir = q.dir === 'TX' || q.dir === 'RX' ? q.dir : undefined;
    return { ok: true, frames: getFrames(id, Math.min(200, Number(q.limit ?? 100)), dir) };
  });

  app.get('/api/alarms/history', async (req) => {
    const q = (req.query ?? {}) as { tagId?: string; state?: string; start?: string; end?: string; limit?: string; offset?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const where: string[] = [];
    if (q.tagId) where.push(`tag_id='${q.tagId.replace(/'/g, "''")}'`);
    if (q.state === 'Active' || q.state === 'Cleared') where.push(`status='${q.state}'`);
    if (q.start) where.push(`ts >= ${Number(q.start)}`);
    if (q.end) where.push(`ts <= ${Number(q.end)}`);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const db = process.env.TDENGINE_DB ?? 'factory_bridge';
    const rows = await storage.query(
      `SELECT ts, event_id, rule_id, tag_id, tag_name, channel, status, kind, threshold, val, message ` +
        `FROM ${db}.alarm_events ${clause} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`,
    );
    const total = await storage.query(`SELECT COUNT(*) FROM ${db}.alarm_events ${clause}`);
    const events = (rows.data ?? []).map((r) => {
      const [ts, eventId, ruleId, tagId, tagName, channel, status, kind, threshold, value, message] = r as unknown[];
      return { ts, eventId, ruleId, tagId, tagName, channel, state: status, kind, threshold, value, message };
    });
    return { ok: true, total: (total.data?.[0]?.[0] as number) ?? 0, limit, offset, events };
  });

  // ===== 调度指标（PRD M3 页真实化）=====
  app.get('/api/scheduler', async () => {
    const uptimeSec = Math.round(process.uptime());
    const perChannel = channels.map((c) => {
      const st = engine.getChannelStats(c.id);
      return {
        id: c.id,
        name: c.name,
        protocol: c.protocol,
        enabled: c.enabled,
        state: engine.statusesList().find((s) => s.id === c.id)?.state ?? '—',
        pollIntervalMs: c.pollIntervalMs,
        tags: tags.filter((t) => t.channelId === c.id).length,
        samples: st.samples,
        rateHz: uptimeSec > 0 ? Number((st.samples / uptimeSec).toFixed(2)) : 0,
        lastError: st.lastError,
      };
    });
    const totalSamples = perChannel.reduce((sum, c) => sum + c.samples, 0);
    return {
      uptimeSec,
      totalSamples,
      rateHz: uptimeSec > 0 ? Number((totalSamples / uptimeSec).toFixed(2)) : 0,
      onlineChannels: perChannel.filter((c) => c.state === 'online').length,
      channels: perChannel,
    };
  });

  // ===== 存储任务 CRUD（PRD FR-M4-01）=====
  app.get('/api/storage-tasks', async () => config.storageTasks ?? []);

  app.post('/api/storage-tasks', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as Partial<StorageTask>;
    if (!b.name || !b.tableName || !b.trigger) return reply.code(400).send({ ok: false, error: 'name, tableName & trigger required' });
    const task: StorageTask = {
      id: `stk_${Date.now()}`,
      name: b.name,
      enabled: b.enabled ?? true,
      tableName: b.tableName,
      trigger: b.trigger,
      mappings: b.mappings ?? [],
    };
    config.storageTasks = [...(config.storageTasks ?? []), task];
    persist();
    storageTaskEngine.sync(config.storageTasks);
    broadcastConfigChanged();
    return reply.code(201).send(task);
  });

  app.put('/api/storage-tasks/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const i = (config.storageTasks ?? []).findIndex((t) => t.id === (req.params as { id: string }).id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'task not found' });
    config.storageTasks[i] = { ...config.storageTasks[i], ...(req.body as Partial<StorageTask>) };
    persist();
    storageTaskEngine.sync(config.storageTasks);
    broadcastConfigChanged();
    return config.storageTasks[i];
  });

  app.delete('/api/storage-tasks/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    config.storageTasks = (config.storageTasks ?? []).filter((t) => t.id !== (req.params as { id: string }).id);
    persist();
    storageTaskEngine.sync(config.storageTasks);
    broadcastConfigChanged();
    return { ok: true };
  });

  // ===== 配方 CRUD + 下发（PRD M6）=====
  app.get('/api/recipes', async () => config.recipes ?? []);

  app.post('/api/recipes', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as Partial<Recipe>;
    if (!b.name) return reply.code(400).send({ ok: false, error: 'name required' });
    const recipe: Recipe = {
      id: `rcp_${Date.now()}`,
      name: b.name,
      description: b.description ?? '',
      items: b.items ?? [],
      updatedAt: Date.now(),
    };
    config.recipes = [...(config.recipes ?? []), recipe];
    persist();
    broadcastConfigChanged();
    return reply.code(201).send(recipe);
  });

  app.put('/api/recipes/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const i = (config.recipes ?? []).findIndex((r) => r.id === (req.params as { id: string }).id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'recipe not found' });
    const b = (req.body ?? {}) as Partial<Recipe>;
    config.recipes[i] = { ...config.recipes[i], name: b.name ?? config.recipes[i].name, description: b.description ?? config.recipes[i].description, items: b.items ?? config.recipes[i].items, updatedAt: Date.now() };
    persist();
    broadcastConfigChanged();
    return config.recipes[i];
  });

  app.delete('/api/recipes/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    config.recipes = (config.recipes ?? []).filter((r) => r.id !== (req.params as { id: string }).id);
    persist();
    broadcastConfigChanged();
    return { ok: true };
  });

  // 配方下发：逐参数写入并返回逐项结果（PRD FR-M6-02）
  app.post('/api/recipes/:id/download', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const recipe = (config.recipes ?? []).find((r) => r.id === (req.params as { id: string }).id);
    if (!recipe) return reply.code(404).send({ ok: false, error: 'recipe not found' });
    const results = [];
    for (const item of recipe.items) {
      const tag = getTag(item.tagId);
      if (!tag) {
        results.push({ tagId: item.tagId, ok: false, error: 'tag not found' });
        continue;
      }
      const r = await engine.write(item.tagId, item.value);
      auditLog(actor, 'recipe.download', `${recipe.name}: ${tag.name} = ${item.value} ${r.ok ? '成功' : '失败 ' + (r.error ?? '')}`);
      results.push({ tagId: item.tagId, name: tag.name, value: item.value, ok: r.ok, error: r.error });
    }
    return { ok: results.every((r) => r.ok), results };
  });

  // ===== 边缘脚本 CRUD / 运行 / 输出（决策 D5）=====
  app.get('/api/scripts', async () =>
    (config.scripts ?? []).map((s) => ({ ...s, triggerText: s.trigger.type, output: scriptEngine.getOutputs(s.id).slice(-20) })),
  );

  app.post('/api/scripts', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as Partial<Script>;
    if (!b.name || !b.code) return reply.code(400).send({ ok: false, error: 'name & code required' });
    const script: Script = {
      id: `scr_${Date.now()}`,
      name: b.name,
      description: b.description ?? '',
      code: b.code,
      trigger: b.trigger ?? { type: 'manual' },
      enabled: b.enabled ?? false,
    };
    config.scripts = [...(config.scripts ?? []), script];
    persist();
    scriptEngine.setScripts(config.scripts);
    broadcastConfigChanged();
    return reply.code(201).send(script);
  });

  app.put('/api/scripts/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const i = (config.scripts ?? []).findIndex((s) => s.id === (req.params as { id: string }).id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'script not found' });
    const b = (req.body ?? {}) as Partial<Script>;
    config.scripts[i] = { ...config.scripts[i], name: b.name ?? config.scripts[i].name, description: b.description ?? config.scripts[i].description, code: b.code ?? config.scripts[i].code, trigger: b.trigger ?? config.scripts[i].trigger, enabled: b.enabled ?? config.scripts[i].enabled };
    persist();
    scriptEngine.setScripts(config.scripts);
    broadcastConfigChanged();
    return config.scripts[i];
  });

  app.delete('/api/scripts/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    config.scripts = (config.scripts ?? []).filter((s) => s.id !== (req.params as { id: string }).id);
    persist();
    scriptEngine.setScripts(config.scripts);
    broadcastConfigChanged();
    return { ok: true };
  });

  app.post('/api/scripts/:id/run', async (req, reply) => {
    const actor = requireAuth(req, reply, 'operator');
    if (!actor) return;
    const result = await scriptEngine.runScript((req.params as { id: string }).id);
    auditLog(actor, 'script.run', `${(req.params as { id: string }).id}: ${result.ok ? '成功' : '失败 ' + (result.error ?? '')}`);
    return result;
  });

  app.get('/api/scripts/:id/output', async (req) => ({
    output: scriptEngine.getOutputs((req.params as { id: string }).id).slice(-20),
  }));

  // ===== 改密 / 会话管理（认证加固）=====
  app.post('/api/auth/change-password', async (req, reply) => {
    const user = requireAuth(req, reply, 'operator');
    if (!user) return;
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return reply.code(400).send({ ok: false, error: '新口令至少 6 位' });
    }
    const target = authStore.findUser(user.id);
    if (!target || !authStore.verifyUserPassword(target, oldPassword)) {
      return reply.code(400).send({ ok: false, error: '旧口令错误' });
    }
    authStore.changePassword(user.id, newPassword);
    persist();
    auditLog(user, 'password.change', `${user.username} 修改口令`);
    return { ok: true };
  });

  app.get('/api/auth/sessions', async (req, reply) => {
    if (!requireAuth(req, reply, 'admin')) return;
    return authStore.listSessions();
  });

  app.delete('/api/auth/sessions/:token', async (req, reply) => {
    if (!requireAuth(req, reply, 'admin')) return;
    return { ok: authStore.kickSession((req.params as { token: string }).token) };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[gateway] REST+WS listening on http://0.0.0.0:${PORT}  (ws://localhost:${PORT}/ws)`);
  console.log(`[gateway] channels: ${config.channels.length}, tags: ${config.tags.length}, storage: ${storage.status.state}`);

  const shutdown = async (): Promise<void> => {
    northboundPublisher.stop();
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
