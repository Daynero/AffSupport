import { describe, expect, it, vi } from 'vitest';
import { TeamFunctionError } from '../supabase/functions/_shared/errors.ts';
import {
  deleteAccountWithTeamPreflight,
  type TeamAccountDeletionDependencies
} from '../supabase/functions/delete-account/handler.ts';

function dependencies(overrides: Partial<TeamAccountDeletionDependencies> = {}) {
  return {
    ownedTeamCount: vi.fn().mockResolvedValue(0),
    deleteAuthUser: vi.fn().mockResolvedValue(undefined),
    revokeDeletedUserGrants: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } satisfies TeamAccountDeletionDependencies;
}

describe('team-aware account deletion', () => {
  it('refuses an owner before changing Auth or memberships', async () => {
    const deps = dependencies({ ownedTeamCount: vi.fn().mockResolvedValue(2) });

    await expect(
      deleteAccountWithTeamPreflight('10000000-0000-4000-8000-000000000001', deps)
    ).rejects.toMatchObject({
      code: 'OWNERSHIP_TRANSFER_REQUIRED',
      retryable: false,
      details: { teamCount: 2 }
    } satisfies Partial<TeamFunctionError>);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.revokeDeletedUserGrants).not.toHaveBeenCalled();
  });

  it('deletes a non-owner and revokes grants without touching retained audit identity', async () => {
    const deps = dependencies();
    const userId = '10000000-0000-4000-8000-000000000002';

    await expect(deleteAccountWithTeamPreflight(userId, deps)).resolves.toEqual({ deleted: true });
    expect(deps.deleteAuthUser).toHaveBeenCalledWith(userId);
    expect(deps.revokeDeletedUserGrants).toHaveBeenCalledWith(userId);
  });

  it('applies the same ownership preflight to a blocked account with a still-valid JWT', async () => {
    const deps = dependencies({ ownedTeamCount: vi.fn().mockResolvedValue(1) });

    await expect(
      deleteAccountWithTeamPreflight('10000000-0000-4000-8000-000000000003', deps)
    ).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_REQUIRED' });
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });
});
