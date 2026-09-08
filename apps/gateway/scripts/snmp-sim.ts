import snmp, { ObjectType, MibProviderType, MaxAccess } from 'net-snmp';

/**
 * SNMP 模拟器（UPS/环动场景）：企业子树 1.3.6.1.4.1.99999 下的动态标量
 * （输入电压 / 电池电量 / 位置备注），供 SNMP 通道连接测试与采集联调。
 * 默认端口 1161（非特权）。启动：pnpm --filter @iotconnector/gateway snmp-sim
 */

const PORT = Number(process.env.SNMP_SIM_PORT ?? 1161);

const agent = snmp.createAgent(
  { port: PORT, family: 'udp4', accessControlModelType: snmp.AccessControlModelType.Simple },
  (error?: Error) => {
    // 该回调同时接收 bind 完成与请求处理错误；仅 bind 失败才退出
    if (error) console.error(`[snmp-sim] ${error.message}`);
    else console.log(`[snmp-sim] agent 监听 udp/${PORT} (community: public)`);
  },
);
// community 注册不依赖 listening 回调，尽早生效避免与首轮轮询竞态
agent.getAuthorizer().addCommunity('public');

const mib = agent.getMib();

/** 动态标量 provider：每次 GET 现算（轮询可观察变化） */
function dynamicScalar(name: string, oid: string, scalarType: ObjectType, compute: () => number | string): void {
  mib.registerProvider({
    name,
    type: MibProviderType.Scalar,
    oid,
    scalarType,
    maxAccess: MaxAccess['read-only'],
    handler: (mibRequest) => {
      mibRequest.instanceNode.value = compute();
      mibRequest.done();
    },
  });
  // 触发实例节点创建
  mib.setScalarValue(name, compute());
}

let tick = 0;
dynamicScalar('upsInputVoltage', '1.3.6.1.4.1.99999.1.1', ObjectType.Integer, () => {
  tick += 1;
  return 220 + Math.round(Math.sin(tick / 10) * 6);
});
dynamicScalar('upsBatteryLevel', '1.3.6.1.4.1.99999.1.2', ObjectType.Gauge, () => 85 + (tick % 15));
dynamicScalar('upsLocationNote', '1.3.6.1.4.1.99999.1.3', ObjectType.OctetString, () => `Rack-A ${new Date().toLocaleTimeString()}`);

// 静态 sysDescr（1.3.6.1.2.1.1.1.0），便于默认探针验证
mib.registerProvider({
  name: 'sysDescr',
  type: MibProviderType.Scalar,
  oid: '1.3.6.1.2.1.1.1',
  scalarType: ObjectType.OctetString,
  maxAccess: MaxAccess['read-only'],
});
mib.setScalarValue('sysDescr', 'FactoryBridge SNMP Simulator v1.0');

console.log('[snmp-sim] 已注册 OID：1.3.6.1.4.1.99999.1.{1,2,3}.0（动态） 与 1.3.6.1.2.1.1.1.0（sysDescr）');
