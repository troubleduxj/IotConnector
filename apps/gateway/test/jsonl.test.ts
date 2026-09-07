import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsonl } from '../src/jsonl';

describe('JSONL 按大小轮转（#存储优化3）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-jsonl-'));
    file = path.join(dir, 'audit.jsonl');
    return () => fs.rmSync(dir, { recursive: true, force: true });
  });

  it('未超限时不轮转，正常追加', () => {
    appendJsonl(file, '{"a":1}\n', 1000);
    appendJsonl(file, '{"a":2}\n', 1000);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1}\n{"a":2}\n');
    expect(fs.existsSync(`${file}.1`)).toBe(false);
  });

  it('超限后轮转出 .1，新写入进主文件', () => {
    appendJsonl(file, 'x'.repeat(150) + '\n', 100);
    appendJsonl(file, 'y'.repeat(150) + '\n', 100); // 旧主文件已 151B>100 → 轮转出 .1
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toContain('xxx');
    expect(fs.readFileSync(file, 'utf-8')).toContain('yyy');
  });

  it('连续轮转保留 keep 代，最老归档被淘汰', () => {
    for (const ch of ['a', 'b', 'c', 'd']) {
      appendJsonl(file, ch.repeat(150) + '\n', 100, 2);
    }
    expect(fs.existsSync(`${file}.2`)).toBe(true);
    expect(fs.existsSync(`${file}.3`)).toBe(false);
    // keep=2：file.2 = 第二代（b），file.1 = 第三代（c），主文件 = 最新（d）
    expect(fs.readFileSync(`${file}.2`, 'utf-8')).toContain('bbb');
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toContain('ccc');
    expect(fs.readFileSync(file, 'utf-8')).toContain('ddd');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('aaa');
  });
});
