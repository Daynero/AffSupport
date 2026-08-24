import { vi } from 'vitest';
import type { AuthContextValue } from '../../apps/web/src/auth/AuthContext';

/**
 * A signed-in admin, for suites whose subject is something else entirely.
 *
 * Four files each declared their own copy of this object and cast it into
 * place. When `AuthContextValue` grew two methods, all four went stale at once
 * and the cast is what let them: `as AuthContextValue` on an object literal
 * asks the compiler to stop checking exactly where checking would have helped.
 *
 * Built from a full record here instead, with no cast, so a method added to the
 * context is a compile error in one place with one fix — which is the only
 * version of this that stays true.
 */
export function adminAuthStub(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'authenticated',
    user: null,
    session: null,
    profile: null,
    isAdmin: true,
    error: null,
    loading: false,
    signInWithGoogle: vi.fn(async () => {}),
    signInWithBetaFixture: vi.fn(async () => {}),
    completeOAuthCallback: vi.fn(async () => {}),
    adoptHandedOverSession: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    updateProfile: vi.fn(),
    refreshProfile: vi.fn(async () => {}),
    ...overrides
  } as AuthContextValue;
}
