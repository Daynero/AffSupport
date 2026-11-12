import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  NATIVE_UPDATE_LIMITS,
  updateRecord,
  isNativeUpdateCode,
  type NativeUpdateSnapshot,
  isNativeUpdateSnapshot
} from '@video-compressor/shared';
import { AppUpdateError } from './coordinator.js';

/** One bounded request per connection; the secret never crosses the browser API. */
export class NativeUpdateBridge {
  constructor(
    private readonly socketPath: string,
    private readonly token: string
  ) {}
  async request(action: string, payload: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const nonce = randomUUID();
      const frame = Buffer.from(
        JSON.stringify({ schemaVersion: 1, nonce, token: this.token, action, payload }) + '\n'
      );
      if (frame.length > NATIVE_UPDATE_LIMITS.frameBytes) {
        reject(new AppUpdateError('APP_UPDATE_INVALID'));
        return;
      }
      const socket = net.createConnection(this.socketPath);
      let received = Buffer.alloc(0);
      const finish = (error: AppUpdateError | null, value?: unknown) => {
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.setTimeout(NATIVE_UPDATE_LIMITS.requestTimeoutMs, () =>
        finish(new AppUpdateError('APP_UPDATE_NATIVE_UNAVAILABLE'))
      );
      socket.once('connect', () => socket.write(frame));
      socket.once('error', () => finish(new AppUpdateError('APP_UPDATE_NATIVE_UNAVAILABLE')));
      socket.once('end', () => {
        if (!received.includes(10)) finish(new AppUpdateError('APP_UPDATE_NATIVE_UNAVAILABLE'));
      });
      socket.on('data', (data: Buffer) => {
        if (received.length + data.length > NATIVE_UPDATE_LIMITS.frameBytes) {
          finish(new AppUpdateError('APP_UPDATE_INVALID'));
          return;
        }
        received = Buffer.concat([received, data]);
        const end = received.indexOf(10);
        if (end < 0) return;
        try {
          const reply: unknown = JSON.parse(received.subarray(0, end).toString('utf8'));
          if (!updateRecord(reply) || reply.nonce !== nonce || reply.schemaVersion !== 1)
            throw new Error();
          if (reply.error !== undefined) {
            finish(
              new AppUpdateError(
                isNativeUpdateCode(reply.error) ? reply.error : 'APP_UPDATE_NATIVE_UNAVAILABLE'
              )
            );
          } else finish(null, reply.value);
        } catch {
          finish(new AppUpdateError('APP_UPDATE_INVALID'));
        }
      });
    });
  }
  async snapshot(): Promise<NativeUpdateSnapshot> {
    const value = await this.request('snapshot');
    if (!isNativeUpdateSnapshot(value)) throw new AppUpdateError('APP_UPDATE_INVALID');
    return value;
  }
}
