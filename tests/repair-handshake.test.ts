// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handshakeForToken, pairingToken } from '../apps/web/src/api/pairing-token';

/**
 * D4. The four assertions the research called mandatory, and the reason it did:
 * the risk of this whole feature is concentrated in one message listener, and a
 * mistake in the origin or nonce check turns a fix for lost work into a way for
 * any page that can frame the local app to harvest a live session token.
 *
 * So the checks are tested as refusals, not as a happy path with a note.
 */

const AGENT = 'http://127.0.0.1:43140';
const VALID_TOKEN = 'a'.repeat(64);

/** The frame the handshake creates, once it has been appended. */
function handshakeFrame(): HTMLIFrameElement {
  const frame = document.querySelector('iframe');
  if (!frame) throw new Error('the handshake did not create a frame');
  return frame as HTMLIFrameElement;
}

/** Posts a message as the local app's document would, or as an attacker might. */
function post(options: {
  origin?: string;
  source?: unknown;
  nonce?: string;
  token?: string;
  type?: string;
}) {
  const frame = handshakeFrame();
  const nonce = options.nonce ?? new URL(frame.src).searchParams.get('nonce') ?? '';
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        type: options.type ?? 'soty:pairing',
        nonce,
        token: options.token ?? VALID_TOKEN
      },
      origin: options.origin ?? AGENT,
      source: (options.source ?? frame.contentWindow) as MessageEventSource
    })
  );
}

afterEach(() => {
  localStorage.clear();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
  vi.useRealTimers();
});

describe('the in-page re-pair', () => {
  it('adopts a token from the frame it created', async () => {
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    post({});
    await expect(pending).resolves.toBe(VALID_TOKEN);
  });

  it('refuses a message from another origin', async () => {
    vi.useFakeTimers();
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    // The same shape, the same nonce, a different sender. Accepting this is the
    // difference between a handshake and a token leak.
    post({ origin: 'https://not-the-agent.example' });
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it('refuses a message carrying the wrong nonce', async () => {
    vi.useFakeTimers();
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    // Right origin, right frame, wrong conversation: this is what a replayed or
    // guessed message looks like.
    post({ nonce: 'not-the-nonce-we-sent' });
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it('refuses a message that did not come from its own frame', async () => {
    vi.useFakeTimers();
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    post({ source: window });
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it('refuses something shaped like a token but not one', async () => {
    vi.useFakeTimers();
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    post({ token: 'nope' });
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it('gives up in time for the caller to fall back to navigation', async () => {
    vi.useFakeTimers();
    const pending = handshakeForToken(AGENT);
    await Promise.resolve();
    // Nothing answers. Resolving null rather than hanging is what keeps the
    // existing full-page navigation available, so this is never worse than the
    // behaviour it replaces.
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBeNull();
  });
});

describe('several tabs noticing at once', () => {
  it('performs exactly one handshake', async () => {
    vi.useFakeTimers();
    // Two tabs share one browser, so they share the claim: the second finds the
    // first holding it and waits for the broadcast instead of framing its own.
    const first = handshakeForToken(AGENT);
    await Promise.resolve();
    const second = handshakeForToken(AGENT);
    await Promise.resolve();

    expect(document.querySelectorAll('iframe').length).toBe(1);

    post({});
    await expect(first).resolves.toBe(VALID_TOKEN);
    vi.advanceTimersByTime(5_000);
    // The waiting tab resolves from the shared token rather than duplicating
    // the work; null here means it timed out, which is the safe direction.
    await expect(second).resolves.toBe(pairingToken() || null);
  });
});
