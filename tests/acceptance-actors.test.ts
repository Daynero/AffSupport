import { describe, expect, it, vi } from 'vitest';
import { createActor } from '../scripts/acceptance/actors.mjs';
const target = {
  kind: 'local',
  environment: 'beta',
  namespace: 'acceptance-test-001',
  marker: 'soty-acceptance',
  authUrl: 'http://127.0.0.1:54321',
  functionsUrl: 'http://127.0.0.1:54321/functions/v1',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
};
const token = (role: string) =>
  `header.${Buffer.from(JSON.stringify({ role, sub: '11111111-1111-4111-8111-111111111111', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`;
describe('real actor request boundary', () => {
  it('accepts a successful void RPC while retaining response validation elsewhere', async () => {
    const credentials = { accessToken: token('authenticated'), publicKey: 'local-public' };
    const actor = createActor(target, credentials, async () => new Response(null, { status: 204 }));
    expect(await actor.rpc('begin_task_upload', {})).toEqual({ ok: true, status: 204, data: null });
    expect(await actor.invoke('team-invitations', {})).toEqual({
      ok: false,
      status: 204,
      code: 'RESPONSE_INVALID'
    });
    const malformed = createActor(
      target,
      credentials,
      async () => new Response('', { status: 200 })
    );
    expect(await malformed.rpc('begin_task_upload', {})).toEqual({
      ok: false,
      status: 200,
      code: 'RESPONSE_INVALID'
    });
  });

  it('rejects a token belonging to a different expected fixture actor', () => {
    expect(() =>
      createActor(target, {
        accessToken: token('authenticated'),
        publicKey: 'local-public',
        expectedSubject: '22222222-2222-4222-8222-222222222222'
      })
    ).toThrow('ACCEPTANCE_ACTOR_INVALID');
  });
  it('uses the same actor authorization for the closed invitation function endpoint', async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(new Response('{"ok":true,"value":true}', { status: 200 }));
    const actor = createActor(
      target,
      { accessToken: token('authenticated'), publicKey: 'local-public' },
      transport
    );
    const result = await actor.invoke('team-invitations', {
      action: 'revoke',
      invitationId: 'synthetic'
    });
    expect(result.data).toBe(true);
    expect(transport.mock.calls[0][1].headers.Origin).toBe('http://127.0.0.1:5175');
    expect(transport.mock.calls[0][0]).toBe('http://127.0.0.1:54321/functions/v1/team-invitations');
    await expect(actor.invoke('../auth/v1/admin', {})).rejects.toThrow(
      'ACCEPTANCE_FUNCTION_INVALID'
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['service_role', 'anon', 'supabase_admin'])(
    'rejects privileged/non-user role %s before network',
    role => {
      expect(() =>
        createActor(target, { accessToken: token(role), publicKey: 'local-public' })
      ).toThrow('ACCEPTANCE_ACTOR_INVALID');
    }
  );
  it('uses actor JWT and refuses paths outside a named RPC', async () => {
    const transport = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    const accessToken = token('authenticated');
    const actor = createActor(target, { accessToken, publicKey: 'local-public' }, transport);
    await actor.rpc('list_my_teams', {});
    expect(transport.mock.calls[0][0]).toBe('http://127.0.0.1:54321/rest/v1/rpc/list_my_teams');
    expect(transport.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${accessToken}`);
    await expect(actor.rpc('../admin/users', {})).rejects.toThrow('ACCEPTANCE_RPC_INVALID');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps server denial distinct from a transport failure without leaking provider payloads', async () => {
    const actor = createActor(
      target,
      { accessToken: token('authenticated'), publicKey: 'local-public' },
      vi.fn().mockResolvedValue(
        new Response('{"code":"42501","message":"PERMISSION_DENIED","private":"secret"}', {
          status: 403
        })
      )
    );
    const result = await actor.rpc('list_my_teams', {});
    expect(result).toEqual({ ok: false, status: 403, code: '42501' });
  });
});
