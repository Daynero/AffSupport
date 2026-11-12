import { describe, expect, it, vi } from 'vitest';
import { DRIVE_READ_RETRY_DELAYS_MS, GoogleDriveClient } from '../supabase/functions/_shared/drive';
import {
  refreshGoogleAccessToken,
  TOKEN_REFRESH_RETRY_DELAYS_MS
} from '../supabase/functions/_shared/credentials';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';

/**
 * Production 2026-11-12: one unanswered Drive call during a launch's source check reached the
 * person as «Google Drive не відповідає… Операція може ще виконуватися». Nothing had been
 * created; pressing Retry worked. A read and a token refresh change nothing, so the server
 * now asks again itself; a write keeps its single attempt.
 */
const TOKEN = 'drive-access-token-long-enough';
const FILE = {
  id: 'file-1',
  name: 'TR_16.mp4',
  mimeType: 'video/mp4',
  parents: ['folder-1'],
  trashed: false,
  capabilities: { canDownload: true }
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const rate = () => json(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } });
const denied = () => json(403, { error: { errors: [{ reason: 'insufficientFilePermissions' }] } });

function drive(...answers: Array<Response | Error>) {
  const fetchImpl = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  const waits: number[] = [];
  const client = new GoogleDriveClient(TOKEN, fetchImpl as unknown as typeof fetch, async ms => {
    waits.push(ms);
  });
  return { client, fetchImpl, waits };
}
async function code(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof TeamFunctionError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('Drive reads ride out a transient failure', () => {
  it('asks again after a 5xx, a lost connection and «slow down», three attempts in all', async () => {
    const a = drive(json(503, {}), json(502, {}), json(200, FILE));
    expect((await a.client.getFile('file-1')).id).toBe('file-1');
    expect(a.fetchImpl).toHaveBeenCalledTimes(3);
    expect(a.waits).toEqual([...DRIVE_READ_RETRY_DELAYS_MS]);

    const b = drive(new TypeError('connection reset'), json(200, FILE));
    expect((await b.client.getFile('file-1')).id).toBe('file-1');

    const c = drive(rate(), json(429, {}), json(200, FILE));
    expect((await c.client.getFile('file-1')).id).toBe('file-1');
  });

  it('still reports Drive unavailable after three failed attempts', async () => {
    const a = drive(json(503, {}), json(503, {}), json(503, {}));
    expect(await code(() => a.client.getFile('file-1'))).toBe('DRIVE_UNAVAILABLE');
    expect(a.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('answers «you may not», a timeout and a cancellation at once', async () => {
    const a = drive(denied());
    expect(await code(() => a.client.getFile('file-1'))).toBe('PERMISSION_DENIED');
    expect(a.fetchImpl).toHaveBeenCalledTimes(1);
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const b = drive(timeout);
    expect(await code(() => b.client.getFile('file-1'))).toBe('DRIVE_UNAVAILABLE');
    expect(b.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps a single attempt for a write: a lost reply never proves it did not apply', async () => {
    const a = drive(json(503, {}), json(200, FILE));
    expect(await code(() => a.client.createFolder({ name: 'x', parentId: 'folder-1' }))).toBe(
      'DRIVE_UNAVAILABLE'
    );
    expect(a.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never retries past a request deadline', async () => {
    const a = drive(json(503, {}), json(200, FILE));
    const bounded = a.client.withRequestDeadline(Date.now() - 1);
    expect(await code(() => bounded.getFile('file-1'))).toBe('DRIVE_UNAVAILABLE');
    expect(a.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Google token refresh rides out a transient failure', () => {
  const input = (fetchImpl: typeof fetch, waits: number[]) => ({
    credential: {
      credentialId: '00000000-0000-4000-8000-000000000001',
      refreshToken: 'google-refresh-token-long-enough'
    } as never,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    oauthMode: 'verified',
    productionSignals: {
      siteUrl: 'http://127.0.0.1:5173',
      requestOrigin: 'http://127.0.0.1:5173',
      transactionOrigin: 'http://127.0.0.1:5173'
    },
    fetchImpl,
    sleep: async (ms: number) => {
      waits.push(ms);
    }
  });
  const token = () => json(200, { access_token: 'a'.repeat(40), expires_in: 3599 });

  it('asks the token endpoint again after an unreachable answer or a 5xx', async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(token());
    const result = await refreshGoogleAccessToken(input(fetchImpl, waits));
    expect(result.accessToken).toHaveLength(40);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([...TOKEN_REFRESH_RETRY_DELAYS_MS]);
  });

  it('treats a refused grant as final at once', async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(json(400, { error: 'invalid_grant' }));
    await expect(refreshGoogleAccessToken(input(fetchImpl, waits))).rejects.toEqual(
      expect.objectContaining({ code: 'NEEDS_REAUTH' })
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
