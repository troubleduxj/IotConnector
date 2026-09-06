import { OPCUAServer, SecurityPolicy, Variant, DataType, type UAVariable } from 'node-opcua';

/**
 * node-opcua 版 OPC UA 模拟服务器（PoC 配套）。
 *
 * 背景：D:\Cursor\Project\ProDB\opcua-simulator（gopcua v0.8/0.9 服务端）的 opc.tcp
 * 在 OPN 阶段断开外部协议栈（node-opcua / 裸二进制实现均被服务端断链；gopcua 自家
 * 客户端正常，其 HTTP API 不受影响）。本模拟器暴露与该模拟器相同的节点命名
 * （ns=2;s=<node_id>），用于驱动联调；待 gopcua 服务端修复后，网关仅需改
 * endpointUrl 即可切回，驱动零改动。
 *
 * 节点：ns=2;s=Temperature_Sensor_01 / Pressure_Sensor_01 / Flow_Sensor_01 /
 *       Welder_001_WeldingVoltage / Valve_01_Opening / Motor_01_Speed / Alarm_Temperature_High
 */

const port = Number(process.env.OPC_SIM_PORT ?? 4840);

interface SimNode {
  nodeId: string;
  browseName: string;
  dataType: DataType;
  base: number;
  amp: number;
  period: number;
}

const simNodes: SimNode[] = [
  { nodeId: 'Temperature_Sensor_01', browseName: 'TemperatureSensor1', dataType: DataType.Double, base: 22, amp: 4, period: 20 },
  { nodeId: 'Pressure_Sensor_01', browseName: 'PressureSensor1', dataType: DataType.Double, base: 4.6, amp: 1.2, period: 15 },
  { nodeId: 'Flow_Sensor_01', browseName: 'FlowSensor1', dataType: DataType.Double, base: 110, amp: 25, period: 25 },
  { nodeId: 'Welder_001_WeldingVoltage', browseName: 'WeldingVoltage', dataType: DataType.Double, base: 23.5, amp: 3, period: 12 },
  { nodeId: 'Valve_01_Opening', browseName: 'ValveOpening', dataType: DataType.Double, base: 60, amp: 30, period: 30 },
  { nodeId: 'Motor_01_Speed', browseName: 'MotorSpeed', dataType: DataType.Int32, base: 1450, amp: 120, period: 18 },
  { nodeId: 'Alarm_Temperature_High', browseName: 'AlarmTemperatureHigh', dataType: DataType.Boolean, base: 0, amp: 0, period: 40 },
];

function currentValue(n: SimNode, t = Date.now() / 1000): number | boolean {
  if (n.dataType === DataType.Boolean) return Math.floor(t / n.period) % 2 === 1;
  return Math.round((n.base + Math.sin((t * 2 * Math.PI) / n.period) * n.amp) * 100) / 100;
}

async function main(): Promise<void> {
  const server = new OPCUAServer({
    port,
    securityPolicies: [SecurityPolicy.None],
    buildInfo: { productName: 'FactoryBridge OPC UA Simulator', buildNumber: '1' },
  });

  await server.initialize();

  // 注册与 gopcua 版模拟器相同的命名空间 URI，使节点 ID 保持 ns=2;s=<node_id> 兼容
  const addressSpace = server.engine.addressSpace;
  const ns2 =
    addressSpace.getNamespace('urn:prodb:opcua:simulator') ??
    addressSpace.registerNamespace('urn:prodb:opcua:simulator');
  console.log(`[opcua-sim-node] simulator namespace index: ${ns2.index}`);

  const variables: UAVariable[] = simNodes.map((n) => {
    const v = ns2.addVariable({
      nodeId: `ns=${ns2.index};s=${n.nodeId}`,
      browseName: n.browseName,
      dataType: n.dataType,
    });
    v.setValueFromSource(new Variant({ dataType: n.dataType, value: currentValue(n) }));
    return v;
  });

  setInterval(() => {
    const t = Date.now() / 1000;
    simNodes.forEach((n, i) => {
      variables[i].setValueFromSource(new Variant({ dataType: n.dataType, value: currentValue(n, t) }));
    });
  }, 1000);

  await server.start();
  const endpoint = server.endpoints[0].endpointDescriptions()[0];
  console.log(`[opcua-sim-node] endpoint: ${endpoint.endpointUrl}`);
  console.log(`[opcua-sim-node] ns=2 nodes: ${simNodes.map((n) => n.nodeId).join(', ')}`);
}

void main().catch((e) => {
  console.error('[opcua-sim-node] fatal:', e);
  process.exit(1);
});
