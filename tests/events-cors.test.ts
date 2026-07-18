import { describe, expect, it } from 'vitest';
import { eventStreamHeaders } from '../apps/agent/src/http';

describe('event stream CORS', () => {
  const hostedOrigin = 'https://wishly-app.pages.dev';
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
