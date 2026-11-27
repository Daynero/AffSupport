import type { ServiceRpcClient } from './credentials.ts';
import { TeamFunctionError } from './errors.ts';

/**
 * 057 T020: which storage a space lives on, for the Drive paths that must never serve an R2
 * space (drive-transfer, drive-ops process output). The database answers members only
 * (`service_space_storage_backend`), so someone outside a space learns nothing from a refusal.
 *
 * A database that does not have the function yet (PostgREST PGRST202) has no R2 space either —
 * the function arrives with the migration that makes isolation possible — so it reads as Drive
 * rather than breaking every download of every Drive space.
 */
export type SpaceStorageBackendAnswer = 'drive' | 'r2' | null;

export async function spaceStorageBackendOf(
  client: ServiceRpcClient,
  teamId: string,
  actorId: string
): Promise<SpaceStorageBackendAnswer> {
  const { data, error } = await client.rpc('service_space_storage_backend', {
    p_team: teamId,
    p_actor: actorId
  });
  if (error) {
    if (error.code === 'PGRST202') return 'drive';
    throw new TeamFunctionError('DRIVE_UNAVAILABLE', { retryable: true });
  }
  return data === 'drive' || data === 'r2' ? data : null;
}

/** Refuses an R2 space with STORAGE_BACKEND_MISMATCH; a Drive space or a stranger passes on. */
export async function requireDriveSpace(
  client: ServiceRpcClient,
  teamId: string,
  actorId: string
): Promise<void> {
  if ((await spaceStorageBackendOf(client, teamId, actorId)) === 'r2') {
    throw new TeamFunctionError('STORAGE_BACKEND_MISMATCH', { retryable: false });
  }
}
