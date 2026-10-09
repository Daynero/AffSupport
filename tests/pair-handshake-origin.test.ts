import { afterEach, describe, expect, it } from 'vitest';
import { startMinimalAgent, type MinimalAgent } from './support/minimal-agent.js';

/**
 * Which page `/pair/handshake` will hand the token to.
 *
 * The handshake used to admit one framing origin — the hosted site — so the local copy at
 * `http://127.0.0.1:<port>`, which is where Safari users live because the hosted site
 * cannot reach loopback from there, always fell back to a full-page navigation that threw
 * the page away (032 A2). The frame origin is now the request's own `Origin`, or the origin
 * of its `Referer`, when that origin is one the agent already trusts for API calls; and
 * the configured pairing origin otherwise. Never `*`, never an untrusted requester.
 */

const NONCE = 'handshake-nonce-01';
const HOSTED = 'https://soty.example';
const LOCAL = 'http://127.0.0.1:43120';
const LOCALHOST = 'http://localhost:43120';

let agent: MinimalAgent | null = null;

afterEach(async () => {
  await agent?.stop();
  agent = null;
});

async function handshake(headers: Record<string, string>) {
  const response = await agent!.app.inject({
    method: 'GET',
    url: `/pair/handshake?nonce=${NONCE}`,
    headers: { host: '127.0.0.1:43120', ...headers }
  });
  expect(response.statusCode).toBe(200);
  return {
    csp: response.headers['content-security-policy'],
    xfo: response.headers['x-frame-options'],
    body: response.body
  };
}

/** The `targetOrigin` argument the served script passes to `postMessage`. */
function targetOriginOf(body: string): string {
  const matched = /postMessage\(\{.*?\},("[^"]+")\);/u.exec(body);
  expect(matched).not.toBeNull();
  return JSON.parse(matched![1]) as string;
}

describe('/pair/handshake frame origin', () => {
  it('serves the local copy a handshake for itself', async () => {
    agent = await startMinimalAgent();
    const served = await handshake({ origin: LOCAL });
    expect(served.csp).toBe(`frame-ancestors ${LOCAL}`);
    expect(targetOriginOf(served.body)).toBe(LOCAL);
    expect(served.body).toContain(`nonce:${JSON.stringify(NONCE)}`);
    expect(served.body).toContain(`token:${JSON.stringify(agent.token)}`);
  });

  it('reads the origin from Referer when the frame request carries no Origin', async () => {
    // A frame's navigation request has a Referer — the framing page — and, on most
    // engines, no Origin header at all. Both spellings of the local copy are trusted.
    agent = await startMinimalAgent();
    const served = await handshake({ referer: `${LOCALHOST}/compressor?x=1` });
    expect(served.csp).toBe(`frame-ancestors ${LOCALHOST}`);
    expect(targetOriginOf(served.body)).toBe(LOCALHOST);
  });

  it('falls back to the pairing origin when the request names no origin', async () => {
    agent = await startMinimalAgent();
    const served = await handshake({});
    expect(served.csp).toBe(`frame-ancestors ${HOSTED}`);
    expect(targetOriginOf(served.body)).toBe(HOSTED);
  });

  it('never hands the token to an origin outside the allowlist', async () => {
    agent = await startMinimalAgent();
    const cases: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { referer: 'https://evil.example/frame.html' },
      { referer: 'not a url' },
      // A trusted Referer does not rescue an untrusted Origin: Origin is read first and
      // refused, then the Referer is consulted on its own merits.
      { origin: 'https://evil.example', referer: 'https://evil.example/page' }
    ];
    for (const headers of cases) {
      const served = await handshake(headers);
      expect(served.csp).toBe(`frame-ancestors ${HOSTED}`);
      expect(targetOriginOf(served.body)).toBe(HOSTED);
      expect(served.body).not.toContain('evil.example');
    }
  });

  it('keeps the X-Frame-Options fallback as it was', async () => {
    // Browsers that support `frame-ancestors` ignore X-Frame-Options when both are
    // present, which is what lets the hosted site frame the handshake today. The header
    // is kept for an engine without CSP, where SAMEORIGIN admits only the local copy.
    agent = await startMinimalAgent();
    const cases: Record<string, string>[] = [{}, { origin: LOCAL }];
    for (const headers of cases) {
      expect((await handshake(headers)).xfo).toBe('SAMEORIGIN');
    }
  });

  it('still prefers the hosted site when it is the one asking', async () => {
    agent = await startMinimalAgent();
    const served = await handshake({ referer: `${HOSTED}/transcription` });
    expect(served.csp).toBe(`frame-ancestors ${HOSTED}`);
    expect(targetOriginOf(served.body)).toBe(HOSTED);
  });
});
