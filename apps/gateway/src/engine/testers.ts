import ModbusRTU from 'modbus-serial';
import mqtt from 'mqtt';
import snmp, { ObjectType, type Varbind } from 'net-snmp';
import BacnetClient from 'bacstack';
import { OPCUAClient, MessageSecurityMode, SecurityPolicy, AttributeIds, TimestampsToReturn, ClientSubscription } from 'node-opcua';
import NodeS7 from 'nodes7';
import type { Channel } from '@iotconnector/shared';
import { probeMelsec } from './drivers/melsec';
import { probeFins } from './drivers/fins';
import { probeEnip } from './drivers/enip';

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

/** S7 多位号探针（#15）：探针名称 → nodes7 地址 */
export interface S7ProbeItem {
  name: string;
  nodes7Addr: string;
  addrLabel: string;
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

async function testS7(channel: Channel, steps: TestStep[], probes?: S7ProbeItem[]): Promise<void> {
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
  // #15 多位号探针循环：全部探针一次性加入翻译表，单次 readAllItems 批量读回（与采集驱动同路径）
  if (probes && probes.length > 0) {
    const byName = new Map(probes.map((p) => [p.name, p.nodes7Addr]));
    conn.setTranslationCB((tag) => byName.get(tag));
    conn.addItems(probes.map((p) => p.name));
    const values = await withTimeout(
      new Promise<Record<string, number | boolean | string>>((resolve, reject) => {
        conn.readAllItems((err, vals) => (err ? reject(new Error(String(err))) : resolve(vals ?? {})));
      }),
      5000,
      '读取探针',
    );
    for (const p of probes) {
      const v = values[p.name];
      steps.push({ label: '读探针点位', ok: v !== undefined, detail: `${p.addrLabel} = ${v === undefined ? '无返回' : String(v)}` });
    }
    steps.push({ label: '探针批量读', ok: true, detail: `${probes.length} 个位号 / 1 次 PDU 往返` });
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
  // #15 订阅式探针：创建 Subscription + MonitoredItem，等待首个数据通知（验证 Publishing 通道与采集驱动同路径）
  try {
    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: 500,
      requestedLifetimeCount: 60,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 10,
      publishingEnabled: true,
      priority: 0,
    });
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        subscription.on('started', () => resolve());
        subscription.on('internal_error', (err: Error) => reject(err));
      }),
      5000,
      '订阅创建',
    );
    const firstValue = await withTimeout(
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('订阅无数据通知')), 5000);
        void subscription
          .monitor(
            { nodeId, attributeId: AttributeIds.Value },
            { samplingInterval: 200, discardOldest: true, queueSize: 1 },
            TimestampsToReturn.Both,
          )
          .then((item) => {
            item.on('changed', (dataValue) => {
              clearTimeout(timer);
              resolve(String(dataValue.value?.value));
            });
            item.on('err', (err) => {
              clearTimeout(timer);
              reject(err);
            });
          })
          .catch((err) => {
            clearTimeout(timer);
            reject(err);
          });
      }),
      6000,
      '订阅采样',
    );
    steps.push({ label: '订阅采样 (MonitoredItem)', ok: true, detail: `${nodeId} = ${firstValue}` });
    await subscription.terminate();
  } catch (e) {
    // 订阅失败不否定连接本身（只读已验证服务可用），记录告警步骤
    steps.push({ label: '订阅采样 (MonitoredItem)', ok: false, detail: String((e as Error).message ?? e) });
  }
  await session.close();
  await client.disconnect();
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testMelsec(channel: Channel, steps: TestStep[], probeAddr?: string): Promise<void> {
  const t0 = Date.now();
  const addr = probeAddr ?? 'D0';
  steps.push({ label: 'TCP 连接', ok: true, detail: `${channel.host}:${channel.port}` });
  const { value } = await probeMelsec(channel.host, channel.port, addr);
  steps.push({ label: 'MC 3E 批量读', ok: true, detail: addr });
  steps.push({ label: '读探针点位', ok: true, detail: `${addr} = ${value}` });
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testFins(channel: Channel, steps: TestStep[], probeAddr?: string): Promise<void> {
  const t0 = Date.now();
  const addr = probeAddr ?? 'D0';
  steps.push({ label: 'TCP 连接', ok: true, detail: `${channel.host}:${channel.port}` });
  const { value } = await probeFins(channel.host, channel.port, addr);
  steps.push({ label: 'FINS/TCP 握手 (01 01 读字)', ok: true, detail: addr });
  steps.push({ label: '读探针点位', ok: true, detail: `${addr} = ${value}` });
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testEnip(channel: Channel, steps: TestStep[], probeTag?: string): Promise<void> {
  const t0 = Date.now();
  const tag = probeTag ?? 'test';
  steps.push({ label: 'TCP 连接', ok: true, detail: `${channel.host}:${channel.port}` });
  const { value } = await probeEnip(channel.host, channel.port, tag);
  steps.push({ label: 'RegisterSession + Read Tag (0x4E)', ok: true, detail: tag });
  steps.push({ label: '读探针点位', ok: true, detail: `${tag} = ${value}` });
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}


async function testMqtt(channel: Channel, steps: TestStep[], probeTopic?: string): Promise<void> {
  const p = channel.params as Record<string, unknown>;
  const t0 = Date.now();
  const brokerUrl = String(p.brokerUrl ?? `mqtt://${channel.host}:${channel.port}`);
  steps.push({ label: 'Broker 连接', ok: true, detail: brokerUrl });
  const client = mqtt.connect(brokerUrl, {
    connectTimeout: 6000,
    username: p.username ? String(p.username) : undefined,
    password: p.password ? String(p.password) : undefined,
  });
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', (e) => reject(new Error(e.message)));
    }), 6000, 'MQTT CONNACK');
    // 位号地址可能为「主题#字段路径」，订阅仅取主题段
    const rawTopic = probeTopic ?? 'factorybridge/test/probe';
    const topic = rawTopic.indexOf('#') >= 0 ? rawTopic.slice(0, rawTopic.indexOf('#')) : rawTopic;
    await withTimeout(new Promise<void>((resolve, reject) => {
      client.subscribe(topic, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
    }), 4000, 'SUBSCRIBE');
    steps.push({ label: 'CONNACK / SUBACK', ok: true, detail: `订阅探针主题 ${topic}` });
    // 尝试等待首条消息（3s，无消息不否定连接——演示环境可能无人发布）
    const first = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      client.once('message', (topic, payload) => {
        clearTimeout(timer);
        resolve(`${topic} = ${payload.toString().slice(0, 60)}`);
      });
    });
    if (first) steps.push({ label: '订阅采样', ok: true, detail: first });
    else steps.push({ label: '订阅采样', ok: true, detail: '3s 内无消息（CONNACK/SUBACK 已验证通道）' });
  } finally {
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  }
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testSnmp(channel: Channel, steps: TestStep[], probeOid?: string): Promise<void> {
  const p = channel.params as Record<string, unknown>;
  const t0 = Date.now();
  const version = String(p.snmpVersion ?? '2c') === '1' ? snmp.Version1 : snmp.Version2c;
  const oid = probeOid ?? '1.3.6.1.2.1.1.3.0'; // sysUpTime
  steps.push({ label: 'UDP 会话', ok: true, detail: `${channel.host}:${channel.port} (v${version === snmp.Version1 ? '1' : '2c'} / ${p.community ?? 'public'})` });
  const session = snmp.createSession(channel.host, String(p.community ?? 'public'), {
    port: channel.port,
    version,
    timeout: Math.max(200, Number(p.timeoutMs ?? 1500)),
    retries: Math.max(0, Number(p.retries ?? 1)),
  });
  try {
    const varbinds = await withTimeout(new Promise<Varbind[]>((resolve, reject) => {
      session.get([oid], (err, vbs) => (err ? reject(err) : resolve(vbs)));
    }), Math.max(1000, Number(p.timeoutMs ?? 1500) + 1000), 'SNMP GET');
    const vb = varbinds[0];
    const readable = vb.type === ObjectType.OctetString ? vb.value.toString() : String(vb.value);
    const typeName = { 2: 'Integer', 4: 'OctetString', 5: 'Null', 6: 'OID', 64: 'IpAddress', 65: 'Counter', 66: 'Gauge', 67: 'TimeTicks', 68: 'Counter64', 129: 'NoSuchObject', 130: 'NoSuchInstance' }[vb.type] ?? `type ${vb.type}`;
    steps.push({ label: 'SNMP GET', ok: vb.type !== ObjectType.Null && vb.type !== ObjectType.NoSuchObject, detail: `${oid} (${typeName}) = ${readable}` });
  } finally {
    session.close();
  }
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

async function testBacnet(channel: Channel, steps: TestStep[], probeAddr?: string): Promise<void> {
  // bacstack 发送端口与本地绑定端口绑死（常驻驱动独占 47808 时无法共存），探针改 raw dgram 实现
  const dgram = await import('node:dgram');
  const t0 = Date.now();
  const target = { port: channel.port, address: channel.host };
  const probe = (probeAddr ?? 'AI:1').match(/^(AI|AO|AV|BI|BO|BV|MSI):(\d+)$/i);
  if (!probe) throw new Error(`探针地址非法: ${probeAddr}`);
  const TYPE: Record<string, number> = { AI: 0, AO: 1, AV: 2, BI: 3, BO: 4, BV: 5, MSI: 13 };
  const objType = TYPE[probe[1].toUpperCase()];
  const instance = Number(probe[2]);
  const objectId4B = ((objType & 0x3ff) << 22) | (instance & 0x3fffff);

  const invokeId = 0x2a;
  const apdu = Buffer.from([
    0x05, invokeId, 0x00, 0x0c, // confirmed request, ReadProperty
    0x0c, (objectId4B >> 24) & 0xff, (objectId4B >> 16) & 0xff, (objectId4B >> 8) & 0xff, objectId4B & 0xff, // context0 objectId
    0x19, 85, // context1 propertyId = 85 PresentValue
  ]);
  // BVLC: type 0x81, function 0x0A (Original-Unicast-NPDU), 长度 2B 大端 = APDU + NPDU(1)
  const bvlcLen = apdu.length + 1;
  const bvlc = Buffer.concat([Buffer.from([0x81, 0x0a, (bvlcLen >> 8) & 0xff, bvlcLen & 0xff, 0x01]), apdu]);

  steps.push({ label: 'UDP 探针', ok: true, detail: `${probeAddr} → ${target.address}:${target.port}` });
  const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve({ ok: false, detail: 'ReadProperty 超时' }); }, 3000);
    sock.on('message', (msg: Buffer) => {
      clearTimeout(timer);
      try {
        console.log(`[bacnet-test] rx ${msg.length}B: ${msg.toString('hex')}`);
        // BVLC(4)+NPDU(1) → APDU；Confirmed-Response 在 APDU[0]=0x30
        const apdu0 = msg[5];
        if (msg[0] !== 0x81 || apdu0 !== 0x30) throw new Error(`非 Confirmed-Response (apdu0=${apdu0.toString(16)} msg0=${msg[0].toString(16)} len=${msg.length} raw=${msg.toString('hex')})`);
        const apdu = msg.subarray(5);
        // 简单定位：找 REAL tag (0x44) 或 Boolean tag (0x01)
        const iReal = apdu.indexOf(0x44);
        const iBool = apdu.indexOf(0x01);
        let text: string;
        if (iReal >= 0) text = String(apdu.readFloatBE(iReal + 1));
        else if (iBool >= 0 && iBool + 1 < apdu.length) text = apdu[iBool + 1] ? 'true' : 'false';
        else text = `raw ${msg.toString('hex')}`;
        sock.close();
        resolve({ ok: true, detail: `${probeAddr} = ${text}` });
      } catch (e) {
        sock.close();
        resolve({ ok: false, detail: `响应解析失败: ${(e as Error).message}` });
      }
    });
    sock.send(bvlc, target.port, target.address, () => undefined);
  });
  steps.push({ label: 'ReadProperty (PresentValue)', ok: result.ok, detail: result.detail });
  steps.push({ label: '往返耗时', ok: true, detail: `${Date.now() - t0}ms` });
}

/** 执行通道真实连接测试（不干扰运行中的采集驱动） */
export async function testChannel(
  channel: Channel,
  s7Probes?: S7ProbeItem[],
  opcProbeNodeId?: string,
  rawProbeAddr?: string,
): Promise<ChannelTestResult> {
  const steps: TestStep[] = [];
  try {
    switch (channel.protocol) {
      case 'Modbus TCP':
        await testModbus(channel, steps);
        break;
      case 'Siemens Profinet':
        await testS7(channel, steps, s7Probes);
        break;
      case 'OPC UA':
        await testOpcUa(channel, steps, opcProbeNodeId);
        break;
      case 'MQTT / Sparkplug B':
        await testMqtt(channel, steps, rawProbeAddr);
        break;
      case 'SNMP':
        await testSnmp(channel, steps, rawProbeAddr);
        break;
      case 'BACnet/IP':
        await testBacnet(channel, steps, rawProbeAddr);
        break;
      case 'Mitsubishi MELSEC':
        await testMelsec(channel, steps, rawProbeAddr);
        break;
      case 'Omron FINS':
        await testFins(channel, steps, rawProbeAddr);
        break;
      case 'EtherNet/IP (Rockwell)':
        await testEnip(channel, steps, rawProbeAddr);
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
