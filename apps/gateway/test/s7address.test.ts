import { describe, expect, it } from 'vitest';
import { toNodes7Address } from '../src/engine/drivers/s7';

describe('toNodes7Address（S7 地址语法转换）', () => {
  it('Real → REAL', () => {
    expect(toNodes7Address('DB301.Real10')).toBe('DB301,REAL10');
  });
  it('DBX 位地址 → X', () => {
    expect(toNodes7Address('DB301.DBX20.0')).toBe('DB301,X20.0');
  });
  it('DInt/Int/Word/DWord/Byte', () => {
    expect(toNodes7Address('DB1.DInt4')).toBe('DB1,DINT4');
    expect(toNodes7Address('DB1.Int2')).toBe('DB1,INT2');
    expect(toNodes7Address('DB1.DBW6')).toBe('DB1,WORD6');
    expect(toNodes7Address('DB1.DBD8')).toBe('DB1,DWORD8');
    expect(toNodes7Address('DB1.DBB1')).toBe('DB1,BYTE1');
  });
  it('非法地址抛错', () => {
    expect(() => toNodes7Address('MW10')).toThrow();
    expect(() => toNodes7Address('DB1.Foo9')).toThrow();
  });
});
