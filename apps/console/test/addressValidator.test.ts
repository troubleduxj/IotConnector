import { describe, expect, it } from 'vitest';
import { addressHint, validateAddress } from '../src/shared/addressValidator';

describe('validateAddress', () => {
  it('Modbus TCP 接受五位数字寄存器地址', () => {
    expect(validateAddress('Modbus TCP', '40001').ok).toBe(true);
    expect(validateAddress('Modbus TCP', '30011').ok).toBe(true);
  });

  it('Modbus TCP 拒绝非法格式', () => {
    expect(validateAddress('Modbus TCP', '4000').ok).toBe(false);
    expect(validateAddress('Modbus TCP', '50001').ok).toBe(false);
    expect(validateAddress('Modbus TCP', '').ok).toBe(false);
  });

  it('S7 接受 DB 地址并校验位语法', () => {
    expect(validateAddress('Siemens Profinet', 'DB301.Real10').ok).toBe(true);
    expect(validateAddress('Siemens Profinet', 'DB301.DBX20.0').ok).toBe(true);
    // DBX 缺位号
    expect(validateAddress('Siemens Profinet', 'DB301.DBX20').ok).toBe(false);
    // 非位类型带位号
    expect(validateAddress('Siemens Profinet', 'DB301.Real10.1').ok).toBe(false);
  });

  it('OPC UA 校验 NodeId 格式', () => {
    expect(validateAddress('OPC UA', 'ns=2;s=Pressure_Sensor_01').ok).toBe(true);
    expect(validateAddress('OPC UA', 'ns=1;i=2258').ok).toBe(true);
    expect(validateAddress('OPC UA', ' Pressure_Sensor').ok).toBe(false);
  });

  it('每种协议都有提示文案', () => {
    expect(addressHint('Modbus TCP')).toBeTruthy();
    expect(addressHint('Siemens Profinet')).toBeTruthy();
  });
});
