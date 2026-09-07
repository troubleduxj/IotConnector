import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceShadow, type ShadowFile } from '../src/northbound/shadow';

const memFile = () => {
  let data: unknown;
  return {
    path: 'mem://shadow.json',
    read: (): string => JSON.stringify(data ?? ''),
    write: (_p: string, d: unknown): void => { data = d; },
    dump: (): unknown => data,
  };
};

const meta = (id: string): { name: string; channel: string } | undefined =>
  id === 't1' ? { name: 'R0021.pH', channel: 's7-01' } : undefined;

describe('设备影子（FR-M9-04 / #22）', () => {
  let file: ReturnType<typeof memFile>;

  beforeEach(() => {
    file = memFile();
  });

  it('reported 与 desired 一致时 state=reported', () => {
    const shadow = new DeviceShadow(file);
    shadow.setDesired('t1', 42, 'admin');
    shadow.setReported('t1', 42, 'Good', Date.now());
    const snap = shadow.snapshot(meta);
    expect(snap).toHaveLength(1);
    expect(snap[0].state).toBe('reported');
  });

  it('desired ≠ reported 时 state=pending 并计数', () => {
    const shadow = new DeviceShadow(file);
    shadow.setReported('t1', 10, 'Good', Date.now());
    shadow.setDesired('t1', 42, 'admin');
    const snap = shadow.snapshot(meta);
    expect(snap[0].state).toBe('pending');
    expect(shadow.pendingCount(meta)).toBe(1);
  });

  it('desired 后真实值到达（收敛）恢复 reported', () => {
    const shadow = new DeviceShadow(file);
    shadow.setDesired('t1', 42, 'admin');
    expect(shadow.snapshot(meta)[0].state).toBe('pending'); // 尚无上报
    shadow.setReported('t1', 42, 'Good', Date.now());
    expect(shadow.snapshot(meta)[0].state).toBe('reported');
  });

  it('持久化往返：重启后恢复 reported/desired', () => {
    const shadow = new DeviceShadow(file);
    shadow.setReported('t1', 7.5, 'Good', 1788765000000);
    shadow.setDesired('t1', 9, 'script');
    shadow.flush();
    // 模拟重启：新实例读同一"文件"
    const shadow2 = new DeviceShadow(file);
    shadow2.loadPersisted();
    const snap = shadow2.snapshot(meta);
    expect(snap[0].reported?.value).toBe(7.5);
    expect(snap[0].desired?.value).toBe(9);
    expect(snap[0].desired?.by).toBe('script');
    expect(snap[0].state).toBe('pending');
  });

  it('未知位号（meta=undefined）不导出；clearTag 修剪', () => {
    const shadow = new DeviceShadow(file);
    shadow.setReported('ghost', 1, 'Good', Date.now());
    expect(shadow.snapshot(meta)).toHaveLength(0);
    shadow.setReported('t1', 1, 'Good', Date.now());
    shadow.clearTag('t1');
    expect(shadow.snapshot(meta)).toHaveLength(0);
  });

  it('onChange 回调在更新时触发', () => {
    const shadow = new DeviceShadow(file);
    let n = 0;
    shadow.onChange = () => { n += 1; };
    shadow.setReported('t1', 1, 'Good', Date.now());
    shadow.setDesired('t1', 2, 'admin');
    expect(n).toBe(2);
  });
});
