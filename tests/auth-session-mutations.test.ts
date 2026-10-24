import { createClient, type Session } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import {
  captureAuthSessionOwner,
  runAuthSessionMutation,
  signOutExpectedSession
} from '../apps/web/src/auth/session-mutations';
import { createTestAuthLocks, createTestAuthMutationStorage } from './support/auth-mutation-locks';
const SCOPE = 'http://127.0.0.1:1';
const A = 'e1690000-0000-4000-8000-000000000001';
const B = 'e1690000-0000-4000-8000-000000000002';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const memory = new Map<string, string>();
  const entered = gate(),
    reply = gate();
  const refreshEntered = gate(),
    refreshReply = gate();
  let holdLogout = false,
    logoutRequests = 0;
  const token = (id: string, sid: string) =>
    `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, session_id: sid, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.c3ludGhldGlj`;
  const user = (id: string) => ({
    id,
    aud: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-10-22T00:00:00Z'
  });
  const session = (id: string) => ({
    access_token: token(id, crypto.randomUUID()),
    refresh_token: crypto.randomUUID(),
    token_type: 'bearer',
    expires_in: 3600,
    user: user(id)
  });
  const makeClient = () => {
    const client = createClient(SCOPE, 'synthetic-public-key', {
      auth: {
        flowType: 'pkce',
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true,
        storageKey: `t169-${storageId}`,
        storage: {
          getItem: key => memory.get(key) ?? null,
          setItem: (key, value) => {
            memory.set(key, value);
          },
          removeItem: key => {
            memory.delete(key);
          }
        }
      },
      global: {
        fetch: async (input, init) => {
          const url = String(input);
          if (url.includes('/token?grant_type=password')) {
            const body = JSON.parse(String(init?.body)),
              id = body.email === 'a@example.invalid' ? A : B;
            return Response.json(session(id));
          }
          if (url.includes('/token?grant_type=pkce') || url.includes('/token?grant_type=id_token'))
            return Response.json(session(B));
          if (url.includes('/token?grant_type=refresh_token')) {
            refreshEntered.resolve();
            await refreshReply.promise;
            return Response.json(session(A));
          }
          if (url.endsWith('/user')) {
            const jwt = new Headers(init?.headers).get('authorization')!.split(' ')[1]!;
            const decoded = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
            return Response.json(user(decoded.sub));
          }
          if (url.includes('/logout')) {
            logoutRequests++;
            entered.resolve();
            if (holdLogout) await reply.promise;
            return new Response(null, { status: 204 });
          }
          throw new Error('UNEXPECTED_SYNTHETIC_ROUTE');
        }
      }
    });
    return client;
  };
  const storageId = crypto.randomUUID(),
    locks = createTestAuthLocks(),
    storage = createTestAuthMutationStorage(),
    client = makeClient();
  const signIn = (actor: 'a' | 'b', target = client) =>
    runAuthSessionMutation(
      SCOPE,
      () =>
        target.auth.signInWithPassword({
          email: `${actor}@example.invalid`,
          password: 'synthetic'
        }),
      locks,
      storage
    );
  return {
    client,
    makeClient,
    locks,
    storage,
    owner: (session: Session | null) => captureAuthSessionOwner(SCOPE, session, storage),
    signIn,
    entered,
    reply,
    hold: () => {
      holdLogout = true;
    },
    requests: () => logoutRequests,
    credentials: () => session(B),
    refreshEntered,
    refreshReply,
    seedVerifier: () =>
      memory.set(`t169-${storageId}-code-verifier`, JSON.stringify('synthetic-code-verifier')),
    hasVerifier: () => memory.has(`t169-${storageId}-code-verifier`)
  };
}
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  'preserves a new actor queued behind an in-flight old logout; second client=%s',
  async secondClient => {
    const f = fixture();
    await f.signIn('a');
    const expected = f.owner((await f.client.auth.getSession()).data.session!);
    const next = secondClient ? f.makeClient() : f.client;
    await next.auth.getSession();
    f.hold();
    const logout = signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage);
    await f.entered.promise;
    const signIn = f.signIn('b', next);
    const committedBeforeOldReply = await Promise.race([
      signIn.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25))
    ]);
    f.reply.resolve();
    await logout;
    await signIn;
    expect(committedBeforeOldReply).toBe(false);
    expect((await next.auth.getSession()).data.session?.user.id).toBe(B);
  }
);
it.each(['a', 'b'] as const)(
  'does not logout a replacement %s session committed before lock acquisition',
  async replacement => {
    const f = fixture();
    await f.signIn('a');
    const expected = f.owner((await f.client.auth.getSession()).data.session!);
    await f.signIn(replacement);
    const result = await signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage);
    expect(result.superseded).toBe(true);
    expect(f.requests()).toBe(0);
    expect((await f.client.auth.getSession()).data.session?.user.id).toBe(
      replacement === 'a' ? A : B
    );
  }
);
it('accepts token rotation within the same authenticated session without treating it as a new login', async () => {
  const f = fixture();
  await f.signIn('a');
  const current = (await f.client.auth.getSession()).data.session!;
  const expected = f.owner({
    ...current,
    refresh_token: 'previous-rotated-refresh-token'
  } as Session);
  expect(
    (await signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage)).superseded
  ).toBe(false);
  expect((await f.client.auth.getSession()).data.session).toBeNull();
});
it('refuses unsafe mutations when cross-tab Web Locks are unavailable', async () => {
  vi.stubGlobal('navigator', {});
  const run = vi.fn(async () => true);
  await expect(runAuthSessionMutation(SCOPE, run)).rejects.toThrow('AUTH_SESSION_LOCK_UNAVAILABLE');
  expect(run).not.toHaveBeenCalled();
});
it('releases the lane after a failed mutation', async () => {
  const locks = createTestAuthLocks(),
    storage = createTestAuthMutationStorage();
  await expect(
    runAuthSessionMutation(
      SCOPE,
      async () => {
        throw new Error('SYNTHETIC_FAILURE');
      },
      locks,
      storage
    )
  ).rejects.toThrow('SYNTHETIC_FAILURE');
  await expect(runAuthSessionMutation(SCOPE, async () => true, locks, storage)).resolves.toBe(true);
});

