import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PRODUCTION_BACKEND_ORIGIN } from '../packages/shared/src/release';
import { callCatalogVideoForegroundHttp } from '../apps/agent/src/team-bridge/catalog-video-foreground-http';

/**
 * The agent calls the backend on its own for native restitch and catalog video
 * recovery, so it carries the production origin as a constant. That constant
 * and the origin the production web build is given must be one project, or the
 * agent would recover work in a database the user's tab never wrote to.
 */
it('names the same production project the web build is paired with', () => {
  const env = readFileSync('apps/web/.env.production', 'utf8');
  const url = /^VITE_SUPABASE_URL=(.+)$/mu.exec(env)?.[1]?.trim();
  expect(url).toBeTruthy();
  expect(new URL(url!).origin).toBe(PRODUCTION_BACKEND_ORIGIN);
  expect(PRODUCTION_BACKEND_ORIGIN).toMatch(/^https:\/\/[a-z0-9-]+\.supabase\.co$/u);
});

it('lets the foreground transport reach HTTPS or a loopback stack, and nothing else', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: true, value: {} }), {
      headers: { 'content-type': 'application/json' }
    });
  for (const origin of [PRODUCTION_BACKEND_ORIGIN, 'http://127.0.0.1:54321'])
    await expect(
      callCatalogVideoForegroundHttp(origin, 'await', {}, undefined, undefined, fetchImpl)
    ).resolves.toEqual({});
  for (const origin of [
    'http://soty.example.invalid',
    'https://x.supabase.co/functions',
    'not a url',
    'https://user:pw@x.supabase.co'
  ])
    await expect(
      callCatalogVideoForegroundHttp(origin, 'await', {}, undefined, undefined, fetchImpl)
    ).rejects.toThrow('INVALID_INPUT');
});
