declare class PLC {
  constructor(ipAddress?: string, backplane?: number, slot?: number);
  connect(ip?: string, backplane?: number, slot?: number): Promise<void>;
  read(tagName: string): Promise<unknown>;
  write(tagName: string, value: unknown): Promise<unknown>;
  destroy(): Promise<void>;
}
declare module 'st-ethernet-ip' {
  export = PLC;
}