it('bounds lock acquisition without running the SDK mutation after the deadline', async () => {
  vi.useFakeTimers();
  try {
    const run = vi.fn(async () => true);
    const locks = {
      request: (_name: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    } as unknown as Pick<LockManager, 'request'>;
    const result = expect(runAuthSessionMutation(SCOPE, run, locks)).rejects.toThrow(
      'AUTH_SESSION_LOCK_TIMEOUT'
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(run).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it('does not release an acquired lane when the acquisition deadline passes during SDK work', async () => {
  vi.useFakeTimers();
  const held = gate();
  try {
    const locks = createTestAuthLocks(),
      storage = createTestAuthMutationStorage();
    const first = runAuthSessionMutation(SCOPE, () => held.promise, locks, storage);
    await Promise.resolve();
    const next = vi.fn(async () => true);
    const second = runAuthSessionMutation(SCOPE, next, locks, storage);
    // The second waiter may expire without interrupting the mutation holding the lane.
    const secondResult = expect(second).rejects.toThrow('AUTH_SESSION_LOCK_TIMEOUT');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(next).not.toHaveBeenCalled();
    held.resolve();
    await first;
    await secondResult;
    expect(next).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    vi.useRealTimers();
  }
});
it.each(['file:///tmp/synthetic', 'https://name:synthetic@example.invalid'])(
  'rejects an invalid mutation scope without calling the SDK: %s',
  async scope => {
    const run = vi.fn(async () => true);
    await expect(runAuthSessionMutation(scope, run, createTestAuthLocks())).rejects.toThrow(
      'AUTH_SESSION_SCOPE_INVALID'
    );
    expect(run).not.toHaveBeenCalled();
  }
);
it('conservatively skips a replaced legacy session without stable session-id claims', async () => {
  const f = fixture();
  await f.signIn('a');
  const current = (await f.client.auth.getSession()).data.session!;
  const expected = f.owner({
    ...current,
    access_token: 'legacy',
    refresh_token: 'old-session-credential'
  });
  expect(
    (await signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage)).superseded
  ).toBe(true);
  expect(f.requests()).toBe(0);
});

it.each(['handoff', 'pkce', 'id-token'] as const)(
  'preserves a replacement %s session queued behind an old logout using real SDK APIs',
  async method => {
    const f = fixture();
    await f.signIn('a');
    const expected = f.owner((await f.client.auth.getSession()).data.session!);
    const replacement = f.makeClient();
    await replacement.auth.getSession();
    f.hold();
    const logout = signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage);
    await f.entered.promise;
    const credentials = f.credentials();
    const next = runAuthSessionMutation(
      SCOPE,
      async () => {
        // OAuth initiation is also coordinated; its verifier is written only after old logout releases the lane.
        if (method === 'pkce') f.seedVerifier();
        return method === 'handoff'
          ? replacement.auth.setSession(credentials)
          : method === 'pkce'
            ? replacement.auth.exchangeCodeForSession('synthetic-code')
            : replacement.auth.signInWithIdToken({
                provider: 'google',
                token: 'synthetic-id-token'
              });
      },
      f.locks,
      f.storage
    );
    const committedBeforeOldReply = await Promise.race([
      next.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25))
    ]);
    f.reply.resolve();
    await logout;
    const result = await next;
    expect(committedBeforeOldReply).toBe(false);
    expect(result.error).toBeNull();
    expect((await replacement.auth.getSession()).data.session?.user.id).toBe(B);
  }
);
it('does not let a late old-actor refresh replace a new interactive session', async () => {
  const f = fixture();
  await f.signIn('a');
  const refreshing = f.client.auth.refreshSession();
  await f.refreshEntered.promise;
  const replacement = f.makeClient();
  await replacement.auth.getSession();
  await f.signIn('b', replacement);
  f.refreshReply.resolve();
  await refreshing;
  expect((await replacement.auth.getSession()).data.session?.user.id).toBe(B);
  expect((await f.client.auth.getSession()).data.session?.user.id).toBe(B);
});
it('preserves a newer OAuth intent and its verifier while an older logout is still awaiting retirement', async () => {
  const f = fixture();
  await f.signIn('a');
  const expected = f.owner((await f.client.auth.getSession()).data.session!);
  await runAuthSessionMutation(
    SCOPE,
    () =>
      f.client.auth.signInWithOAuth({ provider: 'google', options: { skipBrowserRedirect: true } }),
    f.locks,
    f.storage
  );
  expect(f.hasVerifier()).toBe(true);
  const result = await signOutExpectedSession(SCOPE, f.client.auth, expected, f.locks, f.storage);
  expect(result.superseded).toBe(true);
  expect(f.requests()).toBe(0);
  expect(f.hasVerifier()).toBe(true);
});

it('refuses destructive logout when its shared intent state is corrupt', async () => {
  const f = fixture();
  await f.signIn('a');
  const session = (await f.client.auth.getSession()).data.session!;
  const storage = { getItem: () => 'corrupt-state', setItem: () => {} };
  expect(() => captureAuthSessionOwner(SCOPE, session, storage)).toThrow(
    'AUTH_SESSION_STATE_UNAVAILABLE'
  );
  expect(f.requests()).toBe(0);
});
it('does not start a session writer if its shared intent cannot be durably recorded', async () => {
  const run = vi.fn(async () => true);
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('synthetic-private-storage-detail');
    }
  };
  await expect(runAuthSessionMutation(SCOPE, run, createTestAuthLocks(), storage)).rejects.toThrow(
    'AUTH_SESSION_STATE_UNAVAILABLE'
  );
  expect(run).not.toHaveBeenCalled();
});
it('stores only one opaque intent revision and never persists the captured owner session', async () => {
  const values = new Map<string, string>();
  const writes = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: writes };
  await runAuthSessionMutation(SCOPE, async () => true, createTestAuthLocks(), storage);
  const f = fixture();
  await f.signIn('a');
  const owner = captureAuthSessionOwner(
    SCOPE,
    (await f.client.auth.getSession()).data.session!,
    storage
  );
  expect(owner.session?.user.id).toBe(A);
  expect(values.size).toBe(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect([...values.values()][0]).toMatch(/^[a-f0-9-]{36}$/u);
  expect(JSON.stringify(writes.mock.calls)).not.toMatch(
    /access_token|refresh_token|synthetic-public-key|synthetic-code|eyJ/u
  );
});
