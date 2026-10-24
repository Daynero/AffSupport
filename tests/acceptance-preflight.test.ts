import { describe, expect, it } from 'vitest';
import { functionProbeHealthy } from '../scripts/acceptance/preflight.mjs';
describe('live function readiness evidence', () => {
  it('requires a structured application rejection rather than a bare CORS or gateway 403', async () => {
    expect(await functionProbeHealthy(new Response(null, { status: 403 }))).toBe(false);
    expect(
      await functionProbeHealthy(
        new Response('{"ok":false,"error":{"code":"INVALID_INPUT"}}', { status: 400 })
      )
    ).toBe(true);
    expect(
      await functionProbeHealthy(
        new Response('{"ok":false,"error":{"code":"AUTH_REQUIRED"}}', { status: 401 })
      )
    ).toBe(true);
    expect(
      await functionProbeHealthy(
        new Response('{"ok":false,"error":{"code":"DRIVE_UNAVAILABLE"}}', { status: 503 })
      )
    ).toBe(false);
    expect(
      await functionProbeHealthy(
        new Response('{"code":401,"message":"Invalid JWT"}', { status: 401 })
      )
    ).toBe(false);
  });
});
