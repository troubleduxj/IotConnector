import type { AlarmEvent, ChannelStatus, StorageStatus, TagValueUpdate } from './types';

/**
 * 网关 ↔ 控制台 WebSocket 消息协议（v1）。
 * 传输：ws(s)://<gateway>/ws，JSON 文本帧。
 */

export type ServerMessage =
  | {
      type: 'hello';
      serverTime: number;
      channels: ChannelStatus[];
      storage: StorageStatus;
    }
  | { type: 'tags-batch'; values: TagValueUpdate[] }
  | { type: 'channel-status'; status: ChannelStatus }
  | { type: 'storage-status'; status: StorageStatus }
  | { type: 'write-result'; tagId: string; ok: boolean; error?: string }
  | { type: 'alarm'; event: AlarmEvent }
  | { type: 'config-changed' };

export type ClientMessage =
  | { type: 'subscribe' }
  | { type: 'unsubscribe' }
  | { type: 'write'; tagId: string; value: number | string | boolean };
