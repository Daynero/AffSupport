/**
 * `/spaces/create` (057 T015): a pilot creates a space on R2.
 *
 * The database does the whole creation in one transaction (`service_create_r2_space`): the
 * space with `storage_backend='r2'`, the owner's membership and the root folder. The permit is
 * checked there for the ACTING person, and the same idempotency key from the same person returns
 * the same space, so a reply lost on the way back never makes a second one.
 */
import { TeamFunctionError } from '../_shared/errors.ts';
import type { SpaceStorageJournalEntry } from '../_shared/space-storage-journal.ts';
import {
  parseCreatedSpaceSnapshot,
  spaceRpcError,
  type CreatedSpaceSnapshot,
  type CreateSpaceCommand
} from './handler.ts';

export interface CreateSpaceDeps {
  actorId: string;
  /** Throws the database's refusal as it came; mapped here. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  journal: (entry: SpaceStorageJournalEntry) => Promise<unknown>;
  operationId: string;
  client: SpaceStorageJournalEntry['client'];
}

export async function createSpace(
  command: CreateSpaceCommand,
  deps: CreateSpaceDeps
): Promise<CreatedSpaceSnapshot> {
  const record = (
    outcome: SpaceStorageJournalEntry['outcome'],
    code: string | null,
    teamId: string | null
  ) =>
    deps
      .journal({
        operationId: deps.operationId,
        attempt: 1,
        stage: 'create',
        outcome,
        code,
        bytes: null,
        teamId,
        ingress: null,
        client: deps.client
      })
      .catch(() => undefined);
  let value: unknown;
  try {
    value = await deps.rpc('service_create_r2_space', {
      p_actor: deps.actorId,
      p_name: command.name,
      p_idempotency_key: command.idempotencyKey
    });
  } catch (cause) {
    const error =
      cause instanceof TeamFunctionError
        ? cause
        : spaceRpcError(cause as { message?: unknown; code?: unknown });
    await record(error.retryable ? 'failed' : 'rejected', error.code, null);
    throw error;
  }
  const created = parseCreatedSpaceSnapshot(value);
  if (!created) {
    await record('unknown', 'INVALID_RESPONSE', null);
    throw new TeamFunctionError('INVALID_RESPONSE', { retryable: false });
  }
  await record('ok', null, created.teamId);
  return created;
}
