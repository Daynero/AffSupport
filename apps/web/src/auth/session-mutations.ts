import {
  AUTH_SESSION_MUTATION_CODES,
  type AuthSessionMutationCode
} from '@video-compressor/shared';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

export type AuthSessionMutationStorage = Pick<Storage, 'getItem' | 'setItem'>;
export interface AuthSessionOwner {
  /** In-memory only. Never persist or send this session as diagnostic payload. */
  session: Session | null;
  intentRevision: string;
}

function projectOrigin(scope: string): string {
  try {
    const url = new URL(scope);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('AUTH_SESSION_SCOPE_INVALID');
  }
}
function intentStorage(storage?: AuthSessionMutationStorage): AuthSessionMutationStorage {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) throw new Error();
    return target;
  } catch (error) {
    throw new Error('AUTH_SESSION_STATE_UNAVAILABLE', { cause: error });
  }
}
function readIntent(origin: string, storage?: AuthSessionMutationStorage): string {
  try {
    const value = intentStorage(storage).getItem(`soty.auth.session-intent.v1:${origin}`);
    if (value === null) return 'initial';
    if (!UUID.test(value)) throw new Error();
    return value;
  } catch (error) {
    throw new Error('AUTH_SESSION_STATE_UNAVAILABLE', { cause: error });
  }
}
function advanceIntent(origin: string, storage?: AuthSessionMutationStorage): void {
  try {
    const revision = crypto.randomUUID();
    intentStorage(storage).setItem(`soty.auth.session-intent.v1:${origin}`, revision);
    if (readIntent(origin, storage) !== revision) throw new Error();
  } catch (error) {
    throw new Error('AUTH_SESSION_STATE_UNAVAILABLE', { cause: error });
  }
}

/** Capture before retirement/analytics awaits, including OAuth intent not yet a session. */
export function captureAuthSessionOwner(
  scope: string,
  session: Session | null,
  storage?: AuthSessionMutationStorage
): AuthSessionOwner {
  return { session, intentRevision: readIntent(projectOrigin(scope), storage) };
}

/** All interactive SDK session commits share this lane across same-origin tabs. */
export async function runAuthSessionMutation<T>(
  scope: string,
  run: () => Promise<T>,
  locks?: Pick<LockManager, 'request'>,
  storage?: AuthSessionMutationStorage
): Promise<T> {
  return withAuthSessionLane(scope, run, true, locks, storage);
}

async function withAuthSessionLane<T>(
  scope: string,
  run: () => Promise<T>,
  markIntent: boolean,
  locks: Pick<LockManager, 'request'> | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.locks,
  storage?: AuthSessionMutationStorage
): Promise<T> {
  if (!locks) throw new Error('AUTH_SESSION_LOCK_UNAVAILABLE');
  const origin = projectOrigin(scope);
  const controller = new AbortController();
  // Bound waiting, never a mutation already holding the lane.
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await locks.request(
      `soty.auth-session.v1:${origin}`,
      { mode: 'exclusive', signal: controller.signal },
      async () => {
        clearTimeout(timer);
        // One opaque revision per project, no actor or credential. This also
        // protects OAuth preparation which has not committed a new session yet.
        if (markIntent) advanceIntent(origin, storage);
        return run();
      }
    );
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AUTH_SESSION_LOCK_TIMEOUT', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function sessionId(session: Session): string | null {
  // This is only an in-memory equality hint for SDK-owned sessions. It grants no
  // server authority and neither the token nor its decoded content is recorded.
  try {
    if (session.access_token.length > 16_384) return null;
    const payload = session.access_token.split('.')[1];
    if (!payload || !/^[a-z0-9_-]+$/iu.test(payload)) return null;
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/gu, '+').replace(/_/gu, '/')));
    if (!decoded || typeof decoded !== 'object') return null;
    const id = (decoded as { session_id?: unknown }).session_id;
    return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

function sameSession(expected: Session, current: Session): boolean {
  if (expected.user.id !== current.user.id) return false;
  const expectedId = sessionId(expected),
    currentId = sessionId(current);
  if (expectedId && currentId) return expectedId === currentId;
  // Legacy/mocked sessions without a stable ID are conservatively superseded
  // when their refresh credential changes, rather than signing out a new login.
  return Boolean(expected.refresh_token) && expected.refresh_token === current.refresh_token;
}

export async function signOutExpectedSession(
  scope: string,
  auth: Pick<SupabaseClient['auth'], 'getSession' | 'signOut'>,
  expected: AuthSessionOwner,
  locks?: Pick<LockManager, 'request'>,
  storage?: AuthSessionMutationStorage,
  onAcquired?: () => void
) {
  return withAuthSessionLane(
    scope,
    async () => {
      try {
        onAcquired?.();
      } catch {
        /* Diagnosis cannot prevent logout. */
      }
      const { data, error } = await auth.getSession();
      if (error) return { error, superseded: false, session: null as Session | null };
      const current = data.session;
      if (
        readIntent(projectOrigin(scope), storage) !== expected.intentRevision ||
        (current && (!expected.session || !sameSession(expected.session, current)))
      )
        return { error: null, superseded: true, session: current };
      if (!current) return { error: null, superseded: false, session: null };
      const result = await auth.signOut();
      return { ...result, superseded: false, session: null as Session | null };
    },
    false,
    locks,
    storage
  );
}

/** Classify only closed failures; arbitrary SDK/provider errors stay private. */
export function authSessionMutationCode(error: unknown): AuthSessionMutationCode {
  return error instanceof Error &&
    AUTH_SESSION_MUTATION_CODES.includes(error.message as AuthSessionMutationCode)
    ? (error.message as AuthSessionMutationCode)
    : 'AUTH_SESSION_MUTATION_FAILED';
}
