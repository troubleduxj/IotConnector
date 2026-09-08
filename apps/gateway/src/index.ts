import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { ClientMessage, ServerMessage } from '@iotconnector/shared';
import fs from 'node:fs';
import path from 'node:path';
import type { AlarmEvent, AlarmRule, Channel, NotificationConfig, Tag } from '@iotconnector/shared';
import { PROTOCOL_CONFIGS, validateAddress, validateChannelParams } from '@iotconnector/shared';
import { Engine } from './engine/engine';
import { loadConfig, saveConfig, seedConfig, type GatewayConfig } from './config';
import { AlarmEngine } from './alarms';
import { getFrames, clearFrames } from './diagnostics';
import { dispatchAlarm, sendTestMessage } from './notify';
import { testChannel, type S7ProbeItem } from './engine/testers';
import { channelCommStats } from './engine/stats';
import { toNodes7Address } from './engine/drivers/s7';
import { StorageTaskEngine, sanitizeTable } from './storage-tasks';
import { appendJsonl } from './jsonl';
import { ScriptEngine } from './scripts';
import type { Recipe, RecipeDownloadRecord, Script, StorageTask } from '@iotconnector/shared';
import type { NorthboundConfig } from './northbound/publisher';
import { NorthboundPublisher } from './northbound/publisher';
import { DeviceShadow } from './northbound/shadow';
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
      appendJsonl(AUDIT_FILE, JSON.stringify({ ts: Date.now(), user: user.username, role: user.role, action, detail }) + '\n');
    } catch {
      /* 审计失败不阻塞业务 */
    }
  };
  let notifications: NotificationConfig = config.notifications ?? {
    enabled: false, webhookUrl: '',
    dingtalk: { enabled: false, webhookUrl: '', secret: '' },
    wecom: { enabled: false, webhookUrl: '' },
    email: { enabled: false, host: '', port: 465, username: '', password: '', to: '', secure: true },
  };
  config.notifications = notifications;

  // 告警事件持久化：JSONL 追加（启动恢复）+ TDengine 审计表（可查询，best-effort）
  const ALARM_FILE = path.resolve(process.cwd(), 'data', 'alarms.jsonl');
  const persistAlarmEvent = (event: AlarmEvent): void => {
    try {
      appendJsonl(ALARM_FILE, JSON.stringify(event) + '\n');
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
  let northbound: NorthboundConfig = config.northbound ?? {
    enabled: false, url: 'mqtt://127.0.0.1:1883', groupId: 'Factory', edgeNodeId: 'FB_Edge_GW01', dataFlushMs: 1000,
  };
  config.northbound = northbound; // 挂回 config：PUT 修改的是同一引用，persist 才能落盘（重启不丢）
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
  // B5 北向 CMD 下发：位号名（或 通道.位号 双写名）匹配 → 写管道 + 影子期望值
  northboundPublisher.onCommand = async (metricName, value) => {
    const tag = tags.find((t) => t.name === metricName)
      ?? tags.find((t) => {
        const ch = channels.find((c) => c.id === t.channelId);
        return ch ? `${ch.name}.${t.name}` === metricName : false;
      });
    if (!tag) return { ok: false, error: `位号不存在: ${metricName}` };
    const r = await engine.write(tag.id, value);
    if (r.ok) deviceShadow.setDesired(tag.id, value, 'northbound');
    return r;
  };

  // ===== 设备影子（FR-M9-04 / TASKS #22）=====
  const deviceShadow = new DeviceShadow({
    path: path.join(STATE_DIR, 'shadow.json'),
    read: (p) => fs.readFileSync(p, 'utf-8'),
    write: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    },
  });
  deviceShadow.loadPersisted();
  // 影子变化 → 节流 3s 发布 MQTT retain 快照（断线自动入 Outbox）
  let shadowPublishTimer: NodeJS.Timeout | undefined;
  deviceShadow.onChange = () => {
    if (shadowPublishTimer) return;
    shadowPublishTimer = setTimeout(() => {
      shadowPublishTimer = undefined;
      void northboundPublisher.publishShadow(deviceShadow.snapshot((id) => {
        const tg = tags.find((x) => x.id === id);
        return tg ? { name: tg.name, channel: channels.find((c) => c.id === tg.channelId)?.name ?? tg.channelId } : undefined;
      })).catch(() => undefined);
    }, 3000);
  };

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

  const storageTaskEngine = new StorageTaskEngine(storage, getValue, getTag, process.env.TDENGINE_DB ?? 'factory_bridge', () => tags);
  storageTaskEngine.sync(config.storageTasks ?? []);

  const scriptEngine = new ScriptEngine(
    (key) => getValue(tags.find((t) => t.name === key || t.id === key)?.id ?? key),
    (key) => tags.find((t) => t.name === key || t.id === key),
    async (tagId, value) => {
      const r = await engine.write(tagId, value);
      if (r.ok) deviceShadow.setDesired(tagId, value, 'script'); // 影子期望值（FR-M9-04，脚本来源）
      if (!r.ok) throw new Error(r.error);
    },
  );
  // FR-M8-06 崩溃自动禁用：连续失败达阈值 → 停用脚本、落配置、审计
  scriptEngine.onAutoDisable = (id, reason) => {
    const s = (config.scripts ?? []).find((x) => x.id === id);
    if (!s || !s.enabled) return;
    s.enabled = false;
    persist();
    scriptEngine.setScripts(config.scripts);
    broadcastConfigChanged();
    auditLog({ id: 'system', username: 'system', role: 'admin' }, 'script.autoDisable', `${s.name}：${reason}`);
  };
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
      northbound: config.northbound,
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
    // 设备影子 reported（FR-M9-04）：随采集批次更新
    for (const v of values) deviceShadow.setReported(v.id, v.value, v.quality, v.ts);
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
    const actor = requireAuth(req, reply, 'operator');
    if (!actor) return;
    const { value } = (req.body ?? {}) as { value?: number | string | boolean };
    if (value === undefined) return reply.code(400).send({ ok: false, error: 'body.value required' });
    const id = (req.params as { id: string }).id;
    const tag = getTag(id);
    const prev = engine.snapshot().find((s) => s.id === id)?.value;
    const result = await engine.write(id, value);
    if (result.ok) deviceShadow.setDesired(id, value, actor.username); // 影子期望值（FR-M9-04）
    // FR-M5-03 写入审计：谁、何时、哪个位号、旧值→新值、结果
    auditLog(actor, 'tag.write', `${tag?.name ?? id}: ${String(prev ?? '—')} → ${String(value)}${result.ok ? '' : ' 失败 ' + (result.error ?? '')}`);
    return result;
  });

  // 设备影子（FR-M9-04）：全量快照（reported vs desired）
  app.get('/api/shadow', async () => {
    const meta = (id: string) => {
      const tg = tags.find((x) => x.id === id);
      return tg ? { name: tg.name, channel: channels.find((c) => c.id === tg.channelId)?.name ?? tg.channelId } : undefined;
    };
    return { shadows: deviceShadow.snapshot(meta), pending: deviceShadow.pendingCount(meta) };
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
    // 目标 ~150 点，吸附到常用粒度；桶数上限保护（#存储优化2：防 interval=1 查 30 天打爆网关/库）
    const AUTO_STEPS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const MAX_BUCKETS = 10_000;
    const rawSec = (end - start) / 1000 / 150;
    let intervalSec = q.interval
      ? Math.max(1, Number(q.interval))
      : AUTO_STEPS.find((s) => s >= rawSec) ?? Math.ceil(rawSec);
    const minSecForCap = Math.ceil((end - start) / 1000 / MAX_BUCKETS);
    if (intervalSec < minSecForCap) intervalSec = minSecForCap;

    const db = process.env.TDENGINE_DB ?? 'factory_bridge';
    const stable = process.env.TDENGINE_STABLE ?? 'st_factory_equipment';

    const series: Array<
      { tagId: string; error: string } | {
        tagId: string; name: string; unit: string; dataType: string;
        engMin: number | null; engMax: number | null; intervalSec: number;
        points: Array<{ t: string; avg: number; min: number; max: number; n: number }>;
        stats: { min: number | null; max: number | null; avg: number | null; stdDev: number | null; count: number };
      }
    > = [];
    const known = tagIds.map((id) => ({ id, tag: getTag(id) })).filter((x): x is { id: string; tag: Tag } => Boolean(x.tag));
    for (const id of tagIds) {
      if (!known.some((x) => x.id === id)) series.push({ tagId: id, error: 'unknown tag' });
    }

    // #存储优化2：单条 SQL 取回全部位号（PARTITION BY tag_name），8 位号从 16 条 REST SQL 合并为 2 条
    const names = known.map((x) => x.tag.name.replace(/'/g, "''"));
    const seriesByTag = new Map<string, (typeof series)[number]>();
    if (known.length > 0) {
      const whereAll = `WHERE tag_name IN (${names.map((n) => `'${n}'`).join(',')}) AND ts >= ${start} AND ts <= ${end}`;
      const [agg, stats] = await Promise.all([
        storage.query(
          `SELECT _wstart, tag_name, AVG(val), MIN(val), MAX(val), COUNT(*) FROM ${db}.${stable} ${whereAll} ` +
            `INTERVAL(${intervalSec}s) PARTITION BY tag_name`,
        ),
        storage.query(
          `SELECT tag_name, MIN(val), MAX(val), AVG(val), STDDEV(val), COUNT(*) FROM ${db}.${stable} ${whereAll} GROUP BY tag_name`,
        ),
      ]);
      if (agg.code === 0 && stats.code === 0) {
        const pointsByTag = new Map<string, Array<{ t: string; avg: number; min: number; max: number; n: number }>>();
        for (const row of (agg.data ?? []) as Array<[number, string, number, number, number, number]>) {
          const [t, tn, avg, min, max, n] = row;
          const list = pointsByTag.get(String(tn)) ?? [];
          list.push({ t: new Date(t).toISOString(), avg, min, max, n });
          pointsByTag.set(String(tn), list);
        }
        for (const row of (stats.data ?? []) as Array<[string, number, number, number, number, number]>) {
          const [tn, min, max, avg, stdDev, count] = row;
          const item = known.find((x) => x.tag.name === tn);
          if (!item) continue;
          const entry = {
            tagId: item.id,
            name: item.tag.name,
            unit: item.tag.unit,
            dataType: item.tag.dataType, // Bool: val 已编码 0/1，前端解码显示
            engMin: item.tag.engMin ?? null,
            engMax: item.tag.engMax ?? null,
            intervalSec,
            points: pointsByTag.get(tn) ?? [],
            stats: { min, max, avg, stdDev, count },
          };
          seriesByTag.set(item.id, entry);
        }
        // 统计行缺失但聚合行存在的位号（理论上不发生）兜底：仅点集
        for (const [tn, pts] of pointsByTag) {
          const item = known.find((x) => x.tag.name === tn);
          if (!item || seriesByTag.has(item.id)) continue;
          seriesByTag.set(item.id, {
            tagId: item.id, name: item.tag.name, unit: item.tag.unit, dataType: item.tag.dataType,
            engMin: item.tag.engMin ?? null, engMax: item.tag.engMax ?? null,
            intervalSec, points: pts,
            stats: { min: null, max: null, avg: null, stdDev: null, count: 0 },
          });
        }
      } else {
        // 合并查询失败（老版本语法差异等）→ 退回逐位号查询
        console.error(`[history] merged query failed (agg ${agg.code}/${agg.msg ?? ''}, stats ${stats.code}/${stats.msg ?? ''}), falling back`);
      }
    }

    for (const x of known) {
      const merged = seriesByTag.get(x.id);
      if (merged) {
        series.push(merged);
        continue;
      }
      // 逐位号回退路径（与旧实现一致）
      const tag = x.tag;
      const tn = tag.name.replace(/'/g, "''");
      const where = `WHERE tag_name='${tn}' AND ts >= ${start} AND ts <= ${end}`;
      const agg = await storage.query(
        `SELECT _wstart, AVG(val), MIN(val), MAX(val), COUNT(*) FROM ${db}.${stable} ${where} INTERVAL(${intervalSec}s)`,
      );
      const stats = await storage.query(
        `SELECT MIN(val), MAX(val), AVG(val), STDDEV(val), COUNT(*) FROM ${db}.${stable} ${where}`,
      );
      if (agg.code !== 0) {
        series.push({ tagId: x.id, error: agg.msg ?? `TDengine error ${agg.code}` });
        continue;
      }
      const points = (agg.data ?? []).map((row) => {
        const [t, avg, min, max, n] = row as [number, number, number, number, number];
        return { t: new Date(t).toISOString(), avg, min, max, n };
      });
      const s = (stats.data?.[0] ?? []) as number[];
      series.push({
        tagId: x.id,
        name: tag.name,
        unit: tag.unit,
        dataType: tag.dataType,
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
    auditLog(actor, 'channel.create', `${channel.name} (${channel.protocol} ${channel.host}:${channel.port})`);
    return reply.code(201).send(channel);
  });

  app.put('/api/channels/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const channel = channels.find((c) => c.id === (req.params as { id: string }).id);
    if (!channel) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const b = (req.body ?? {}) as Partial<Channel>;
    const changes: string[] = [];
    if (b.name !== undefined) { channel.name = b.name; changes.push(`name=${b.name}`); }
    if (b.host !== undefined) { channel.host = b.host; changes.push(`host=${b.host}`); }
    if (b.port !== undefined) { channel.port = Number(b.port); changes.push(`port=${b.port}`); }
    if (b.enabled !== undefined) { channel.enabled = Boolean(b.enabled); changes.push(`enabled=${b.enabled}`); }
    if (b.pollIntervalMs !== undefined) { channel.pollIntervalMs = Number(b.pollIntervalMs); changes.push(`period=${b.pollIntervalMs}ms`); }
    if (b.params !== undefined) { channel.params = b.params; changes.push('params'); }
    persist();
    void engine.reloadChannel(channel.id);
    broadcastConfigChanged();
    auditLog(actor, 'channel.update', `${channel.name}: ${changes.join(' ') || '(无变更)'}`);
    return channel;
  });

  // 通道配置导出（FR-M2-05）：JSON 下载，含通道全部参数与点位表
  app.get('/api/channels/:id/export', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const channel = channels.find((c) => c.id === (req.params as { id: string }).id);
    if (!channel) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const bundle = {
      format: 'factorybridge-channel@1',
      exportedAt: new Date().toISOString(),
      channel,
      tags: tags.filter((tg) => tg.channelId === channel.id),
    };
    auditLog(actor, 'channel.export', `${channel.name}（${bundle.tags.length} 点位）`);
    return reply
      .header('content-disposition', `attachment; filename="${channel.name.replace(/[^A-Za-z0-9_-]/g, '_')}.channel.json"`)
      .send(bundle);
  });

  // 通道配置导入（FR-M2-05）：协议参数 schema 校验 + 点位地址语法校验，id 冲突自动重发
  app.post('/api/channels/import', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as { channel?: Partial<Channel>; tags?: Array<Partial<Tag>> };
    const src = b.channel;
    if (!src?.name || !src?.protocol) return reply.code(400).send({ ok: false, error: 'channel.name & channel.protocol required' });
    if (!(src.protocol in PROTOCOL_CONFIGS)) return reply.code(400).send({ ok: false, error: `未知协议: ${src.protocol}` });
    const dup = channels.find((c) => c.name === src.name && c.id !== src.id);
    if (dup) return reply.code(409).send({ ok: false, error: `通道名已存在: ${src.name}` });
    const params = (src.params ?? {}) as Channel['params'];
    const pv = validateChannelParams(src.protocol, params as Record<string, unknown>);
    if (!pv.ok) return reply.code(400).send({ ok: false, error: '协议参数校验失败', details: pv.errors });
    const port = Number(src.port ?? 502);
    if (!src.host || Number.isNaN(port) || port < 1 || port > 65535) {
      return reply.code(400).send({ ok: false, error: 'host/port 非法（port 1~65535）' });
    }
    // 点位地址按协议语法预校验
    const tagErrors: string[] = [];
    for (const tg of b.tags ?? []) {
      if (!tg.name || !tg.address) { tagErrors.push(`点位缺 name/address: ${tg.name ?? '?'}`); continue; }
      const av = validateAddress(src.protocol, tg.address);
      if (!av.ok) tagErrors.push(`${tg.name}: ${av.error ?? '地址非法'}`);
    }
    if (tagErrors.length > 0) return reply.code(400).send({ ok: false, error: '点位地址校验失败', details: tagErrors.slice(0, 20) });

    const channel: Channel = {
      id: channels.some((c) => c.id === src.id) ? `ch_${Date.now()}` : (src.id ?? `ch_${Date.now()}`),
      name: src.name,
      protocol: src.protocol,
      host: src.host,
      port,
      enabled: src.enabled ?? true,
      pollIntervalMs: Math.max(50, Number(src.pollIntervalMs ?? 1000)),
      params,
    };
    channels.push(channel);
    let n = 0;
    for (const tg of b.tags ?? []) {
      tags.push({
        id: `tg_${Date.now()}_${n}`,
        channelId: channel.id,
        name: tg.name!,
        address: tg.address!,
        dataType: tg.dataType ?? 'Float',
        unit: tg.unit ?? '',
        scale: Number(tg.scale ?? 1),
        offset: Number(tg.offset ?? 0),
        engMin: tg.engMin,
        engMax: tg.engMax,
        description: tg.description,
      });
      n += 1;
    }
    persist();
    void engine.reloadChannel(channel.id);
    broadcastConfigChanged();
    auditLog(actor, 'channel.import', `${channel.name} (${channel.protocol} ${channel.host}:${channel.port}) + ${n} 点位`);
    return reply.code(201).send({ channel, importedTags: n });
  });

  // 真实连接测试（FR-M2-04）：临时连接执行协议握手序列，不干扰采集驱动
  app.post('/api/channels/:id/test', async (req, reply) => {
    if (!requireAuth(req, reply, 'engineer')) return;
    const channel = channels.find((c) => c.id === (req.params as { id: string }).id);
    if (!channel) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const channelTagList = tags.filter((t) => t.channelId === channel.id);
    // #15 S7 多位号探针：通道全部位号（上限 8）一次性批量读回
    let s7Probes: S7ProbeItem[] | undefined;
    let opcProbe: string | undefined;
    if (channel.protocol === 'Siemens Profinet' && channelTagList.length > 0) {
      const probes: S7ProbeItem[] = [];
      for (const tg of channelTagList.slice(0, 8)) {
        try {
          probes.push({ name: `probe_${probes.length}`, nodes7Addr: toNodes7Address(tg.address), addrLabel: tg.address });
        } catch {
          /* 单个地址不可解析则跳过 */
        }
      }
      if (probes.length > 0) s7Probes = probes;
    }
    if (channel.protocol === 'OPC UA' && channelTagList[0]) opcProbe = channelTagList[0].address;
    const rawProbe = ['Mitsubishi MELSEC', 'Omron FINS', 'EtherNet/IP (Rockwell)', 'SNMP', 'MQTT / Sparkplug B', 'BACnet/IP', 'IEC 60870-5-104'].includes(channel.protocol)
      ? channelTagList[0]?.address // SNMP：探针 OID；MQTT：探针订阅主题
      : undefined;
    const result = await testChannel(channel, s7Probes, opcProbe, rawProbe);
    return result;
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const id = (req.params as { id: string }).id;
    const i = channels.findIndex((c) => c.id === id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'channel not found' });
    const name = channels[i].name;
    channels.splice(i, 1);
    const kept = tags.filter((t) => t.channelId !== id);
    const removedCount = tags.length - kept.length;
    for (const t of tags) if (t.channelId === id) deviceShadow.clearTag(t.id); // 影子残留修剪
    tags.splice(0, tags.length, ...kept);
    alarmEngine.setRules(alarmEngine.getRules().filter((r) => kept.some((t) => t.id === r.tagId)));
    persist();
    await engine.removeChannel(id);
    broadcastConfigChanged();
    auditLog(actor, 'channel.delete', `${name}（含 ${removedCount} 位号）`);
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
    auditLog(actor, 'tag.create', `${tag.name} (${tag.address} ${tag.dataType})`);
    return reply.code(201).send(tag);
  });

  app.put('/api/tags/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const tag = getTag((req.params as { id: string }).id);
    if (!tag) return reply.code(404).send({ ok: false, error: 'tag not found' });
    const b = (req.body ?? {}) as Partial<Tag>;
    const changes: string[] = [];
    if (b.name !== undefined) { tag.name = b.name; changes.push(`name=${b.name}`); }
    if (b.address !== undefined) { tag.address = b.address; changes.push(`addr=${b.address}`); }
    if (b.dataType !== undefined) { tag.dataType = b.dataType; changes.push(`type=${b.dataType}`); }
    if (b.unit !== undefined) { tag.unit = b.unit; changes.push(`unit=${b.unit}`); }
    if (b.scale !== undefined) { tag.scale = Number(b.scale); changes.push(`scale=${b.scale}`); }
    if (b.offset !== undefined) { tag.offset = Number(b.offset); changes.push(`offset=${b.offset}`); }
    if (b.engMin !== undefined) { tag.engMin = b.engMin === null ? undefined : Number(b.engMin); changes.push(`engMin=${b.engMin}`); }
    if (b.engMax !== undefined) { tag.engMax = b.engMax === null ? undefined : Number(b.engMax); changes.push(`engMax=${b.engMax}`); }
    if (b.description !== undefined) { tag.description = b.description; changes.push('desc'); }
    persist();
    engine.upsertTagRuntime(tag);
    void engine.reloadChannel(tag.channelId);
    broadcastConfigChanged();
    auditLog(actor, 'tag.update', `${tag.name}: ${changes.join(' ') || '(无变更)'}`);
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
    deviceShadow.clearTag(id); // 影子残留修剪（FR-M9-04）
    void engine.reloadChannel(tag.channelId);
    broadcastConfigChanged();
    auditLog(actor, 'tag.delete', `${tag.name} (${tag.address})`);
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
      reference: b.reference === undefined ? undefined : Number(b.reference),
      hysteresis: Math.max(0, Number(b.hysteresis ?? 0)),
      enabled: b.enabled ?? true,
      message: b.message,
    };
    alarmEngine.upsertRule(rule);
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'alarm.create', `${getTag(rule.tagId)?.name ?? rule.tagId} ${rule.kind}>${rule.threshold}`);
    return reply.code(201).send(rule);
  });

  app.put('/api/alarms/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const rule = alarmEngine.getRules().find((r) => r.id === (req.params as { id: string }).id);
    if (!rule) return reply.code(404).send({ ok: false, error: 'alarm rule not found' });
    const b = (req.body ?? {}) as Partial<AlarmRule>;
    const changes: string[] = [];
    if (b.kind !== undefined) { rule.kind = b.kind; changes.push(`kind=${b.kind}`); }
    if (b.threshold !== undefined) { rule.threshold = Number(b.threshold); changes.push(`threshold=${b.threshold}`); }
    if (b.reference !== undefined) { rule.reference = b.reference === null ? undefined : Number(b.reference); changes.push(`ref=${b.reference}`); }
    if (b.hysteresis !== undefined) { rule.hysteresis = Math.max(0, Number(b.hysteresis)); changes.push(`hyst=${b.hysteresis}`); }
    if (b.enabled !== undefined) { rule.enabled = Boolean(b.enabled); changes.push(`enabled=${b.enabled}`); }
    if (b.message !== undefined) { rule.message = b.message; changes.push('message'); }
    alarmEngine.upsertRule(rule);
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'alarm.update', `${getTag(rule.tagId)?.name ?? rule.tagId}: ${changes.join(' ') || '(无变更)'}`);
    return rule;
  });

  app.delete('/api/alarms/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const id = (req.params as { id: string }).id;
    const rule = alarmEngine.getRules().find((r) => r.id === id);
    if (!rule) return reply.code(404).send({ ok: false, error: 'alarm rule not found' });
    alarmEngine.removeRule(id);
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'alarm.delete', `${getTag(rule.tagId)?.name ?? rule.tagId} ${rule.kind}>${rule.threshold}`);
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
    auditLog(actor, 'notify.update', `enabled=${notifications.enabled} webhook=${notifications.webhookUrl || '(空)'}`);
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
    // #12 消息模板（空串归一为 undefined → 使用默认模板）
    notifications.titleTemplate = b.titleTemplate?.trim() || undefined;
    notifications.bodyTemplate = b.bodyTemplate?.trim() || undefined;
    persist();
    const chans = [
      notifications.webhookUrl && 'webhook',
      notifications.dingtalk?.enabled && 'dingtalk',
      notifications.wecom?.enabled && 'wecom',
      notifications.email?.enabled && 'email',
    ].filter(Boolean).join('+') || '(无渠道)';
    auditLog(actor, 'notify.update', `enabled=${notifications.enabled} 渠道=${chans}${b.titleTemplate !== undefined ? ' 模板已更新' : ''}`);
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

  // ===== 系统级：信息 / WebAPI 文档 / 数据库 / 诊断导出 / 恢复出厂（FR-M9-06/07）=====
  const startedAt = Date.now();

  app.get('/api/system/info', async (req, reply) => {
    if (!requireAuth(req, reply, 'operator')) return;
    return {
      name: 'FactoryBridge Edge Gateway',
      version: '2.4.1',
      startedAt,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      port: PORT,
      storage: {
        url: process.env.TDENGINE_URL ?? '',
        db: process.env.TDENGINE_DB ?? 'factory_bridge',
        state: storage.status.state,
        queued: storage.status.queued,
        written: storage.status.written,
        dropped: storage.status.dropped ?? 0,
      },
      counts: {
        channels: channels.length,
        tags: tags.length,
        alarms: (config.alarms ?? []).length,
        storageTasks: config.storageTasks.length,
        recipes: config.recipes.length,
        scripts: config.scripts.length,
      },
    };
  });

  // OpenAPI 3.0 描述（真实端点清单；UI 提供下载，供第三方集成查阅）
  app.get('/api/system/openapi.json', async (req, reply) => {
    if (!requireAuth(req, reply, 'operator')) return;
    // A3 一致性断言：清单 ↔ 实际路由双向比对（缺失/多余仅告警，不阻断下载）
    checkOpenApiCoverage(app);
    const bearer = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' };
    const json = {
      openapi: '3.0.3',
      info: { title: 'FactoryBridge Edge Gateway REST API', version: '2.4.1' },
      servers: [{ url: `http://<gateway-host>:${PORT}` }],
      components: { securitySchemes: { bearerAuth: bearer } },
      security: [{ bearerAuth: [] }],
      paths: manifestPaths(),
    };
    return reply.header('content-disposition', 'attachment; filename="openapi.json"').send(json);
  });

