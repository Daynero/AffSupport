import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { request } from 'node:http';
import { startPanelServer } from '../scripts/lib/release/panel-server.mjs';

describe('operator loopback security', () => {
  it('requires single-use capability, same-origin session and revision-fenced cancellation', async () => {
    const taskId = randomUUID();
    const task = { taskId, runId: randomUUID(), revision: 4 };
    const controller = Object.assign(new EventEmitter(), {
      store: { read: async () => task, list: async () => [task] },
      snapshot: async () => ({ ...task, schemaVersion: 1 }),
      cancel: async (_id: string, revision: number) => {
        if (revision !== 4) throw new Error('TASK_REVISION_CONFLICT');
        return task;
      }
    });
    const panel = await startPanelServer({
      controller,
      assetsRoot: path.resolve('release/automation/panel'),
      port: 0
    });
    const endpoint = `${panel.origin}/release-panel/api/tasks/${taskId}`;
    try {
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Origin: 'https://evil.example' } })).status).toBe(
        403
      );
      const badHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(endpoint, { headers: { Host: 'localhost:1' } }, res => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      expect(badHost).toBe(403);
      const capability = new URL(panel.bootstrapUrl(taskId)).hash.slice(1);
      const session = () =>
        fetch(`${panel.origin}/release-panel/api/session`, {
          method: 'POST',
          headers: { Origin: panel.origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability })
        });
      const reply = await session();
      expect(reply.status).toBe(200);
      const cookie = reply.headers.get('set-cookie')!.split(';')[0];
      expect(reply.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
      const { csrf } = await reply.json();
      expect((await session()).status).toBe(401);
      const snapshot = await fetch(endpoint, { headers: { Cookie: cookie } });
      expect(snapshot.status).toBe(200);
      expect((await snapshot.json()).logRef).toMatch(/^[a-f0-9-]{36}$/);
      const abort = new AbortController();
      const stream = await fetch(`${panel.origin}/release-panel/api/events?task=${taskId}`, {
        headers: { Cookie: cookie },
        signal: abort.signal
      });
      expect(stream.headers.get('content-type')).toBe('text/event-stream');
      const reader = stream.body!.getReader();
      const initial = new TextDecoder().decode((await reader.read()).value);
      expect(initial).toContain('event: snapshot');
      expect(initial).toContain('logRef');
      controller.emit('observation', { ...task, revision: 5 });
      const live = new TextDecoder().decode((await reader.read()).value);
      expect(live).toContain('event: observation');
      expect(live).toContain('logRef');
      abort.abort();
      reader.releaseLock();
      const cancel = (revision: number, csrfHeader: string) =>
        fetch(`${endpoint}/cancel`, {
          method: 'POST',
          headers: { Origin: panel.origin, Cookie: cookie, 'X-Release-CSRF': csrfHeader },
          body: JSON.stringify({ expectedRevision: revision, confirmation: 'cancel-release' })
        });
      expect((await cancel(4, 'wrong')).status).toBe(403);
      expect((await cancel(3, csrf)).status).toBe(409);
      expect((await cancel(4, csrf)).status).toBe(202);
      expect(
        (
          await fetch(`${panel.origin}/release-panel/api/logs/../../package.json`, {
            headers: { Cookie: cookie }
          })
        ).status
      ).toBe(404);
    } finally {
      await panel.close();
    }
  });
});
