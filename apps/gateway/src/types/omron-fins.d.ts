declare module 'omron-fins' {
  class FinsClient {
    constructor(port?: number, host?: string);
    connect(cb: (err: Error | null) => void): void;
    memoryRead(address: string, count?: number, cb?: (err: Error | null, res: unknown) => void): unknown;
    write(address: string, value: unknown, cb?: (err: Error | null) => void): unknown;
    close(cb?: () => void): void;
  }
  export = FinsClient;
}