// ===== OpenAPI 清单一致性（A3 工程质量）：真实路由 ↔ paths 清单双向比对 =====
let openapiWarned = false;

/** 真实路由（app.routes）与清单路径双向比对；不一致时告警一次（防新增端点漏登记） */
function checkOpenApiCoverage(app: unknown): void {
  if (openapiWarned) return;
  openapiWarned = true; // 无论结果只检查一次
  try {
    // Fastify v5 无公开 routes 属性：从 printRoutes() 树文本提取（叶子行含完整路径）
    const tree = (app as { printRoutes?: () => string }).printRoutes?.() ?? '';
    const normalize = (u: string): string => u.replace(/:([A-Za-z_]+)/g, '{$1}');
    const actual = new Set<string>();
    // printRoutes 输出压缩 radix 树：每层缩进 4 字符（'│   '/'    ' 过渡、'├── '/'└── ' 节点标记）
    const stack: string[] = [];
    for (const line of tree.split(String.fromCharCode(10))) {
      let i = 0;
      let depth = 0;
      for (;;) {
        const chunk = line.slice(i, i + 4);
        if (chunk === '│   ' || chunk === '    ') { depth += 1; i += 4; continue; }
        if (chunk === '├── ' || chunk === '└── ' || chunk === '╰── ' || chunk === '╭── ') { depth += 1; i += 4; break; }
        break;
      }
      const text = line.slice(i).trim();
      const m = text.match(/^([^\s(]+)\s*(?:\(([A-Z, ]+)\))?$/);
      if (!m) continue;
      const seg = m[1] ?? '';
      while (stack.length > depth) stack.pop();
      stack[depth] = seg;
      const methods = m[2] ?? '';
      if (!/GET|POST|PUT|DELETE|PATCH/.test(methods)) continue; // 内部节点无方法，仅维护栈
      const full = stack.slice(1, depth + 1).join('');
      if (full.startsWith('/api/') || full === '/ws') actual.add(normalize(full));
    }
    const manifest = new Set(Object.keys(manifestPaths()));
    const missing = [...actual].filter((u) => !manifest.has(u)).sort(); // 已注册未登记
    const stale = [...manifest].filter((u) => !actual.has(u)).sort();   // 已登记未注册
    if (missing.length > 0) {
      console.warn(`[openapi] 未登记进清单的真实路由 (${missing.length}):\n  ${missing.join('\n  ')}`);
    }
    if (stale.length > 0) {
      console.warn(`[openapi] 清单中已不存在的路由 (${stale.length}):\n  ${stale.join('\n  ')}`);
    }
    if (missing.length === 0 && stale.length === 0) {
      console.log(`[openapi] 一致性 OK：${actual.size} 路由 ↔ ${manifest.size} 清单路径`);
    }
  } catch (e) {
    console.warn(`[openapi] 一致性检查异常: ${String(e)}`);
  }
}

/** OpenAPI paths 清单（单一数据源：openapi.json 输出与一致性断言共用） */
function manifestPaths(): Record<string, { get?: { summary: string; security?: unknown[] }; post?: { summary: string; security?: unknown[] }; put?: { summary: string }; delete?: { summary: string } }> {
  return {
    '/api/auth/login': { post: { summary: '登录获取 Bearer 令牌', security: [] } },
    '/api/auth/me': { get: { summary: '当前会话用户' } },
    '/api/auth/logout': { post: { summary: '退出登录' } },
    '/api/auth/sessions': { get: { summary: '会话列表（admin）' } },
    '/api/auth/sessions/{token}': { delete: { summary: '踢出会话（admin）' } },
    '/api/auth/change-password': { post: { summary: '修改口令' } },
    '/api/tags': { get: { summary: '位号配置列表' } },
    '/api/config': { get: { summary: '全量配置（通道/位号/任务/配方/脚本）' } },
    '/api/health': { get: { summary: '存活探针' } },
    '/api/tags/live': { get: { summary: '位号实时值快照' } },
    '/api/shadow': { get: { summary: '设备影子快照（reported vs desired，FR-M9-04）' } },
    '/api/tags/{id}/write': { post: { summary: '下行写值（审计留痕）' } },
    '/api/tags/{id}': { put: { summary: '更新位号' }, delete: { summary: '删除位号' } },
    '/api/history': { get: { summary: '历史查询（TDengine 聚合）' } },
    '/api/alarms': { get: { summary: '告警事件' }, post: { summary: '新建告警规则' } },
    '/api/alarms/events/{id}/ack': { post: { summary: '告警事件确认（备注）' } },
    '/api/alarms/{id}': { put: { summary: '更新告警规则' }, delete: { summary: '删除告警规则' } },
    '/api/alarms/history': { get: { summary: '告警历史（TDengine 审计表）' } },
    '/api/channels': { get: { summary: '通道列表' }, post: { summary: '新建通道' } },
    '/api/channels/{id}': { put: { summary: '更新通道（热重载）' }, delete: { summary: '删除通道' } },
    '/api/channels/{id}/test': { post: { summary: '真实连接测试（分步握手）' } },
    '/api/channels/{id}/frames': { get: { summary: '报文诊断帧（最近 N 条）' } },
    '/api/channels/{id}/export': { get: { summary: '通道配置导出（JSON）' } },
    '/api/channels/import': { post: { summary: '通道配置导入' } },
    '/api/storage-tasks': { get: { summary: '存储任务' }, post: { summary: '新建存储任务' } },
    '/api/storage-tasks/stats': { get: { summary: '任务运行状态（写入/速率/错误）' } },
    '/api/storage-tasks/{id}': { put: { summary: '更新存储任务' }, delete: { summary: '删除存储任务' } },
    '/api/recipes': { get: { summary: '配方列表' }, post: { summary: '新建配方' } },
    '/api/recipes/{id}/download': { post: { summary: '配方下发到设备' } },
    '/api/recipes/downloads': { get: { summary: '配方下发记录（FR-M6-04）' } },
    '/api/recipes/{id}/duplicate': { post: { summary: '复制配方（FR-M6-04）' } },
    '/api/recipes/{id}/export': { get: { summary: '配方导出 JSON（FR-M6-04）' } },
    '/api/recipes/import': { post: { summary: '配方导入（FR-M6-04）' } },
    '/api/recipes/{id}': { put: { summary: '更新配方（参数变更版本 +1）' }, delete: { summary: '删除配方' } },
    '/api/scripts': { get: { summary: '边缘脚本' }, post: { summary: '新建脚本' } },
    '/api/scripts/{id}/run': { post: { summary: '试运行脚本' } },
    '/api/scripts/{id}/output': { get: { summary: '脚本输出（环形缓冲）' } },
    '/api/scripts/{id}': { put: { summary: '更新脚本' }, delete: { summary: '删除脚本' } },
    '/api/scheduler': { get: { summary: '调度统计（采样/通讯/周期延迟）' } },
    '/api/scheduler/rebalance': { post: { summary: '通道相位错开重均衡' } },
    '/api/audit': { get: { summary: '审计日志（admin）' } },
    '/api/notifications': { put: { summary: '通知配置' } },
    '/api/notifications/v2': { put: { summary: '通知配置（四渠道全量）' } },
    '/api/notifications/test': { post: { summary: '渠道测试消息' } },
    '/api/northbound': { get: { summary: '北向 MQTT 配置与状态' }, put: { summary: '更新北向配置' } },
    '/api/northbound/rebirth': { post: { summary: 'REBIRTH 重发 BIRTH' } },
    '/api/system/info': { get: { summary: '系统信息（版本/存储/规模）' } },
    '/api/system/openapi.json': { get: { summary: 'OpenAPI 3.0 文档' } },
    '/api/system/db-test': { post: { summary: 'TDengine 连通实测' } },
    '/api/system/db-init': { post: { summary: '初始化建库/超级表' } },
    '/api/system/diag': { get: { summary: '诊断导出（审计尾部）' } },
    '/api/system/factory-reset': { post: { summary: '恢复出厂（可选清空 TDengine）' } },
    '/api/system/config-backup': { get: { summary: '全量配置备份下载（B6）' } },
    '/api/system/config-restore': { post: { summary: '全量配置恢复（B6，admin）' } },
    '/api/users': { get: { summary: '用户列表（admin）' }, post: { summary: '创建用户（admin）' } },
    '/api/users/{id}': { put: { summary: '更新用户（admin）' }, delete: { summary: '删除用户（admin）' } },
    '/ws': { get: { summary: 'WebSocket 实时推送（tags-batch / alarms / storage-status）' } },
  };
}

  // TDengine 连通性实测：SELECT SERVER_VERSION() 往返
  app.post('/api/system/db-test', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    if (!storage.enabled) return { ok: false, error: 'TDengine URL 未配置（环境变量 TDENGINE_URL）' };
    const t0 = Date.now();
    try {
      const r = await storage.query('SELECT SERVER_VERSION()');
      if (r.code !== 0) return { ok: false, error: r.msg ?? r.desc ?? `code ${r.code}` };
      return { ok: true, version: String((r.data as unknown[][])?.[0]?.[0] ?? ''), latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  });

  // 初始化数据库（幂等）：CREATE DATABASE IF NOT EXISTS
  app.post('/api/system/db-init', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    if (!storage.enabled) return reply.code(400).send({ ok: false, error: 'TDengine URL 未配置（环境变量 TDENGINE_URL）' });
    const db = (process.env.TDENGINE_DB ?? 'factory_bridge').replace(/[^A-Za-z0-9_]/g, '');
    const r = await storage.query(`CREATE DATABASE IF NOT EXISTS ${db}`);
    auditLog(actor, 'system.db-init', `CREATE DATABASE ${db} → code ${r.code}`);
    return { ok: r.code === 0, code: r.code, error: r.code === 0 ? undefined : (r.msg ?? r.desc ?? `code ${r.code}`) };
  });

  // 诊断包导出：审计尾部 + 运行信息（JSON 下载）
  app.get('/api/system/diag', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    let audit: unknown[] = [];
    try {
      audit = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean).slice(-500).map((l) => JSON.parse(l));
    } catch { /* 无审计文件 */ }
    const bundle = {
      generatedAt: new Date().toISOString(),
      info: {
        version: '2.4.1', startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        node: process.version, platform: `${process.platform}/${process.arch}`,
        counts: { channels: channels.length, tags: tags.length, alarms: (config.alarms ?? []).length },
      },
      audit,
    };
    return reply.header('content-disposition', 'attachment; filename="factorybridge-diag.json"').send(bundle);
  });

  // 恢复出厂：配置全部回种子（账号口令恢复为 账号+123）；需 body.confirm === 'RESET'
  app.post('/api/system/factory-reset', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const { confirm, purgeStorage } = (req.body ?? {}) as { confirm?: string; purgeStorage?: boolean };
    if (confirm !== 'RESET') return reply.code(400).send({ ok: false, error: "body.confirm 必须为 'RESET'" });
    const seed = seedConfig();
    // 原地替换数组内容（引擎/发布器持有同一引用，splice 后即刻生效）
    for (const key of ['channels', 'tags', 'alarms', 'storageTasks', 'recipes', 'scripts'] as const) {
      (config[key] as unknown[]).splice(0, config[key].length, ...(seed[key] as unknown[]));
    }
    Object.assign(notifications, seed.notifications ?? {});
    Object.assign(northbound, seed.northbound ?? {});
    if (seed.users) authStore.setUsers(seed.users);
    saveConfig(config);
    engine.syncConfig(channels, tags);
    storageTaskEngine.sync(config.storageTasks);
    northboundPublisher.applyConfig();
    alarmEngine.setRules(config.alarms ?? []);
    // #存储优化3：可选清空 TDengine 历史/任务/告警表（DROP DATABASE 后按种子任务重建）
    let storagePurged = false;
    let storagePurgeError: string | undefined;
    if (purgeStorage) {
      const r = await storage.recreateSchema();
      storagePurged = r.ok;
      if (!r.ok) storagePurgeError = r.error;
    }
    auditLog(actor, 'system.factory-reset',
      `配置恢复出厂默认（种子账号口令恢复为 账号+123）${purgeStorage ? (storagePurged ? '；TDengine 历史库已清空' : `；清库失败：${storagePurgeError}`) : ''}`);
    return { ok: true, storagePurged, storagePurgeError };
  });


  // ===== B6 全量配置备份 / 恢复（灾备，与恢复出厂对称）=====
  // 快照应用：全量替换运行时配置并同步各引擎（原地 splice 保引用，供广播/发布器使用）
  function applyConfigSnapshot(snap: GatewayConfig): { ok: boolean; error?: string } {
    if (!Array.isArray(snap.channels) || !Array.isArray(snap.tags)) {
      return { ok: false, error: 'snapshot 缺少 channels/tags 数组' };
    }
    for (const key of ['channels', 'tags', 'alarms', 'storageTasks', 'recipes', 'scripts'] as const) {
      const next = snap[key] ?? [];
      (config[key] as unknown[]).splice(0, config[key].length, ...(next as unknown[]));
    }
    if (snap.notifications) Object.assign(notifications, snap.notifications);
    if (snap.northbound) Object.assign(northbound, snap.northbound);
    if (snap.users) authStore.setUsers(snap.users);
    saveConfig(config);
    engine.syncConfig(channels, tags);
    storageTaskEngine.sync(config.storageTasks);
    alarmEngine.setRules(config.alarms ?? []);
    northboundPublisher.applyConfig();
    return { ok: true };
  }

  app.get('/api/system/config-backup', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const payload = {
      format: 'factorybridge-config@1',
      exportedAt: new Date().toISOString(),
      config: JSON.parse(JSON.stringify({ ...config, users: authStore.getUsers() })),
    };
    auditLog(actor, 'system.config-backup', `导出全量配置（${config.channels.length} 通道 / ${config.tags.length} 位号）`);
    return reply
      .header('content-disposition', 'attachment; filename="factorybridge-config.json"')
      .send(payload);
  });

  app.post('/api/system/config-restore', async (req, reply) => {
    const actor = requireAuth(req, reply, 'admin');
    if (!actor) return;
    const b = (req.body ?? {}) as { format?: string; config?: GatewayConfig };
    if (b.format !== 'factorybridge-config@1' || !b.config) {
      return reply.code(400).send({ ok: false, error: 'body.format 必须为 factorybridge-config@1 且含 config' });
    }
    const r = applyConfigSnapshot(b.config);
    if (!r.ok) return reply.code(400).send(r);
    broadcastConfigChanged();
    auditLog(actor, 'system.config-restore', `恢复全量配置（${b.config.channels?.length ?? 0} 通道 / ${b.config.tags?.length ?? 0} 位号）`);
    return { ok: true, counts: { channels: config.channels.length, tags: config.tags.length } };
  });

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
    auditLog(actor, 'northbound.update', `enabled=${northbound.enabled} url=${northbound.url} group=${northbound.groupId} node=${northbound.edgeNodeId}`);
    return { config: northbound, status: northboundPublisher.status };
  });

  app.post('/api/northbound/rebirth', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    northboundPublisher.applyConfig(); // 触发 BIRTH 重发
    auditLog(actor, 'northbound.rebirth', '手动触发 BIRTH 重发');
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
    // 携带 mustChangePassword，使前端刷新/重开页面后仍能恢复强制改密 gate
    return { ...user, mustChangePassword: authStore.findUser(user.id)?.mustChangePassword ?? false };
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
      // 管理员代设初始口令 → 首次登录强制改密
      mustChangePassword: true,
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
    if (b.password) authStore.resetPassword(target.id, b.password);
    if (b.role) target.role = b.role;
    persist();
    auditLog(actor, 'user.update', `${target.username} role=${target.role}${b.password ? ' +password reset' : ''}`);
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
    const q = (req.query ?? {}) as { limit?: string; action?: string; user?: string };
    const limit = Math.min(1000, Math.max(1, Number(q.limit ?? 200)));
    try {
      const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
      let events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      if (q.action) events = events.filter((e) => String(e.action ?? '').startsWith(q.action as string));
      if (q.user) events = events.filter((e) => String(e.user ?? '') === q.user);
      const total = events.length;
      events = events.slice(-limit).reverse();
      return { events, total };
    } catch {
      return { events: [], total: 0 };
    }
  });

  // ===== 告警历史查询（持久化于 TDengine alarm_events）=====
  app.post('/api/alarms/events/:id/ack', async (req, reply) => {
    const actor = requireAuth(req, reply, 'operator');
    if (!actor) return;
    const { note } = (req.body ?? {}) as { note?: string };
    const updated = alarmEngine.ack((req.params as { id: string }).id, actor.username, note);
    if (!updated) return reply.code(404).send({ ok: false, error: 'event not found' });
    auditLog(actor, 'alarm.ack', `${updated.tagName} ${updated.kind}>${updated.threshold}=${updated.value}${note ? `: ${note}` : ''}`);
    broadcast({ type: 'alarm', event: updated });
    return updated;
  });

  // ===== 报文诊断（PRD FR-M2-20）：Modbus/MELSEC/FINS/ENIP 帧级捕获 + 协议解码注解 =====
  app.get('/api/channels/:id/frames', async (req) => {
    const q = (req.query ?? {}) as { limit?: string; dir?: string; clear?: string };
    const id = (req.params as { id: string }).id;
    if (q.clear === '1') clearFrames(id);
    const dir = q.dir === 'TX' || q.dir === 'RX' ? q.dir : undefined;
    return { ok: true, frames: getFrames(id, Math.min(200, Number(q.limit ?? 100)), dir) };
  });

  app.get('/api/alarms/history', async (req, reply) => {
    if (!storage.enabled) {
      return reply.code(503).send({ ok: false, error: 'TDengine storage disabled (TDENGINE_URL not set)', total: 0, events: [] });
    }
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
      const comm = channelCommStats(c.id);
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
        // FR-M2-07 通道级通讯统计
        tx: comm.tx,
        rx: comm.rx,
        err: comm.err,
        timeoutRate: comm.tx > 0 ? Number((comm.err / comm.tx).toFixed(4)) : 0,
        lastCommAt: comm.lastCommAt,
        avgCycleMs: comm.avgCycleMs,
      };
    });
    const totalSamples = perChannel.reduce((sum, c) => sum + c.samples, 0);
    const latencies = perChannel.filter((c) => c.avgCycleMs !== undefined).map((c) => c.avgCycleMs as number);
    return {
      uptimeSec,
      totalSamples,
      rateHz: uptimeSec > 0 ? Number((totalSamples / uptimeSec).toFixed(2)) : 0,
      onlineChannels: perChannel.filter((c) => c.state === 'online').length,
      // FR-M3-04 调度监控：平均周期延迟（有周期上报的通道）
      avgCycleMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : undefined,
      channels: perChannel,
    };
  });

  // FR-M3-03 动态重均衡：以轮转相位重启全部启用通道的采集驱动，
  // 把各通道轮询起点错开（原为启动时刻对齐，易同相突发）。
  app.post('/api/scheduler/rebalance', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const enabled = channels.filter((c) => c.enabled);
    for (const c of enabled) {
      await engine.reloadChannel(c.id);
    }
    auditLog(actor, 'scheduler.rebalance', `重均衡 ${enabled.length} 条通道（相位错开重启）`);
    return { ok: true, reloaded: enabled.length };
  });

  // ===== 存储任务 CRUD（PRD FR-M4-01）=====
  app.get('/api/storage-tasks', async () => config.storageTasks ?? []);

  // FR-M4-06 任务运行状态：写入计数/最近写入/近 1 分钟速率/错误
  app.get('/api/storage-tasks/stats', async () => storageTaskEngine.runtimeStats());

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
    auditLog(actor, 'storage.create', `${task.name} → ${task.tableName}（${task.trigger.mode}）`);
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
    auditLog(actor, 'storage.update', config.storageTasks[i].name);
    return config.storageTasks[i];
  });

  app.delete('/api/storage-tasks/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const { keepTable } = req.query as { keepTable?: string };
    const task = (config.storageTasks ?? []).find((t) => t.id === (req.params as { id: string }).id);
    config.storageTasks = (config.storageTasks ?? []).filter((t) => t.id !== (req.params as { id: string }).id);
    persist();
    storageTaskEngine.sync(config.storageTasks);
    broadcastConfigChanged();
    // #存储优化3：默认同时 DROP 目标表（防止孤儿表无限累积）；?keepTable=1 保留数据
    let tableDropped = false;
    if (task && keepTable !== '1') {
      const drop = await storage.query(`DROP TABLE IF EXISTS ${process.env.TDENGINE_DB ?? 'factory_bridge'}.${sanitizeTable(task.tableName)}`);
      tableDropped = drop.code === 0;
    }
    if (task) auditLog(actor, 'storage.delete', `${task.name} → ${task.tableName}${keepTable === '1' ? '（保留数据表）' : tableDropped ? '（已删数据表）' : '（表删除失败/库离线，稍后可手动清理）'}`);
    return { ok: true, tableDropped };
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
      version: 1, // FR-M6-03 新建版本号为 1
    };
    config.recipes = [...(config.recipes ?? []), recipe];
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'recipe.create', `${recipe.name}（${recipe.items.length} 参数）`);
    return reply.code(201).send(recipe);
  });

  app.put('/api/recipes/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const i = (config.recipes ?? []).findIndex((r) => r.id === (req.params as { id: string }).id);
    if (i < 0) return reply.code(404).send({ ok: false, error: 'recipe not found' });
    const b = (req.body ?? {}) as Partial<Recipe>;
    const prev = config.recipes[i];
    // FR-M6-03 参数集变更才 bump 版本；仅改名称/说明不动版本
    const itemsChanged = b.items !== undefined && JSON.stringify(b.items) !== JSON.stringify(prev.items);
    config.recipes[i] = { ...prev, name: b.name ?? prev.name, description: b.description ?? prev.description, items: b.items ?? prev.items, updatedAt: Date.now(), version: itemsChanged ? (prev.version ?? 1) + 1 : (prev.version ?? 1) };
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'recipe.update', `${config.recipes[i].name}（${config.recipes[i].items.length} 参数）`);
    return config.recipes[i];
  });

  app.delete('/api/recipes/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const recipe = (config.recipes ?? []).find((r) => r.id === (req.params as { id: string }).id);
    config.recipes = (config.recipes ?? []).filter((r) => r.id !== (req.params as { id: string }).id);
    persist();
    broadcastConfigChanged();
    if (recipe) auditLog(actor, 'recipe.delete', recipe.name);
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
      if (r.ok) deviceShadow.setDesired(item.tagId, item.value, actor.username); // 影子期望值（FR-M9-04）
      auditLog(actor, 'recipe.download', `${recipe.name}: ${tag.name} = ${item.value} ${r.ok ? '成功' : '失败 ' + (r.error ?? '')}`);
      results.push({ tagId: item.tagId, name: tag.name, value: item.value, ok: r.ok, error: r.error });
    }
    // FR-M6-04 下发记录：持久化最近 200 条
    const okCount = results.filter((r) => r.ok).length;
    const record: RecipeDownloadRecord = {
      id: `dl_${Date.now()}`,
      recipeId: recipe.id,
      recipeName: recipe.name,
      version: recipe.version ?? 1,
      at: Date.now(),
      by: actor.username,
      ok: okCount === results.length,
      okCount,
      totalCount: results.length,
    };
    config.recipeDownloads = [record, ...(config.recipeDownloads ?? [])].slice(0, 200);
    persist();
    return { ok: record.ok, results };
  });

  // FR-M6-04 下发记录（新→旧）
  app.get('/api/recipes/downloads', async () => config.recipeDownloads ?? []);

  // FR-M6-04 复制配方：同参数集新副本，版本重置为 1
  app.post('/api/recipes/:id/duplicate', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const src = (config.recipes ?? []).find((r) => r.id === (req.params as { id: string }).id);
    if (!src) return reply.code(404).send({ ok: false, error: 'recipe not found' });
    const copy: Recipe = {
      ...JSON.parse(JSON.stringify(src)) as Recipe,
      id: `rcp_${Date.now()}`,
      name: `${src.name} 副本`,
      updatedAt: Date.now(),
      version: 1,
    };
    config.recipes = [...(config.recipes ?? []), copy];
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'recipe.duplicate', `${src.name} → ${copy.name}`);
    return reply.code(201).send(copy);
  });

  // FR-M6-04 配方导出：JSON 下载（参数集按位号名+id 双写，跨网关可导入）
  app.get('/api/recipes/:id/export', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const recipe = (config.recipes ?? []).find((r) => r.id === (req.params as { id: string }).id);
    if (!recipe) return reply.code(404).send({ ok: false, error: 'recipe not found' });
    const bundle = {
      format: 'factorybridge-recipe@1',
      exportedAt: new Date().toISOString(),
      recipe: {
        name: recipe.name,
        description: recipe.description,
        version: recipe.version ?? 1,
        items: recipe.items.map((it) => ({ ...it, tagName: getTag(it.tagId)?.name ?? it.tagId })),
      },
    };
    auditLog(actor, 'recipe.export', `${recipe.name}（v${recipe.version ?? 1}，${recipe.items.length} 参数）`);
    return reply
      .header('content-disposition', `attachment; filename="${recipe.name.replace(/[^A-Za-z0-9_-]/g, '_')}.recipe.json"`)
      .send(bundle);
  });

  // FR-M6-04 配方导入：重名 409；位号按 id 优先匹配，缺 id 按名匹配，均缺则报错明细
  app.post('/api/recipes/import', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const b = (req.body ?? {}) as { recipe?: { name?: string; description?: string; items?: Array<{ tagId?: string; tagName?: string; value?: number | string | boolean }> } };
    const src = b.recipe;
    if (!src?.name) return reply.code(400).send({ ok: false, error: 'recipe.name required' });
    if ((config.recipes ?? []).some((r) => r.name === src.name)) {
      return reply.code(409).send({ ok: false, error: `配方名已存在: ${src.name}` });
    }
    const items: Recipe['items'] = [];
    const errors: string[] = [];
    for (const [i, it] of (src.items ?? []).entries()) {
      const tag = it.tagId ? getTag(it.tagId) : tags.find((tg) => tg.name === it.tagName);
      if (!tag) { errors.push(`第 ${i + 1} 项位号无法匹配: ${it.tagName ?? it.tagId ?? '?'}`); continue; }
      if (it.value === undefined) { errors.push(`第 ${i + 1} 项缺 value`); continue; }
      items.push({ tagId: tag.id, value: it.value });
    }
    if (errors.length > 0) return reply.code(400).send({ ok: false, error: '位号匹配失败', details: errors.slice(0, 20) });
    const recipe: Recipe = {
      id: `rcp_${Date.now()}`,
      name: src.name,
      description: src.description ?? '',
      items,
      updatedAt: Date.now(),
      version: 1,
    };
    config.recipes = [...(config.recipes ?? []), recipe];
    persist();
    broadcastConfigChanged();
    auditLog(actor, 'recipe.import', `${recipe.name}（${items.length} 参数）`);
    return reply.code(201).send(recipe);
  });

  // ===== 边缘脚本 CRUD / 运行 / 输出（决策 D5）=====
  app.get('/api/scripts', async () =>
    (config.scripts ?? []).map((s) => ({
      ...s,
      triggerText: s.trigger.type,
      output: scriptEngine.getOutputs(s.id).slice(-20),
      stats: scriptEngine.getRunStats(s.id), // FR-M8-06 运行监控
    })),
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
    auditLog(actor, 'script.create', `${script.name}（${script.trigger.type}）`);
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
    auditLog(actor, 'script.update', `${config.scripts[i].name}${b.enabled !== undefined ? ` enabled=${b.enabled}` : ''}`);
    return config.scripts[i];
  });

  app.delete('/api/scripts/:id', async (req, reply) => {
    const actor = requireAuth(req, reply, 'engineer');
    if (!actor) return;
    const script = (config.scripts ?? []).find((s) => s.id === (req.params as { id: string }).id);
    config.scripts = (config.scripts ?? []).filter((s) => s.id !== (req.params as { id: string }).id);
    persist();
    scriptEngine.setScripts(config.scripts);
    broadcastConfigChanged();
    if (script) auditLog(actor, 'script.delete', script.name);
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
    deviceShadow.flush();
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
