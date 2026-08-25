// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumePairingToken,
  hasPendingPairingToken,
  pairingToken,
  verifyPairingToken
} from '../apps/web/src/api/pairing-token';

/**
 * A token in the URL fragment arrives from wherever the browser was last sent,
 * and that includes a link somebody else wrote.
 *
 * A planted token is not dangerous on its own — the local app rejects it. What
 * makes it worth defending against is what adopting one does: it replaces the
 * working token in local storage and broadcasts the replacement to every open
 * tab, so a user who clicks a link finds their session quietly broken, with
 * nothing on screen to explain it and nothing obvious to undo.
 */

const AGENT = 'http://127.0.0.1:43140';
const PLANTED = 'b'.repeat(64);
const REAL = 'c'.repeat(64);

function arriveWith(token: string) {
  history.replaceState(null, '', `/?x=1#agentToken=${token}`);
  return consumePairingToken();
}

afterEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a token that arrives in the URL', () => {
  it('is taken out of the address bar immediately', () => {
    arriveWith(PLANTED);
    // Before anything else is decided: a token in the URL ends up in history,
    // in a screenshot, and in whatever the user pastes next.
    expect(location.hash).toBe('');
    expect(location.search).toBe('?x=1');
  });

  it('is not stored until the local app answers for it', () => {
    arriveWith(PLANTED);
    expect(hasPendingPairingToken()).toBe(true);
    expect(pairingToken()).toBe('');
  });

  it('is discarded when the local app refuses it', async () => {
    arriveWith(PLANTED);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 }))
    );
    await expect(verifyPairingToken(AGENT)).resolves.toBe(false);
    // Nothing written, nothing broadcast, and the browser keeps whatever
    // working token it already had.
    expect(pairingToken()).toBe('');
    expect(hasPendingPairingToken()).toBe(false);
  });

  it('is discarded when the local app cannot be reached', async () => {
    arriveWith(PLANTED);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    // Unreachable is not the same as invalid — but it is not proof either, and
    // this path exists to stop unproven tokens being written.
    await expect(verifyPairingToken(AGENT)).resolves.toBe(false);
    expect(pairingToken()).toBe('');
  });

  it('is adopted once the local app confirms it', async () => {
    arriveWith(REAL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    );
    await expect(verifyPairingToken(AGENT)).resolves.toBe(true);
    expect(pairingToken()).toBe(REAL);
  });

  it('sends the candidate as a header, never as a query parameter', async () => {
    arriveWith(REAL);
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    await verifyPairingToken(AGENT);

    const [url, init] = fetchSpy.mock.calls[0];
    // A token in a URL is a token in a log, a referrer and a proxy cache.
    expect(url).not.toContain(REAL);
    expect((init.headers as Record<string, string>)['x-session-token']).toBe(REAL);
  });

  it('ignores a malformed value without holding it', () => {
    expect(arriveWith('not-a-token')).toBe(false);
    expect(hasPendingPairingToken()).toBe(false);
  });
});
