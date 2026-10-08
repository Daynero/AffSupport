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

  it('drops the member’s legacy re-stitch pictures before the Auth row goes (030)', async () => {
    const order: string[] = [];
    const deps = dependencies({
      revokeDeletedUserGrants: vi.fn(async () => {
        order.push('revoke');
      }),
      purgeLegacyMedia: vi.fn(async () => {
        order.push('purge');
      }),
      deleteAuthUser: vi.fn(async () => {
        order.push('delete');
      })
    });
    const userId = '10000000-0000-4000-8000-000000000004';
    await expect(deleteAccountWithTeamPreflight(userId, deps)).resolves.toEqual({ deleted: true });
    expect(deps.purgeLegacyMedia).toHaveBeenCalledWith(userId);
    expect(order).toEqual(['revoke', 'purge', 'delete']);

    const failing = dependencies({
      purgeLegacyMedia: vi.fn().mockRejectedValue(new TeamFunctionError('DRIVE_UNAVAILABLE'))
    });
    await expect(deleteAccountWithTeamPreflight(userId, failing)).rejects.toMatchObject({
      code: 'DRIVE_UNAVAILABLE'
    });
    expect(failing.deleteAuthUser).not.toHaveBeenCalled();
  });

  it('applies the same ownership preflight to a blocked account with a still-valid JWT', async () => {
    const deps = dependencies({ ownedTeamCount: vi.fn().mockResolvedValue(1) });

    await expect(
      deleteAccountWithTeamPreflight('10000000-0000-4000-8000-000000000003', deps)
    ).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_REQUIRED' });
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });
});
