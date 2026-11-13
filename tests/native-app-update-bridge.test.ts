import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeUpdateBridge } from '../apps/agent/src/update/native-bridge';
describe.runIf(process.platform !== 'win32')('private native updater frames', () => {
  it('binds every reply to the nonce and rejects a substituted frame', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soty-upd-'));
    const socket = path.join(directory, 'host.sock');
    let valid = true;
    const server = net.createServer(client =>
      client.once('data', data => {
        const frame = JSON.parse(data.toString());
        expect(frame.token).toBe('private');
        client.end(
          JSON.stringify({
            schemaVersion: 1,
            nonce: valid ? frame.nonce : 'other',
            value: { ok: true }
          }) + '\n'
        );
      })
    );
    try {
      await new Promise<void>(resolve => server.listen(socket, resolve));
      const bridge = new NativeUpdateBridge(socket, 'private');
      expect(await bridge.request('pending')).toEqual({ ok: true });
      valid = false;
      await expect(bridge.request('pending')).rejects.toThrow('APP_UPDATE_INVALID');
      await expect(bridge.request('offer', { payload: 'x'.repeat(262144) })).rejects.toThrow(
        'APP_UPDATE_INVALID'
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
