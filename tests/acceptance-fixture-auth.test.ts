import { afterEach, expect, it, vi } from 'vitest';
import { ensureFixtureAuth, loginFixtureActor } from '../scripts/acceptance/fixtures.mjs';
const target = {
  kind: 'local',
  environment: 'beta',
  namespace: 'acceptance-auth-test',
  marker: 'soty-acceptance',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};
const actor = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'acceptance-auth-test-solo@soty.invalid',
  password: 'a'.repeat(32),
  provisioned: false
};
const status = {
  API_URL: target.authUrl,
  DB_URL: target.databaseUrl,
  ANON_KEY: 'test-public',
  SERVICE_ROLE_KEY: 'test-bootstrap'
};
afterEach(() => vi.unstubAllGlobals());
it('checks target and synthetic ownership before Auth bootstrap', async () => {
  const transport = vi.fn();
  vi.stubGlobal('fetch', transport);
  await expect(ensureFixtureAuth({ kind: 'production' }, status, 'SOLO', actor)).rejects.toThrow(
    'ACCEPTANCE_TARGET_UNSAFE'
  );
  await expect(
    ensureFixtureAuth(target, status, 'SOLO', { ...actor, email: 'real@example.com' })
  ).rejects.toThrow('ACCEPTANCE_FIXTURE_MISMATCH');
  expect(transport).not.toHaveBeenCalled();
});
it('refuses adoption of an Auth row with mismatched namespace or identity', async () => {
  const transport = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: actor.id,
        email: actor.email,
        user_metadata: { acceptance_namespace: 'acceptance-foreign' }
      })
    )
  );
  vi.stubGlobal('fetch', transport);
  await expect(ensureFixtureAuth(target, status, 'SOLO', actor)).rejects.toThrow(
    'ACCEPTANCE_FIXTURE_MISMATCH'
  );
  expect(transport).toHaveBeenCalledTimes(1);
});
it('binds login token subject to the expected fixture identity', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ role: 'authenticated', sub: '22222222-2222-4222-8222-222222222222', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: token,
          user: { id: actor.id, user_metadata: { acceptance_namespace: target.namespace } }
        })
      )
    )
  );
  await expect(loginFixtureActor(target, status, actor)).rejects.toThrow(
    'ACCEPTANCE_ACTOR_INVALID'
  );
});
