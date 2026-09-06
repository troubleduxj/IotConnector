/**
 * 平台统一数据模型（PRD §10）。
 * 关键原则：一个位号模型贯穿全系统 —— 网关引擎、控制台、存储、Historian 共用本定义。
 */

/** 平台支持的南向协议（9 种，成熟度分阶段见 PRD §4.2） */
export type Protocol =
  | 'Siemens Profinet'
  | 'OPC UA'
  | 'Modbus TCP'
  | 'EtherNet/IP (Rockwell)'
  | 'Mitsubishi MELSEC'
  | 'Omron FINS'
  | 'MQTT / Sparkplug B'
  | 'BACnet/IP'
  | 'IEC 60870-5-104';

/** 位号数据类型（网关原始类型；P0 阶段支持 Bool/Int16/Float） */
export type DataType = 'Bool' | 'Int16' | 'UInt16' | 'Int32' | 'Float' | 'Double' | 'String';

/** 通讯质量（继承 OPC 质量思想） */
export type Quality = 'Good' | 'Uncertain' | 'Bad';

/** 通道（南向连接实例） */
export interface Channel {
  id: string;
  /** 通道名称，全局唯一，展示用 */
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  enabled: boolean;
  /** 采集周期（毫秒） */
  pollIntervalMs: number;
  /**
   * 协议专属参数，键值随协议不同（结构由 paramSchemas 约束）。
   * driver 为 PoC 阶段驱动覆盖项（如 'simulation'），正式通道不设置。
   */
  params: Record<string, string | number | boolean> & { driver?: string };
}

/** 位号：最小采集/展示/存储单元 */
export interface Tag {
  id: string;
  channelId: string;
  /** 全局唯一，推荐 "Channel.Tag" 命名 */
  name: string;
  /** 协议地址（如 DB301.Real10 / 40001 / ns=3;s=...） */
  address: string;
  dataType: DataType;
  unit: string;
  /** 标度变换：工程值 = 原始值 * scale + offset */
  scale: number;
  offset: number;
  /** 工程量程（Historian 归一化与量程告警依赖；可缺省） */
  engMin?: number;
  engMax?: number;
  description?: string;
}

/** 位号实时值更新（WS 批量推送 / REST 快照） */
export interface TagValueUpdate {
  id: string;
  value: number | string | boolean;
  quality: Quality;
  /** epoch ms */
  ts: number;
}

export type ChannelState = 'online' | 'offline' | 'connecting' | 'error' | 'disabled';

export interface ChannelStatus {
  id: string;
  state: ChannelState;
  detail?: string;
  lastError?: string;
  /** 最近一次成功往返耗时 */
  rttMs?: number;
}

/** TDengine 存储管道状态（PRD M9 / D6 决策） */
export interface StorageStatus {
  engine: 'tdengine';
  state: 'online' | 'offline' | 'disabled';
  /** 待写入队列长度 */
  queued: number;
  /** 累计写入点数 */
  written: number;
  error?: string;
}

/** 告警规则（PRD FR-M10-01 最小集：限值告警 + 回差） */
export interface AlarmRule {
  id: string;
  tagId: string;
  /** 越上限 / 越下限 */
  kind: 'high' | 'low';
  threshold: number;
  /** 回差（消除临界抖动）：high 规则回落到 threshold - hysteresis 以下才清除 */
  hysteresis: number;
  enabled: boolean;
  message?: string;
}

export interface AlarmEvent {
  id: string;
  ruleId: string;
  tagId: string;
  tagName: string;
  channel: string;
  state: 'Active' | 'Cleared';
  kind: 'high' | 'low';
  threshold: number;
  value: number;
  ts: number;
  message?: string;
}

/** 告警通知配置（MVP：通用 Webhook，兼容钉钉/企微机器人格式化由网关适配） */
export interface NotificationConfig {
  enabled: boolean;
  /** Webhook 地址（POST JSON：{ event, tagName, kind, value, threshold, ts }） */
  webhookUrl: string;
}
