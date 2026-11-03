import { query } from './db.js';
import { getSchema } from './schema.js';
import type { ResolvedPeriod } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STATES = new Set([
  'reserved',
  'planning',
  'planned',
  'create_started',
  'created',
  'finalized',
  'registered',
  'interrupted',
  'cleanup_pending',
  'canceled'
]);
const CODES = new Set([
  'NEEDS_REAUTH',
  'PERMISSION_DENIED',
  'SOURCE_CHANGED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'DRIVE_UNAVAILABLE',
  'LEASE_MISMATCH',
  'GROUP_RECONCILING',
  'WRONG_STATE',
  'INVALID_RESPONSE',
  'LAUNCH_RESULT_UNCERTAIN',
  'LAUNCH_INTERNAL_ERROR',
  'IMAGE_PUBLICATION_REVOKED',
  'CATALOG_IMAGE_UPGRADE_REQUIRED'
]);
const FLAGS = [
  'settings_observed',
  'source_observed',
  'rows_planned',
  'provider_result_observed',
  'result_registered'
] as const;
export interface CatalogGenerationSnapshot {
  intent_id: string;
  operation_id: string | null;
  attempt: number;
  origin: 'launch' | 'standalone' | 'unknown';
  state: string;
  safe_error_code: string | null;
  created_at: string;
  updated_at: string;
  settings_observed: boolean | null;
  source_observed: boolean | null;
  rows_planned: boolean | null;
  provider_result_observed: boolean | null;
  result_registered: boolean | null;
}
export interface CatalogGenerationEvidence {
  supported: boolean;
  scope: 'current_snapshot_not_transition_history';
  records: CatalogGenerationSnapshot[];
  truncated: boolean;
  unknown_projection: boolean;
  blind_spots: string[];
}
/** Only closed fields from the restricted view; raw checkpoints never enter this module. */
export async function getCatalogGenerationEvidence(
  id: string,
  period: ResolvedPeriod
): Promise<CatalogGenerationEvidence> {
  const result: CatalogGenerationEvidence = {
    supported: false,
    scope: 'current_snapshot_not_transition_history',
    records: [],
    truncated: false,
    unknown_projection: false,
    blind_spots: [
      'Checkpoint presence is observation, not current dependency readiness.',
      'Intermediate transition timings and browser delivery are unobserved.'
    ]
  };
  const schema = await getSchema();
  if (!schema.tables.analytics_catalog_generations) {
    result.blind_spots.push('Restricted catalog generation view is unavailable to this role.');
    return result;
  }
  result.supported = true;
  if (period.as_of) {
    result.blind_spots.push(
      'Historical generation snapshots are unavailable; current state is not reconstructed at the requested instant.'
    );
    return result;
  }
  if (!UUID.test(id)) return result;
  const rows = await query<Record<string, unknown>>(
    `select intent_id::text,operation_id::text,attempt,origin,state,safe_error_code,created_at::text,updated_at::text,
      settings_observed,source_observed,rows_planned,provider_result_observed,result_registered
     from public.analytics_catalog_generations
     where (actor_id=$1::uuid or team_id=$1::uuid or intent_id=$1::uuid or operation_id=$1::uuid)
       and ($2::timestamptz is null or updated_at >= $2) and created_at <= $3::timestamptz
     order by updated_at desc,intent_id desc limit 101`,
    [id, period.start, period.end]
  );
  result.truncated = rows.length > 100;
  for (const row of rows.slice(0, 100)) {
    const created = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
    const updated = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN;
    if (
      typeof row.intent_id !== 'string' ||
      !UUID.test(row.intent_id) ||
      !(
        row.operation_id === null ||
        (typeof row.operation_id === 'string' && UUID.test(row.operation_id))
      ) ||
      !Number.isSafeInteger(row.attempt) ||
      Number(row.attempt) < 1 ||
      !Number.isFinite(created) ||
      !Number.isFinite(updated)
    ) {
      result.unknown_projection = true;
      continue;
    }
    const state = typeof row.state === 'string' && STATES.has(row.state) ? row.state : 'unknown';
    const code =
      row.safe_error_code === null
        ? null
        : typeof row.safe_error_code === 'string' && CODES.has(row.safe_error_code)
          ? row.safe_error_code
          : 'UNKNOWN';
    const origin = row.origin === 'launch' || row.origin === 'standalone' ? row.origin : 'unknown';
    if (
      state === 'unknown' ||
      code === 'UNKNOWN' ||
      origin === 'unknown' ||
      FLAGS.some(flag => typeof row[flag] !== 'boolean')
    )
      result.unknown_projection = true;
    result.records.push({
      intent_id: row.intent_id,
      operation_id: row.operation_id as string | null,
      attempt: Number(row.attempt),
      origin,
      state,
      safe_error_code: code,
      created_at: new Date(created).toISOString(),
      updated_at: new Date(updated).toISOString(),
      settings_observed: typeof row.settings_observed === 'boolean' ? row.settings_observed : null,
      source_observed: typeof row.source_observed === 'boolean' ? row.source_observed : null,
      rows_planned: typeof row.rows_planned === 'boolean' ? row.rows_planned : null,
      provider_result_observed:
        typeof row.provider_result_observed === 'boolean' ? row.provider_result_observed : null,
      result_registered: typeof row.result_registered === 'boolean' ? row.result_registered : null
    });
  }
  if (result.unknown_projection)
    result.blind_spots.push(
      'An unrecognized generation projection was withheld or normalized to unknown.'
    );
  return result;
}
