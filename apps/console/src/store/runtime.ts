import { create } from 'zustand';
import type {
  AlarmEvent,
  ChannelStatus,
  ClientMessage,
  ServerMessage,
  StorageStatus,
  TagValueUpdate,
} from '@iotconnector/shared';
import { gatewayUrl, getToken } from '../api';

/**
 * 网关实时数据 store：WebSocket 连接 + 位号最新值缓存。
 * Dashboard 等视图通过 useRuntime 订阅；写操作走 REST（POST /api/tags/:id/write）。
 */

type ConnState = 'connecting' | 'live' | 'offline';

interface RuntimeState {
  status: ConnState;
  liveValues: Record<string, TagValueUpdate>;
  channels: Record<string, ChannelStatus>;
  storage: StorageStatus | null;
  lastUpdateTs: number | null;
  /** WS 实时推送的最新告警事件（Dashboard/告警中心订阅后即时刷新） */
  lastAlarmEvent: AlarmEvent | null;
  alarmSeq: number;
  connect: () => void;
  write: (tagId: string, value: number | string | boolean) => Promise<{ ok: boolean; error?: string }>;
}

let socket: WebSocket | null = null;
let retries = 0;

export const useRuntime = create<RuntimeState>((set) => ({
  status: 'connecting',
  liveValues: {},
  channels: {},
  storage: null,
  lastUpdateTs: null,
  lastAlarmEvent: null,
  alarmSeq: 0,

  connect: () => {
    if (socket) return;
    openSocket();
  },

  write: async (tagId, value) => {
    try {
      const res = await fetch(gatewayUrl(`/api/tags/${encodeURIComponent(tagId)}/write`), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({ value }),
      });
      return (await res.json()) as { ok: boolean; error?: string };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
}));

function openSocket(): void {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsURL = new URL(gatewayUrl('/ws'), location.origin);
  wsURL.protocol = wsProto;
  const token = getToken();
  if (token) wsURL.searchParams.set('token', token);
  socket = new WebSocket(wsURL.toString());

  socket.onopen = () => {
    retries = 0;
    useRuntime.setState({ status: 'live' });
    socket?.send(JSON.stringify({ type: 'subscribe' } satisfies ClientMessage));
  };

  socket.onmessage = (ev: MessageEvent<string>) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello': {
        const channels: Record<string, ChannelStatus> = {};
        for (const c of msg.channels) channels[c.id] = c;
        useRuntime.setState({ channels, storage: msg.storage });
        break;
      }
      case 'tags-batch': {
        const patch: Record<string, TagValueUpdate> = {};
        for (const v of msg.values) patch[v.id] = v;
        useRuntime.setState((s) => ({
          liveValues: { ...s.liveValues, ...patch },
          lastUpdateTs: Date.now(),
        }));
        break;
      }
      case 'channel-status':
        useRuntime.setState((s) => ({
          channels: { ...s.channels, [msg.status.id]: msg.status },
        }));
        break;
      case 'storage-status':
        useRuntime.setState({ storage: msg.status });
        break;
      case 'alarm':
        useRuntime.setState((s) => ({ lastAlarmEvent: msg.event, alarmSeq: s.alarmSeq + 1 }));
        break;
      default:
        break;
    }
  };

  socket.onclose = () => {
    socket = null;
    useRuntime.setState({ status: 'offline' });
    retries += 1;
    setTimeout(openSocket, Math.min(5000, 500 * retries));
  };

  socket.onerror = () => {
    socket?.close();
  };
}
