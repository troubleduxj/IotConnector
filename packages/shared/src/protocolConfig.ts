import type { Protocol } from './types';

export interface ProtocolMetadata {
  name: Protocol;
  category: 'PLC & Fieldbus' | 'Open Standard' | 'IIoT & Cloud' | 'Building & Power';
  defaultPort: string;
  vendor: string;
  description: string;
  sampleAddress: string;
  addressSyntaxHelp: string;
  standard: string;
  color: string;
  bgColor: string;
}

/**
 * 协议元数据单一来源：控制台徽章/配色、默认端口、地址语法帮助均取自此文件。
 * color 字段为 Tailwind 类名（UI 规范 §2.4），不得在前端另行硬编码。
 */
export const PROTOCOL_CONFIGS: Record<Protocol, ProtocolMetadata> = {
  'Siemens Profinet': {
    name: 'Siemens Profinet',
    category: 'PLC & Fieldbus',
    defaultPort: '102',
    vendor: 'Siemens S7 (ISO-on-TCP)',
    description: 'Direct S7comm / S7comm-Plus driver for S7-1500, S7-1200, S7-300, S7-400 and S7-200 SMART.',
    sampleAddress: 'DB301.Real10',
    addressSyntaxHelp: 'DB<n>.DBX<byte>.<bit> (Bool), DB<n>.Real<byte> (Float), DB<n>.DBD<byte> (DWord), MW<word>, IW<word>',
    standard: 'RFC 1006 / ISO 8073',
    color: 'text-cyan-600 border-cyan-300 bg-cyan-50',
    bgColor: 'bg-cyan-500'
  },
  'OPC UA': {
    name: 'OPC UA',
    category: 'Open Standard',
    defaultPort: '4840',
    vendor: 'OPC Foundation',
    description: 'Platform-independent IEC 62541 service-oriented architecture with end-to-end PKI security.',
    sampleAddress: 'ns=2;s="DB_Process"."Pressure"',
    addressSyntaxHelp: 'ns=<namespaceIndex>;s=<stringIdentifier> or ns=<idx>;i=<numericIdentifier>',
    standard: 'IEC 62541',
    color: 'text-indigo-600 border-indigo-300 bg-indigo-50',
    bgColor: 'bg-indigo-500'
  },
  'Modbus TCP': {
    name: 'Modbus TCP',
    category: 'Open Standard',
    defaultPort: '502',
    vendor: 'Modbus-IDA / Schneider',
    description: 'Industrial de facto standard over TCP/IP supporting Coils, Discrete Inputs, and Holding/Input Registers.',
    sampleAddress: '40001',
    addressSyntaxHelp: '00001-09999 (Coil), 10001-19999 (Discrete), 30001-39999 (Input Reg), 40001-49999 (Holding Reg)',
    standard: 'IEC 61158',
    color: 'text-amber-600 border-amber-300 bg-amber-50',
    bgColor: 'bg-amber-500'
  },
  'EtherNet/IP (Rockwell)': {
    name: 'EtherNet/IP (Rockwell)',
    category: 'PLC & Fieldbus',
    defaultPort: '44818',
    vendor: 'Rockwell Automation / ODVA',
    description: 'Common Industrial Protocol (CIP) for Allen-Bradley ControlLogix, CompactLogix, Micro800 and SLC500.',
    sampleAddress: 'Program:MainProgram.MotorSpeed',
    addressSyntaxHelp: 'Symbolic Tag Name: "Motor_Speed", Program Scope: "Program:MainProgram.Tag", or SLC format "N7:0"',
    standard: 'ODVA CIP / IEC 61158',
    color: 'text-rose-600 border-rose-300 bg-rose-50',
    bgColor: 'bg-rose-500'
  },
  'Mitsubishi MELSEC': {
    name: 'Mitsubishi MELSEC',
    category: 'PLC & Fieldbus',
    defaultPort: '5000',
    vendor: 'Mitsubishi Electric',
    description: 'MELSEC Communication (MC) 3E & 1E Protocol for iQ-R, iQ-F (FX5U), Q, L and FX Ethernet Series.',
    sampleAddress: 'D100',
    addressSyntaxHelp: 'D<n> (Data Register), M<n> (Internal Relay), W<hex> (Link Reg), R<n> (File Reg), X<hex> (Input), Y<hex> (Output)',
    standard: 'SLMP / MC Protocol',
    color: 'text-red-600 border-red-300 bg-red-50',
    bgColor: 'bg-red-500'
  },
  'Omron FINS': {
    name: 'Omron FINS',
    category: 'PLC & Fieldbus',
    defaultPort: '9600',
    vendor: 'Omron Automation',
    description: 'Factory Interface Network Service protocol over TCP/UDP for CJ2, CS1, NJ/NX and CP1 PLCs.',
    sampleAddress: 'DM100',
    addressSyntaxHelp: 'DM<word> (Data Memory), CIO<word>.<bit> (Channel IO), W<word> (Work Area), HR<word> (Holding), AR<word>',
    standard: 'Omron FINS TCP/UDP',
    color: 'text-blue-600 border-blue-300 bg-blue-50',
    bgColor: 'bg-blue-500'
  },
  'MQTT / Sparkplug B': {
    name: 'MQTT / Sparkplug B',
    category: 'IIoT & Cloud',
    defaultPort: '1883',
    vendor: 'Eclipse Foundation',
    description: 'Lightweight publish/subscribe architecture with stateful industrial Sparkplug B v2.2 payload standard.',
    sampleAddress: 'spBv1.0/Plant/DDATA/Cell1/Temp',
    addressSyntaxHelp: 'Topic[#.field.path] — e.g. factory/line1/status#temp (JSON field), factory/line1/counter# (raw scalar)',
    standard: 'ISO/IEC 20922 / Sparkplug B',
    color: 'text-purple-600 border-purple-300 bg-purple-50',
    bgColor: 'bg-purple-500'
  },
  'BACnet/IP': {
    name: 'BACnet/IP',
    category: 'Building & Power',
    defaultPort: '47808',
    vendor: 'ASHRAE 135',
    description: 'Building Automation and Control networks protocol for HVAC chillers, AHUs, power meters and lighting.',
    sampleAddress: 'AI:1',
    addressSyntaxHelp: 'AI:<instance> (Analog Input), AO:<n> (Analog Out), AV:<n> (Analog Value), BI:<n> (Binary In), BV:<n> (Binary Value)',
    standard: 'ANSI/ASHRAE Standard 135 / ISO 16484-5',
    color: 'text-emerald-600 border-emerald-300 bg-emerald-50',
    bgColor: 'bg-emerald-500'
  },
  'IEC 60870-5-104': {
    name: 'IEC 60870-5-104',
    category: 'Building & Power',
    defaultPort: '2404',
    vendor: 'IEC Standard',
    description: 'Telecontrol equipment and systems network access protocol for power substation & electrical grid telemetry.',
    sampleAddress: 'IOA:1001',
    addressSyntaxHelp: 'IOA:<address> (Information Object Address), e.g. Single-point IOA:1001, Normalized Measure IOA:2001',
    standard: 'IEC 60870-5-104:2006',
    color: 'text-amber-700 border-amber-400 bg-amber-50',
    bgColor: 'bg-amber-600'
  },
  'SNMP': {
    name: 'SNMP',
    category: 'Building & Power',
    defaultPort: '161',
    vendor: 'IETF RFC 3411-3418',
    description: 'SNMP v1/v2c polling for UPS, PDU, environment sensors, network gear and energy meters (MIB-2 / vendor OIDs).',
    sampleAddress: '1.3.6.1.4.1.9.9.13.1.3.1.3.1',
    addressSyntaxHelp: 'Dotted numeric OID, e.g. 1.3.6.1.2.1.1.3.0 (sysUpTime), 1.3.6.1.4.1.<enterprise>.<instance>',
    standard: 'IETF SNMP v2c (RFC 1905-1907)',
    color: 'text-lime-700 border-lime-400 bg-lime-50',
    bgColor: 'bg-lime-600'
  }
};

/** Historian 多曲线色板（UI 规范 §2.5，8 色） */
export const TAG_CHART_COLORS = [
  '#4f46e5', '#059669', '#d97706', '#e11d48', '#0891b2', '#9333ea', '#ea580c', '#0d9488',
];
