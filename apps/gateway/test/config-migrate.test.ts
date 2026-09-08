import { describe, it, expect } from 'vitest';
import { migrateConfig, SCHEMA_VERSION, type GatewayConfig } from '../src/config';

const minimalV1 = {
  channels: [{ id: 'c1', name: 'T', protocol: 'Modbus TCP', host: '127.0.0.1', port: 502, enabled: true, pollIntervalMs: 1000, params: {} }],
  tags: [],
} as unknown as GatewayConfig;

describe('config schemaVersion 迁移（C 组运维）', () => {
  it('v1（无版本字段）→ v2：补版本、配方 version、各可选段', () => {
    const out = migrateConfig(JSON.parse(JSON.stringify(minimalV1)));
    expect(out.schemaVersion).toBe(SCHEMA_VERSION);
    expect(out.schemaVersion).toBe(2);
    expect(out.alarms).toEqual([]);
    expect(out.notifications).toBeTruthy();
    expect(out.users).toBeTruthy();
    expect(out.scripts).toBeTruthy();
    expect(out.northbound?.url).toBe('mqtt://127.0.0.1:1883');
  });

  it('已有配方的 version 尊重现状，缺失补 1', () => {
    const cfg = JSON.parse(JSON.stringify(minimalV1)) as GatewayConfig;
    cfg.recipes = [
      { id: 'r1', name: 'A', description: '', items: [], updatedAt: 1 }, // 无 version
      { id: 'r2', name: 'B', description: '', items: [], updatedAt: 1, version: 3 }, // 已有
    ];
    const out = migrateConfig(cfg);
    expect(out.recipes?.[0].version).toBe(1);
    expect(out.recipes?.[1].version).toBe(3);
  });

  it('已是 v2 的配置幂等迁移', () => {
    const once = migrateConfig(JSON.parse(JSON.stringify(minimalV1)));
    const twice = migrateConfig(JSON.parse(JSON.stringify(once)));
    expect(twice.schemaVersion).toBe(2);
    expect(twice).toEqual(once);
  });

  it('v2 配置的用户/北向字段保留不被默认覆盖', () => {
    const cfg = JSON.parse(JSON.stringify(minimalV1)) as GatewayConfig;
    cfg.users = [{ id: 'u1', username: 'op', passwordHash: 'x', role: 'operator', createdAt: 1 }];
    cfg.northbound = { enabled: true, url: 'mqtt://broker:1883', groupId: 'G', edgeNodeId: 'E', dataFlushMs: 500 };
    const out = migrateConfig(cfg);
    expect(out.users?.[0].username).toBe('op');
    expect(out.northbound?.enabled).toBe(true);
    expect(out.northbound?.url).toBe('mqtt://broker:1883');
  });
});
