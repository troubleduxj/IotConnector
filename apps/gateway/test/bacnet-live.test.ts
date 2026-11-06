import { describe, expect, it } from 'vitest';
import { BacnetDriver } from '../src/engine/drivers/bacnet';
import type { Channel, Tag } from '@iotconnector/shared';

describe('BACnet ProtoForge demo live regression', () => {
	it.runIf(process.env.BACNET_LIVE_TEST === '1')('reads AI/AO/BI and writes AO', async () => {
    const samples: Record<string, number | string | boolean> = {};
    const statuses: string[] = [];
    const channel = { id: 'bacnet-live', protocol: 'BACnet/IP', host: process.env.BACNET_HOST ?? '127.0.0.1', port: Number(process.env.BACNET_PORT ?? 47808), pollIntervalMs: 500, params: {} } as Channel;
    const tags = [
      { id: 'ai1', address: 'AI:1', dataType: 'Float32' },
      { id: 'ao1', address: 'AO:1', dataType: 'Float32' },
      { id: 'bi1', address: 'BI:1', dataType: 'Bool' },
    ] as Tag[];
    const driver = new BacnetDriver({ channel, tags, publish: (id, value) => { samples[id] = value; }, setStatus: (state) => { statuses.push(state); } });
    await driver.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await driver.write(tags[1], 30.5);
    await driver.stop();
    expect(Object.keys(samples)).toEqual(expect.arrayContaining(['ai1', 'ao1', 'bi1']));
    expect(statuses).toContain('online');
  });
});
