import { TeamFunctionError } from '../_shared/errors.ts';

export interface TeamAccountDeletionDependencies {
  ownedTeamCount: (userId: string) => Promise<number>;
  revokeDeletedUserGrants: (userId: string) => Promise<void>;
  /**
   * Drops what the member left in the legacy re-stitch bucket (030): pictures published from
   * their library before Drive pools. Their personal pools go with the Auth row's cascade.
   */
  purgeLegacyMedia?: (userId: string) => Promise<void>;
  deleteAuthUser: (userId: string) => Promise<void>;
}

export async function deleteAccountWithTeamPreflight(
  userId: string,
  dependencies: TeamAccountDeletionDependencies
): Promise<{ deleted: true }> {
  const teamCount = await dependencies.ownedTeamCount(userId);
  if (!Number.isSafeInteger(teamCount) || teamCount < 0) {
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  if (teamCount > 0) {
    throw new TeamFunctionError('OWNERSHIP_TRANSFER_REQUIRED', {
      retryable: false,
      details: { teamCount }
    });
  }

  // Revoke bearer grants first. Membership rows are removed by the existing
  // auth.users cascade only after Auth deletion succeeds; append-only audit
  // rows intentionally retain their logical actor identity and label snapshot.
  await dependencies.revokeDeletedUserGrants(userId);
  await dependencies.purgeLegacyMedia?.(userId);
  await dependencies.deleteAuthUser(userId);
  return { deleted: true };
}
