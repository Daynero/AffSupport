import { query } from './db.js';
import { getSchema } from './schema.js';
import { isLaunchUuid } from '../../packages/shared/src/team/launches.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import { INSPECT_AGENT_NOTE, type InspectData } from './types.js';

const instant = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const iso = (value: string) => new Date(value).toISOString();
const knownError = (value: unknown) =>
  value === null ? null : (TEAM_ERROR_CODES.find(code => code === value) ?? 'UNKNOWN');
export interface CatalogRenameRecord {
  request_key: string;
  team_id: string;
  actor_id: string;
  material_id: string;
  operation_id: string | null;
  state: 'pending' | 'confirmed' | 'failed' | 'unknown';
  error_code: string | null;
  origin: 'provider_intent' | 'absent_command';
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  dispatched: boolean | null;
  attempt_count: number | null;
  next_attempt_at: string | null;
  snapshot_at_as_of: 'available' | 'unknown';
}
export interface CatalogRenameEvidence {
  supported: boolean;
  scope: 'current_snapshot_not_transition_history';
  records: CatalogRenameRecord[];
  truncated: boolean;
  invalid_record_count: number;
  blind_spots: string[];
}
/** Select only the safe projection, never catalog names, URL bindings or provider responses. */
export async function getCatalogRenameEvidence(
  id: string,
  asOf?: string
): Promise<CatalogRenameEvidence> {
  if (asOf !== undefined && !instant(asOf)) throw Error('INVALID_INPUT');
  const result: CatalogRenameEvidence = {
    supported: !!(await getSchema()).tables.analytics_catalog_renames,
    scope: 'current_snapshot_not_transition_history',
    records: [],
    truncated: false,
    invalid_record_count: 0,
    blind_spots: []
  };
  if (!result.supported) {
    result.blind_spots.push(
      'Canonical rename receipts are unavailable; missing browser events do not prove that no command was accepted.'
    );
    return result;
  }
  if (!isLaunchUuid(id)) return result;
  const rows = await query<Record<string, unknown>>(
    `select request_key::text,team_id::text,actor_id::text,material_id::text,operation_id::text,
      state,error_code,origin,created_at::text,updated_at::text,confirmed_at::text,
      dispatched,attempt_count,next_attempt_at::text
     from public.analytics_catalog_renames
     where (request_key=$1::uuid or team_id=$1::uuid or actor_id=$1::uuid or material_id=$1::uuid or operation_id=$1::uuid)
       and created_at<=$2::timestamptz
     order by created_at desc,request_key desc limit 101`,
    [id, asOf ?? '9999-12-31T23:59:59Z']
  );
  result.truncated = rows.length > 100;
  const cutoff = asOf === undefined ? Infinity : Date.parse(asOf);
  for (const row of rows.slice(0, 100)) {
    if (
      !['request_key', 'team_id', 'actor_id', 'material_id'].every(key => isLaunchUuid(row[key])) ||
      (row.operation_id !== null && !isLaunchUuid(row.operation_id)) ||
      !['pending', 'confirmed', 'failed'].includes(String(row.state)) ||
      !['provider_intent', 'absent_command'].includes(String(row.origin)) ||
      !instant(row.created_at) ||
      !instant(row.updated_at) ||
      Date.parse(row.updated_at) < Date.parse(row.created_at) ||
      (row.confirmed_at !== null && !instant(row.confirmed_at)) ||
      (row.next_attempt_at !== null && !instant(row.next_attempt_at)) ||
      typeof row.dispatched !== 'boolean' ||
      typeof row.attempt_count !== 'number' ||
      !Number.isSafeInteger(row.attempt_count) ||
      row.attempt_count < 0 ||
      row.attempt_count > 2147483647 ||
      (row.state === 'confirmed' &&
        (!isLaunchUuid(row.operation_id) || !instant(row.confirmed_at))) ||
      (row.origin === 'absent_command' &&
        (row.state !== 'failed' || row.error_code !== 'NOT_FOUND' || row.operation_id !== null))
    ) {
      result.invalid_record_count++;
      continue;
    }
    const current = Date.parse(row.updated_at) <= cutoff;
    result.records.push({
      request_key: String(row.request_key),
      team_id: String(row.team_id),
      actor_id: String(row.actor_id),
      material_id: String(row.material_id),
      operation_id: current ? (row.operation_id as string | null) : null,
      state: current ? (row.state as CatalogRenameRecord['state']) : 'unknown',
      error_code: current ? knownError(row.error_code) : null,
      origin: row.origin as CatalogRenameRecord['origin'],
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      confirmed_at:
        current && instant(row.confirmed_at) && Date.parse(row.confirmed_at) <= cutoff
          ? iso(row.confirmed_at)
          : null,
      dispatched: current ? row.dispatched : null,
      attempt_count: current ? row.attempt_count : null,
      next_attempt_at: current && instant(row.next_attempt_at) ? iso(row.next_attempt_at) : null,
      snapshot_at_as_of: current ? 'available' : 'unknown'
    });
  }
  result.blind_spots.push(
    'Current rename receipts prove server/provider settlement separately from browser delivery; they do not reconstruct transition history or prove that the new name was displayed.'
  );
  if (result.records.some(row => row.snapshot_at_as_of === 'unknown'))
    result.blind_spots.push(
      'A receipt changed after the requested as-of time; its earlier outcome is unknown.'
    );
  if (result.truncated)
    result.blind_spots.push(
      'Only the 100 most recent matching commands are returned; omitted outcomes remain unknown.'
    );
  if (result.invalid_record_count)
    result.blind_spots.push(
      'Malformed diagnostic rows were excluded without returning their contents.'
    );
  return result;
}

export function mergeCatalogRenameInspection(
  core: InspectData,
  evidence: CatalogRenameEvidence
): InspectData {
  if (!evidence.records.length) {
    const renameEvent =
      core.found && core.events.some(event => event.properties.action === 'rename');
    return renameEvent ? { ...core, catalog_renames: evidence } : core;
  }
  if (core.found)
    return {
      ...core,
      matched_by: [...new Set([...core.matched_by, 'authoritative_table' as const])],
      catalog_renames: evidence
    };
  const records = evidence.records;
  const expected = ['command_recorded', 'provider_confirmed', 'result_visible'];
  const observed = ['command_recorded'];
  if (records.some(row => row.dispatched)) observed.push('provider_dispatched');
  if (records.some(row => row.state === 'confirmed')) observed.push('provider_confirmed');
  if (records.some(row => row.state === 'failed')) observed.push('command_failed');
  return {
    ...core,
    found: true,
    matched_by: ['authoritative_table'],
    capability: 'team.file_ops',
    tool: 'team',
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    terminal: null,
    last_proven_stage: observed.at(-1)!,
    first_seen_at: records.map(row => row.created_at).sort()[0]!,
    last_seen_at: records
      .map(row => (row.snapshot_at_as_of === 'available' ? row.updated_at : row.created_at))
      .sort()
      .at(-1)!,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: INSPECT_AGENT_NOTE
    },
    events: [],
    catalog_renames: evidence
  };
}
