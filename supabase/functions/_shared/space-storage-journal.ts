import type { ServiceRpcClient } from './credentials.ts';
// @deno-types="../../../packages/shared/dist/team/transport.d.ts"
import { TEAM_ERROR_CODES } from '../../../packages/shared/dist/team/transport.js';
import {
  formatByteCount,
  isSpaceIngress,
  isSpaceStorageJournalOutcome,
  isSpaceStorageJournalStage,
  isSpaceUuid,
  type SpaceIngress,
  type SpaceStorageJournalOutcome,
  type SpaceStorageJournalStage
} from '../../../packages/shared/dist/team/space-storage.js';

/**
 * The storage journal of R2 spaces (057 T011): one content-free row per stage
 * of an operation in `private.space_storage_journal`, through the service-only
 * RPC `service_write_space_storage_journal` (20261226110000).
 *
 * A row is built from closed fields only. An entry that carries anything else —
 * a file name, a path, a bucket key, a URL — is refused whole rather than
 * stripped, so a caller that tries to log one notices in its tests. Writing is
 * best-effort: a lost journal row is a blind spot, never a failed upload.
 */
export const SPACE_STORAGE_JOURNAL_COLUMNS = [
  'operation_id',
  'attempt',
  'stage',
  'outcome',
  'code',
  'bytes',
  'team_id',
  'ingress',
  'client'
] as const;

export interface SpaceStorageJournalEntry {
  operationId: string;
  attempt: number;
  stage: SpaceStorageJournalStage;
  outcome: SpaceStorageJournalOutcome;
  code: string | null;
  bytes: bigint | number | null;
  teamId: string | null;
  ingress: SpaceIngress | null;
  client: { kind: 'web' | 'agent' | 'server'; version: string };
}

const FIELDS = new Set([
  'operationId',
  'attempt',
  'stage',
  'outcome',
  'code',
  'bytes',
  'teamId',
  'ingress',
  'client'
]);
const KNOWN_CODES = new Set<string>([...TEAM_ERROR_CODES, 'UNKNOWN']);
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(?:\+[0-9]{1,6})?$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The RPC parameters for one entry, or `null` when the entry is not a closed journal row. */
export function spaceStorageJournalParams(
  value: unknown
): Record<string, string | number | null> | null {
  if (!isRecord(value) || Object.keys(value).some(key => !FIELDS.has(key))) return null;
  const { operationId, attempt, stage, outcome, code, bytes, teamId, ingress, client } = value;
  if (
    !isSpaceUuid(operationId) ||
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 1000 ||
    !isSpaceStorageJournalStage(stage) ||
    !isSpaceStorageJournalOutcome(outcome) ||
    (code !== null && (typeof code !== 'string' || !KNOWN_CODES.has(code))) ||
    (teamId !== null && !isSpaceUuid(teamId)) ||
    (ingress !== null && !isSpaceIngress(ingress)) ||
    !isRecord(client) ||
    Object.keys(client).some(key => key !== 'kind' && key !== 'version') ||
    (client.kind !== 'web' && client.kind !== 'agent' && client.kind !== 'server') ||
    typeof client.version !== 'string' ||
    !VERSION.test(client.version)
  )
    return null;
  let byteText: string | null = null;
  if (bytes !== null) {
    if (typeof bytes === 'bigint') {
      if (bytes < 0n || bytes > 9_223_372_036_854_775_807n) return null;
      byteText = formatByteCount(bytes);
    } else if (typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes >= 0) {
      byteText = String(bytes);
    } else return null;
  }
  return {
    p_operation: operationId,
    p_attempt: attempt,
    p_stage: stage,
    p_outcome: outcome,
    p_code: code as string | null,
    // Decimal text: PostgREST casts it to bigint without passing through a double.
    p_bytes: byteText,
    p_team: teamId as string | null,
    p_ingress: ingress as string | null,
    p_client: `${client.kind}/${client.version}`
  };
}

export async function writeSpaceStorageJournal(
  client: ServiceRpcClient,
  entry: unknown
): Promise<boolean> {
  const params = spaceStorageJournalParams(entry);
  if (!params) return false;
  try {
    const { error } = await client.rpc('service_write_space_storage_journal', params);
    return !error;
  } catch {
    return false;
  }
}
