import { describe, expect, it } from 'vitest';
import { runAttempt } from './support/adversarial.js';
import { admissionSuite } from './support/adversarial/admission.js';

/**
 * C4, C5, C6 (FR-023, FR-024). Request admission, attacked over a real socket.
 *
 * `tests/agent-http.test.ts` ("request admission") covers the same hook through `inject`;
 * this file is the attack table SC-008 counts, run against a listening agent so a header a
 * client library would never send still reaches the server. The table is shared with
 * `tests/adversarial-suite-size.test.ts`.
 */

describe('every hostile request is refused', () => {
  it.each(admissionSuite.attempts.map(attempt => [attempt.name, attempt] as const))(
    '%s',
    async (_name, attempt) => {
      const result = await runAttempt(admissionSuite, attempt);
      expect(result.refused, result.evidence).toBe(true);
    },
    30_000
  );
});

describe('the legitimate request still works', () => {
  it('answers the health probe from this machine', async () => {
    const target = await admissionSuite.start();
    try {
      expect((await target.get('/health')).status).toBe(200);
      expect((await target.get('/health', { Host: `localhost:${target.port}` })).status).toBe(200);
    } finally {
      await target.stop();
    }
  });

  it('answers an API call that carries the token, with or without an allowed Origin', async () => {
    const target = await admissionSuite.start();
    try {
      const token = { 'X-Session-Token': target.agent.token };
      expect((await target.get('/api/health', token)).status).toBe(200);
      const allowed = [...target.agent.allowedOrigins][0]!;
      expect((await target.get('/api/health', { ...token, Origin: allowed })).status).toBe(200);
    } finally {
      await target.stop();
    }
  });

  it('still routes a percent-encoded API path once it carries the token', async () => {
    // The fix decides by the route that runs, so a legitimate request is not refused merely
    // for being spelled differently — it is held to the same check as the plain spelling.
    const target = await admissionSuite.start();
    try {
      const response = await target.get('/%61pi/health', { 'X-Session-Token': target.agent.token });
      expect(response.status).toBe(200);
    } finally {
      await target.stop();
    }
  });
});
