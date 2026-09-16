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
  vi.unstubAllGlobals();
  forgetGoogleSignIn();
});

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

  it('falls back to the provider redirect when the function says legacy or cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer({ mode: 'legacy', reason: 'client_mismatch' }))
    );
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(beginGoogleSignIn(endpoint)).resolves.toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
