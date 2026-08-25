// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimAutomaticPairing,
  consumePairingToken,
  verifyPairingToken,
  hasPairingToken,
  onPairingToken,
  pairingToken,
  releaseAutomaticPairing
} from '../apps/web/src/api/pairing-token';

const TOKEN = 'a'.repeat(64);

describe('the pairing token the Agent hands over', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });

  it('is read before the app renders, so the sign-in redirect cannot lose it', async () => {
    // The whole bug in one line: the Agent's "Open Soty" lands on `/#agentToken=…`,
    // and on an origin with no session that page is the sign-in screen, whose
    // redirect rewrites the URL. Reading the fragment only once AgentProvider
    // mounts — which happens after authentication — is always too late.
    const main = await readFile('apps/web/src/main.tsx', 'utf8');

    expect(main).toContain("import { consumePairingToken } from './api/pairing-token'");
    expect(main.indexOf('consumePairingToken()')).toBeLessThan(main.indexOf('createRoot'));
  });

  it('is taken out of the address bar immediately, and held until it is proven', async () => {
    history.replaceState(null, '', `/compressor?a=1#agentToken=${TOKEN}`);

    expect(consumePairingToken()).toBe(true);

    // Out of the URL at once — a token in the address bar reaches history, a
    // screenshot and whatever gets pasted next.
    expect(location.hash).toBe('');
    expect(`${location.pathname}${location.search}`).toBe('/compressor?a=1');

    // But not adopted yet. The value arrives from wherever the browser was last
    // sent, including a link somebody else wrote, and adopting an unverified
    // one replaces the working token in every open tab.
    expect(pairingToken()).toBe('');
    expect(localStorage.getItem('agentToken')).toBe(null);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    );
    await expect(verifyPairingToken('http://127.0.0.1:43140')).resolves.toBe(true);

    expect(pairingToken()).toBe(TOKEN);
    expect(hasPairingToken()).toBe(true);
    expect(localStorage.getItem('agentToken')).toBe(TOKEN);
    vi.unstubAllGlobals();
  });

  it('ignores a fragment that is not a token', () => {
    history.replaceState(null, '', '/#agentToken=nonsense');

    expect(consumePairingToken()).toBe(false);
  });

  it('shares a token paired in another tab, notifying every listener', async () => {
    const other = 'b'.repeat(64);
    const seen: string[] = [];
    onPairingToken(() => seen.push('first'));
    const dropSecond = onPairingToken(() => seen.push('second'));

    new BroadcastChannel('local-video-compressor-pairing').postMessage(other);
    await new Promise(resolve => setTimeout(resolve, 0));

    // A second subscriber must not silently evict the first: that shows up only
    // as "sometimes it does not connect".
    expect(seen).toEqual(['first', 'second']);
    expect(pairingToken()).toBe(other);
    dropSecond();
  });

  it('re-pairs by itself twice, then leaves it to the user', () => {
    // Automatic pairing is a full navigation back to this page, so a token the
    // Agent keeps rejecting would spin the tab forever.
    const start = Date.parse('2026-08-20T10:00:00Z');

    expect(claimAutomaticPairing(start)).toBe(true);
    expect(claimAutomaticPairing(start + 1_000)).toBe(true);
    expect(claimAutomaticPairing(start + 2_000)).toBe(false);
  });

  it('opens the budget again a minute later, and the moment a connection works', () => {
    const start = Date.parse('2026-08-20T10:00:00Z');
    claimAutomaticPairing(start);
    claimAutomaticPairing(start);
    expect(claimAutomaticPairing(start)).toBe(false);

    expect(claimAutomaticPairing(start + 61_000)).toBe(true);

    releaseAutomaticPairing();
    expect(claimAutomaticPairing(start + 61_000)).toBe(true);
  });
});
