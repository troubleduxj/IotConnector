import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../src/notify';
import { DEFAULT_NOTIFY_TEMPLATE } from '@iotconnector/shared';
import type { AlarmEvent } from '@iotconnector/shared';

const evt: AlarmEvent = {
  id: 'e1', ruleId: 'r1', tagId: 't1', tagName: 'R0021.pH', channel: 'R0021_S7_1500',
  state: 'Active', kind: 'high', threshold: 80, value: 92.5, ts: 1788765000000,
  message: '持续 5s',
};

describe('通知消息模板（#12）', () => {
  it('默认模板渲染出标题与正文', () => {
    const title = renderTemplate(DEFAULT_NOTIFY_TEMPLATE.title, {
      tagName: evt.tagName, stateText: '触发',
    });
    expect(title).toBe('[FactoryBridge 告警] R0021.pH 触发');
  });

  it('自定义模板替换全部变量', () => {
    const out = renderTemplate('{tagName}@{channel}:{kindText} {value}/{threshold} ({stateText}) {message}', {
      tagName: evt.tagName, channel: evt.channel, kindText: '越上限', value: evt.value,
      threshold: evt.threshold, stateText: '触发', message: evt.message ?? '',
    });
    expect(out).toBe('R0021.pH@R0021_S7_1500:越上限 92.5/80 (触发) 持续 5s');
  });

  it('未知占位符原样保留', () => {
    expect(renderTemplate('hi {unknownVar} {tagName}', { tagName: 'A' })).toBe('hi {unknownVar} A');
  });

  it('message 缺省渲染为空串而非 undefined', () => {
    const out = renderTemplate('{message}end', { message: '' });
    expect(out).toBe('end');
  });
});
