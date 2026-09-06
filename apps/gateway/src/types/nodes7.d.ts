/** nodes7 无官方类型，按实际用到的 API 声明（纯 JS 库，0.3.18 无事件发射器） */
declare class NodeS7 {
  constructor(opts?: unknown);
  initiateConnection(
    params: { port?: number; host: string; rack?: number; slot?: number; name?: string },
    cb: (err?: Error) => void,
  ): void;
  setTranslationCB(cb: (tag: string) => string | undefined): void;
  addItems(tags: string[]): void;
  readAllItems(cb: (err: Error | undefined, values: Record<string, number | boolean | string>) => void): void;
  writeItems(
    tags: string[],
    values: Array<number | boolean | string>,
    cb: (err?: Error) => void,
  ): void;
  dropConnection(cb?: () => void): void;
}

declare module 'nodes7' {
  export = NodeS7;
}
