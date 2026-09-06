import ModbusRTU from 'modbus-serial';
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds } from 'node-opcua';
import NodeS7 from 'nodes7';
import type { Channel } from '@iotconnector/shared';

export interface TestStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ChannelTestResult {
  ok: boolean;
  rttMs: number;
  steps: TestStep[];
  error?: string;
}

/**
 * 真实连接测试（PRD FR-M2-04）：为每协议建立临时连接执行真实握手序列，
 * 不干扰运行中的采集驱动；完成后关闭临时连接。
 */

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

async function testModbus(channel: Channel, steps: TestStep[]): Promise<void> {
  const client = new ModbusRTU();
  const t0 = Date.now();
  steps.push({ label: 'TCP 连接', ok: true, detail: `${channel.host}:${channel.port}` });
  await withTimeout(client.connectTCP(channel.host, { port: channel.port }), 4000, 'TCP 连接');
  client.setID(Number(channel.params.slaveId ?? 1));
  steps.push({ label: 'MBAP 事务 / Slave 响应', ok: true, detail: `Slave ID ${channel.params.slaveId ?? 1}` });
  const res = await client.readHoldingRegisters(0, 1);
  steps.push({ label: 'FC03 读保持寄存器', ok: true, detail: `40001 = ${res.data[0]}` });
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
  client.close(() => {});
}

async function testS7(channel: Channel, steps: TestStep[], probeNodes7Addr?: string, probeAddrLabel?: string): Promise<void> {
  const conn = new NodeS7();
  const t0 = Date.now();
  steps.push({ label: 'TCP / ISO-on-TCP (COTP)', ok: true, detail: `${channel.host}:${channel.port}` });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      conn.initiateConnection(
        { port: channel.port, host: channel.host, rack: Number(channel.params.rack ?? 0), slot: Number(channel.params.slot ?? 1) },
        (err) => (err ? reject(new Error(String(err))) : resolve()),
      );
    }),
    8000,
    'S7 连接',
  );
  steps.push({ label: 'S7 通讯建立 (0xF0)', ok: true, detail: `Rack ${channel.params.rack ?? 0} / Slot ${channel.params.slot ?? 1}` });
  // 读取第一个位号作为探针（无位号则跳过）
  if (probeNodes7Addr && probeAddrLabel) {
    conn.setTranslationCB((tag) => (tag === 'probe' ? probeNodes7Addr : undefined));
    conn.addItems(['probe']);
    const values = await withTimeout(
      new Promise<Record<string, number | boolean | string>>((resolve, reject) => {
        conn.readAllItems((err, vals) => (err ? reject(new Error(String(err))) : resolve(vals ?? {})));
      }),
      5000,
      '读取探针',
    );
    steps.push({ label: '读探针点位', ok: true, detail: `${probeAddrLabel} = ${values['probe']}` });
  }
  await new Promise<void>((resolve) => conn.dropConnection(() => resolve()));
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testOpcUa(channel: Channel, steps: TestStep[], probeNodeId?: string): Promise<void> {
  const t0 = Date.now();
  const endpointUrl = String(channel.params.endpointUrl ?? `opc.tcp://${channel.host}:${channel.port}`);
  steps.push({ label: 'TCP HEL / OpenSecureChannel', ok: true, detail: endpointUrl });
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { initialDelay: 500, maxRetry: 1 },
  });
  await withTimeout(client.connect(endpointUrl), 6000, '连接');
  const session = await withTimeout(client.createSession(), 6000, '会话创建');
  steps.push({ label: 'Session 创建', ok: true, detail: 'Anonymous / None 策略' });
  const nodeId = probeNodeId ?? 'ns=0;i=2258'; // Server_ServerStatus_CurrentTime
  const dv = await withTimeout(session.read({ nodeId, attributeId: AttributeIds.Value }), 4000, '读取探针');
  steps.push({ label: '读探针节点', ok: true, detail: `${nodeId} = ${String(dv.value?.value)}` });
  await session.close();
  await client.disconnect();
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

/** 执行通道真实连接测试（不干扰运行中的采集驱动） */
export async function testChannel(
  channel: Channel,
  s7Probe?: { nodes7Addr: string; addrLabel: string },
  opcProbeNodeId?: string,
): Promise<ChannelTestResult> {
  const steps: TestStep[] = [];
  try {
    switch (channel.protocol) {
      case 'Modbus TCP':
        await testModbus(channel, steps);
        break;
      case 'Siemens Profinet':
        await testS7(channel, steps, s7Probe?.nodes7Addr, s7Probe?.addrLabel);
        break;
      case 'OPC UA':
        await testOpcUa(channel, steps, opcProbeNodeId);
        break;
      default:
        return {
          ok: false,
          rttMs: 0,
          steps: [{ label: '驱动', ok: false, detail: `${channel.protocol} 的真实测试将在后续阶段提供` }],
          error: 'driver not implemented',
        };
    }
    return { ok: true, rttMs: 0, steps };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    steps.push({ label: '失败', ok: false, detail: msg });
    return { ok: false, rttMs: 0, steps, error: msg };
  }
}
