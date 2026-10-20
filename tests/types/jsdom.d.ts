declare module 'jsdom' {
  export class VirtualConsole {
    on(event: 'jsdomError', listener: (error: Error) => void): this;
  }
  export class JSDOM {
    constructor(
      html?: string,
      options?: { runScripts?: 'dangerously'; virtualConsole?: VirtualConsole }
    );
    window: Window & typeof globalThis & { close(): void };
  }
}
