import { describe, expect, it } from 'vitest';
import { eventStreamHeaders } from '../apps/agent/src/http';

describe('event stream CORS', () => {
  const hostedOrigin = 'https://soty.pp.ua';
  const allowedOrigins = new Set([hostedOrigin, 'http://127.0.0.1:5173']);

  it('allows the hosted UI to keep its cross-origin event stream open', () => {
    expect(eventStreamHeaders(hostedOrigin, allowedOrigins)).toMatchObject({
      Vary: 'Origin',
      'Access-Control-Allow-Origin': hostedOrigin,
      'Content-Type': 'text/event-stream'
    });
  });

  it('does not grant an untrusted origin access to events', () => {
    expect(eventStreamHeaders('https://example.com', allowedOrigins)).not.toHaveProperty(
      'Access-Control-Allow-Origin'
    );
  });
});

describe('the agent origin allowlist', () => {
  it('trusts both spellings of the local copy', async () => {
    // The agent listens on 127.0.0.1 and the same socket answers as `localhost`. A page
    // at the second spelling is the same page as at the first; refusing it turned every
    // POST from a `localhost` bookmark into a 403 while GETs kept working (032 A4).
    const { allowedOrigins: configured, config } = await import('../apps/agent/src/config.js');
    expect(configured.has(`http://127.0.0.1:${config.port}`)).toBe(true);
    expect(configured.has(`http://localhost:${config.port}`)).toBe(true);
    expect(eventStreamHeaders(`http://localhost:${config.port}`, configured)).toHaveProperty(
      'Access-Control-Allow-Origin',
      `http://localhost:${config.port}`
    );
    // The same host on any other port is a different origin, and stays out.
    expect(configured.has('http://localhost:1')).toBe(false);
  });
});
