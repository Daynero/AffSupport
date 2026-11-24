// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginGoogleSignIn,
  finishGoogleSignIn,
  forgetGoogleSignIn,
  isDirectGoogleCallback
} from '../apps/web/src/auth/google-sign-in';

const endpoint = { supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_x' };

function answer(value: unknown, status = 200) {
  return new Response(
    JSON.stringify(status < 300 ? { ok: true, value } : { ok: false, error: value }),
    {
      status,
      headers: { 'content-type': 'application/json' }
    }
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  forgetGoogleSignIn();
});

const STORAGE_KEY = 'soty.google-sign-in.v1';
const direct = () =>
  answer({ mode: 'direct', authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });

async function startedFlow(): Promise<string> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(direct()));
  await beginGoogleSignIn(endpoint);
  return (JSON.parse(sessionStorage.getItem(STORAGE_KEY)!) as { state: string }).state;
}

describe('the browser half of the site-returning Google sign-in', () => {
  it('keeps the flow for one round trip and finishes it with the verifier and raw nonce', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        answer({
          mode: 'direct',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1'
        })
      )
      .mockResolvedValueOnce(answer({ idToken: 'h.p.s' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(beginGoogleSignIn(endpoint)).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    const start = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, string>;
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://project.supabase.co/functions/v1/google-sign-in'
    );
    expect(start.action).toBe('start');
    expect(start.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(start.nonceHash).toMatch(/^[0-9a-f]{64}$/u);

    expect(isDirectGoogleCallback(new URLSearchParams({ state: 'someone-else' }))).toBe(false);
    expect(isDirectGoogleCallback(new URLSearchParams())).toBe(false);
    expect(isDirectGoogleCallback(new URLSearchParams({ state: start.state! }))).toBe(true);

    const finished = await finishGoogleSignIn(endpoint, 'the-code');
    const exchange = JSON.parse(fetchMock.mock.calls[1]![1].body as string) as Record<
      string,
      string
    >;
    expect(exchange).toMatchObject({ action: 'exchange', code: 'the-code' });
    expect(exchange.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(finished.idToken).toBe('h.p.s');
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(finished.nonce))
    );
    expect([...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')).toBe(
      start.nonceHash
    );

    // Spent: a second arrival with the same state is not this flow any more.
    expect(isDirectGoogleCallback(new URLSearchParams({ state: start.state! }))).toBe(false);
  });

  it('uses the provider redirect only where the direct path does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer({ mode: 'legacy', reason: 'client_mismatch' }))
    );
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer({ mode: 'legacy', reason: 'not_configured' }))
    );
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('tries a passing failure again instead of taking a redirect Google refuses (2026-11-23)', async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(answer({ mode: 'legacy', reason: 'provider_unreachable' }))
      .mockResolvedValueOnce(
        answer({
          mode: 'direct',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1'
        })
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(beginGoogleSignIn(endpoint, wait)).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    expect(wait).toHaveBeenCalledTimes(2);
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    await expect(beginGoogleSignIn(endpoint, wait)).rejects.toThrow('SIGN_IN_UNAVAILABLE');
    expect(sessionStorage.length).toBe(0);
  });

  it('reports an outage that outlasts the retries as unavailable, keeping its cause', async () => {
    const wait = vi.fn(async () => undefined);
    const offline = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', offline);
    const failure = await beginGoogleSignIn(endpoint, wait).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('SIGN_IN_UNAVAILABLE');
    // The page can still say why: the network never answered.
    expect(((failure as Error).cause as Error).message).toBe('NETWORK');
    expect(offline).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[700], [2000]]);

    // Supabase Auth unreachable behind a working function is the same passing outage —
    // never the provider redirect that Google refuses.
    wait.mockClear();
    const unreachable = vi
      .fn()
      .mockImplementation(async () => answer({ mode: 'legacy', reason: 'provider_unreachable' }));
    vi.stubGlobal('fetch', unreachable);
    const refused = await beginGoogleSignIn(endpoint, wait).catch((error: unknown) => error);
    expect((refused as Error).message).toBe('SIGN_IN_UNAVAILABLE');
    expect(((refused as Error).cause as Error).message).toBe('UNAVAILABLE');
    expect(unreachable).toHaveBeenCalledTimes(3);
    expect(sessionStorage.length).toBe(0);
  });

  it('treats an unreadable or refused answer from the function as passing, not as legacy', async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi
      .fn()
      // A gateway page instead of JSON.
      .mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 200 }))
      // Well-formed, but the function said it failed.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL' } }), { status: 200 })
      )
      .mockResolvedValueOnce(direct());
    vi.stubGlobal('fetch', fetcher);
    await expect(beginGoogleSignIn(endpoint, wait)).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('waits on the real clock between attempts when no wait is given', async () => {
    // Only setTimeout is faked: the digests run on the real event loop.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(direct());
    vi.stubGlobal('fetch', fetcher);
    const started = beginGoogleSignIn(endpoint);
    while (vi.getTimerCount() === 0) await new Promise(resolve => setImmediate(resolve));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(699);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(started).resolves.toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure of its own: only an outage is tried again', async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi.fn().mockImplementation(async () => direct());
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    await expect(beginGoogleSignIn(endpoint, wait)).rejects.toThrow('full');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('finishes only a flow it started, and says why an exchange was refused', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(finishGoogleSignIn(endpoint, 'the-code')).rejects.toThrow('WRONG_STATE');
    expect(fetcher).not.toHaveBeenCalled();

    await startedFlow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(answer({ code: 'CODE_EXPIRED' }, 400)));
    await expect(finishGoogleSignIn(endpoint, 'the-code')).rejects.toThrow('CODE_EXPIRED');
    // Spent even when refused: the same code is not exchanged twice.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    await startedFlow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('upstream down', { status: 502 }))
    );
    await expect(finishGoogleSignIn(endpoint, 'the-code')).rejects.toThrow('UNAVAILABLE');

    await startedFlow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 400 }))
    );
    await expect(finishGoogleSignIn(endpoint, 'the-code')).rejects.toThrow('UNAVAILABLE');
  });

  it('ignores a stored flow that is unreadable or older than its lifetime', async () => {
    sessionStorage.setItem(STORAGE_KEY, '{not json');
    expect(isDirectGoogleCallback(new URLSearchParams({ state: 'anything' }))).toBe(false);

    const state = await startedFlow();
    expect(isDirectGoogleCallback(new URLSearchParams({ state }))).toBe(true);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60 * 1000 + 1);
    expect(isDirectGoogleCallback(new URLSearchParams({ state }))).toBe(false);
    await expect(finishGoogleSignIn(endpoint, 'the-code')).rejects.toThrow('WRONG_STATE');
  });

  it('forgets quietly where storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => forgetGoogleSignIn()).not.toThrow();
  });
});
