import { query } from './db.js';
import { getSchema } from './schema.js';

export interface TranslationRetirementRow {
  entity_kind: 'requirement' | 'attempt' | 'operation';
  entity_id: string;
  team_id: string;
  actor_id: string | null;
  requirement_id: string | null;
  attempt_id: string | null;
  operation_id: string | null;
  state: string;
  error_code: 'FEATURE_RETIRED' | null;
  created_at: string;
  updated_at: string;
  retirement_api_version: 6;
}
export interface TranslationRetirementEvidence {
  supported: boolean;
  rows: TranslationRetirementRow[];
  truncated: boolean;
  blind_spots: string[];
  policy: { retired_since_api_version: 6; historical_producer_coverage: 'unknown' };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STATES = [
  'pending',
  'leased',
  'running',
  'ready',
  'failed',
  'stale',
  'canceled',
  'expired',
  'skipped',
  'succeeded'
];
/** Only the schema projection is read: no provider IDs, filenames, content or grants. */
export async function getTranslationRetirementEvidence(
  id: string | null,
  since: string | null,
  asOf: string,
  kind: 'identity' | 'actor' | 'all' = 'identity',
  requestedLimit = 100
): Promise<TranslationRetirementEvidence> {
  const result: TranslationRetirementEvidence = {
    supported: Boolean((await getSchema()).tables.analytics_translation_retirement),
    rows: [],
    truncated: false,
    blind_spots: [],
    policy: { retired_since_api_version: 6, historical_producer_coverage: 'unknown' }
  };
  if (!result.supported) {
    result.blind_spots.push('Translation retirement projection unavailable; absence is unknown.');
    return result;
  }
  const end = Date.parse(asOf),
    start = since === null ? -Infinity : Date.parse(since);
  if (
    !['identity', 'actor', 'all'].includes(kind) ||
    (kind !== 'all' && (!id || !UUID.test(id))) ||
    !Number.isFinite(end) ||
    Number.isNaN(start) ||
    start > end
  ) {
    result.blind_spots.push(
      'Unknown subject or invalid window; no unscoped retirement query issued.'
    );
    return result;
  }
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 100;
  const rows = await query<Record<string, unknown>>(
    `select entity_kind,entity_id::text,team_id::text,actor_id::text,requirement_id::text,
       attempt_id::text,operation_id::text,state,error_code,created_at::text,updated_at::text,retirement_api_version
     from public.analytics_translation_retirement
     where ($4::text='all' or ($4::text='actor' and actor_id=$1::uuid)
       or ($4::text='identity' and $1::uuid in (entity_id,requirement_id,attempt_id,operation_id)))
       and created_at <= $3::timestamptz and ($2::timestamptz is null or updated_at >= $2::timestamptz)
     order by updated_at desc,entity_kind,entity_id limit $5`,
    [id, since, asOf, kind, limit + 1]
  );
  result.truncated = rows.length > limit;
  if (result.truncated)
    result.blind_spots.push('Retirement snapshot detail truncated; counts are a lower bound.');
  for (const raw of rows.slice(0, limit)) {
    const ids = [
      'entity_id',
      'team_id',
      'actor_id',
      'requirement_id',
      'attempt_id',
      'operation_id'
    ];
    const updated = typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : NaN;
    const created = typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : NaN;
    if (updated > end) {
      result.blind_spots.push(
        'Snapshot changed after as-of; earlier state cannot be reconstructed.'
      );
      continue;
    }
    if (
      !ids.every(
        key =>
          (raw[key] === null && !['entity_id', 'team_id'].includes(key)) ||
          (typeof raw[key] === 'string' && UUID.test(raw[key] as string))
      ) ||
      !['requirement', 'attempt', 'operation'].includes(String(raw.entity_kind)) ||
      !STATES.includes(String(raw.state)) ||
      ![null, 'FEATURE_RETIRED'].includes(raw.error_code as null) ||
      raw.retirement_api_version !== 6 ||
      !Number.isFinite(updated) ||
      !Number.isFinite(created) ||
      created > end ||
      updated < start ||
      (kind === 'actor' && raw.actor_id !== id) ||
      (kind === 'identity' &&
        !['entity_id', 'requirement_id', 'attempt_id', 'operation_id'].some(key => raw[key] === id))
    ) {
      result.blind_spots.push('Malformed or unrelated retirement snapshot omitted.');
      continue;
    }
    result.rows.push({
      entity_kind: raw.entity_kind,
      entity_id: raw.entity_id,
      team_id: raw.team_id,
      actor_id: raw.actor_id,
      requirement_id: raw.requirement_id,
      attempt_id: raw.attempt_id,
      operation_id: raw.operation_id,
      state: raw.state,
      error_code: raw.error_code,
      created_at: new Date(created).toISOString(),
      updated_at: new Date(updated).toISOString(),
      retirement_api_version: 6
    } as TranslationRetirementRow);
  }
  result.blind_spots = [...new Set(result.blind_spots)];
  return result;
}

export function inspectTranslationRetirement(
  id: string,
  evidence: TranslationRetirementEvidence
): import('./types.js').InspectFound | null {
  if (!evidence.rows.length) return null;
  const retired = evidence.rows.some(
    row => row.state === 'canceled' && row.error_code === 'FEATURE_RETIRED'
  );
  return {
    found: true,
    id,
    matched_by: ['authoritative_table'],
    capability: 'transcription.translate',
    tool: 'transcription',
    stages: {
      expected: ['server_retired', 'result_visible'],
      observed: retired ? ['server_retired'] : ['historical_snapshot'],
      missing: retired ? ['result_visible'] : ['server_retired', 'result_visible']
    },
    terminal: null,
    last_proven_stage: retired ? 'server_retired' : 'historical_snapshot',
    first_seen_at: evidence.rows.at(-1)!.created_at,
    last_seen_at: evidence.rows[0]!.updated_at,
    delivery_lag_ms: { p50: null, p95: null, samples: 0 },
    events: [],
    translation_retirement: evidence,
    agent: {
      local_app_versions: [],
      local_app_builds: [],
      web_build_ids: [],
      platforms: [],
      architectures: [],
      agent_instance_id: null,
      agent_instance_ids: [],
      agent_platforms: [],
      note: 'API6 describes retirement policy; the actual historical producer and browser delivery remain unknown.'
    }
  };
}
