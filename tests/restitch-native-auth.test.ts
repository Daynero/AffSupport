import { createClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { authorizeRestitchNativeEnrollment } from '../supabase/functions/drive-ops/restitch-native-auth';
const actor = 'b1780000-0000-4000-8000-000000000001',
  session = 'b1780000-0000-4000-8000-000000000002';
function token(value: unknown) {
  return (
    Buffer.from('{}').toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify(value)).toString('base64url') +
    '.synthetic-signature'
  );
}
function request(jwt: string) {
  return new Request('https://project.invalid/enroll', {
    headers: { authorization: 'Bearer ' + jwt }
  });
}
it('extracts a session only after real-user authorization has acknowledged the same signed subject', async () => {
  const jwt = token({ sub: actor, session_id: session, role: 'authenticated' });
  const getUser = vi.fn(async () => ({ data: { user: { id: actor } }, error: null }));
  expect(await authorizeRestitchNativeEnrollment(request(jwt), { auth: { getUser } })).toEqual({
    userId: actor,
    sessionId: session
  });
  expect(getUser).toHaveBeenCalledWith(jwt);
});
it('does not accept a syntactically valid session from a rejected JWT', async () => {
  const getUser = vi.fn(async () => ({
    data: { user: null },
    error: { message: 'PRIVATE_AUTH_PAYLOAD' }
  }));
  await expect(
    authorizeRestitchNativeEnrollment(request(token({ sub: actor, session_id: session })), {
      auth: { getUser }
    })
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  expect(getUser).toHaveBeenCalledTimes(1);
});
it.each([
  { sub: actor },
  { sub: actor, session_id: 'secret-path' },
  { sub: actor, session_id: 4 },
  { sub: session, session_id: session },
  null,
  []
])('refuses incomplete or foreign verified metadata without exposing it: %j', async value => {
  const getUser = vi.fn(async () => ({ data: { user: { id: actor } }, error: null }));
  await expect(
    authorizeRestitchNativeEnrollment(request(token(value)), { auth: { getUser } })
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});
it('takes no session selector from unrelated request headers', async () => {
  const jwt = token({ sub: actor, session_id: session });
  const getUser = vi.fn(async () => ({ data: { user: { id: actor } }, error: null }));
  const req = new Request('https://project.invalid/enroll', {
    headers: { authorization: 'Bearer ' + jwt, 'x-session-id': actor }
  });
  expect(await authorizeRestitchNativeEnrollment(req, { auth: { getUser } })).toEqual({
    userId: actor,
    sessionId: session
  });
});

it('keeps a thrown Auth transport failure distinct from a rejected user and strips its payload', async () => {
  const getUser = vi.fn(async () => {
    throw Error('PRIVATE_TOKEN_PAYLOAD');
  });
  const result = await authorizeRestitchNativeEnrollment(
    request(token({ sub: actor, session_id: session })),
    { auth: { getUser } }
  ).catch(error => error as Error);
  expect(result).toMatchObject({ code: 'TEAM_TRANSPORT_UNAVAILABLE' });
  expect(String(result)).not.toContain('PRIVATE_TOKEN_PAYLOAD');
});

it('uses a request-free Auth verifier for an explicit JWT instead of duplicating the caller authorization header', async () => {
  const jwt = token({ sub: actor, session_id: session });
  const make = (caller: boolean) =>
    createClient('https://project.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        ...(caller ? { headers: { authorization: 'Bearer ' + jwt } } : {}),
        fetch: async (_url, init) => {
          const single = new Headers(init?.headers).get('authorization') === 'Bearer ' + jwt;
          return new Response(
            JSON.stringify(
              single
                ? {
                    id: actor,
                    aud: 'authenticated',
                    app_metadata: {},
                    user_metadata: {},
                    created_at: '2026-11-01T00:00:00Z'
                  }
                : { message: 'Invalid JWT', code: 'bad_jwt' }
            ),
            {
              status: single ? 200 : 401,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
      }
    });
  await expect(authorizeRestitchNativeEnrollment(request(jwt), make(true))).rejects.toMatchObject({
    code: 'AUTH_REQUIRED'
  });
  expect(await authorizeRestitchNativeEnrollment(request(jwt), make(false))).toEqual({
    userId: actor,
    sessionId: session
  });
});
