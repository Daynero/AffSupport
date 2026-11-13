import { CATALOG_IMAGE_ERROR_CODES } from '../../packages/shared/src/team/catalog-images.js';
import { GLOBAL_CATALOG_IMAGE_ERROR_CODES } from '../../packages/shared/src/team/catalog-global-images.js';
import { parseCatalogContentEvidence, type CatalogContentEvidence } from './catalog-content.js';
import {
  getCatalogVideoSessionEvidence,
  type CatalogVideoSessionEvidence
} from './catalog-video-sessions.js';
import { getCatalogVideoSetEvidence, type CatalogVideoSetEvidence } from './catalog-video-sets.js';
import { getCatalogGrowthEvidence, type CatalogGrowthEvidence } from './catalog-growth.js';
import {
  CATALOG_TIMING_STAGES,
  type CatalogTimingSnapshot
} from '../../supabase/functions/_shared/catalog-timings.js';
import { query } from './db.js';
import { getSchema } from './schema.js';
import { INSPECT_AGENT_NOTE, type InspectData, type ResolvedPeriod } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
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
  ...CATALOG_IMAGE_ERROR_CODES,
  ...GLOBAL_CATALOG_IMAGE_ERROR_CODES,
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
  'CATALOG_IMAGE_UPGRADE_REQUIRED',
  'RESTITCH_SCREEN_SELECTION_LIMIT',
  'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED',
  'RESTITCH_SCREEN_PREVIOUS_FAILURES',
  'RESTITCH_SCREEN_BYTE_LIMIT',
  'RESTITCH_SCREEN_IO_LIMIT',
  'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN',
  'RESTITCH_SCREEN_UNAVAILABLE',
  'RESTITCH_SCREEN_FETCH_FAILED',
  'RESTITCH_SCREEN_UNSUPPORTED',
  'RESTITCH_FORBIDDEN',
  'RESTITCH_NO_SCREENS',
  'RESTITCH_INVALID',
  'RESTITCH_POOL_EMPTY',
  'RESTITCH_SOURCE_FORBIDDEN',
  'RESTITCH_SOURCES_INVALID',
  'RESTITCH_SOURCES_TOO_MANY',
  'RESTITCH_CLIENT_OUTDATED',
  'PROCESS_RESULT_UNCERTAIN',
  'AGENT_UPDATE_REQUIRED',
  'SHARE_NOT_ALLOWED',
  'INVALID_INPUT',
  'CATALOG_WRITE_UNSUPPORTED'
]);
const FLAGS = [
  'settings_observed',
  'source_observed',
  'rows_planned',
  'provider_result_observed',
  'result_registered'
] as const;
export interface CatalogGenerationSnapshot extends CatalogContentEvidence {
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
  performance: CatalogTimingSnapshot | null;
  native_sheet_mode: boolean | null;
  native_sheet_bound: boolean | null;
  native_write_acknowledged: boolean | null;
}
export interface CatalogGenerationEvidence {
  foreground_authorities?: CatalogVideoSessionEvidence;
  growth_recipes?: CatalogGrowthEvidence;
  video_sets?: CatalogVideoSetEvidence;
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
      'Intermediate transition timings and browser delivery are unobserved.',
      'Missing native-write acknowledgement is not proof that an uncertain provider write did not apply.'
    ]
  };
  const schema = await getSchema();
  if (UUID.test(id))
    result.foreground_authorities = await getCatalogVideoSessionEvidence(id, period.as_of);
  if (schema.tables.analytics_catalog_growth_video_recipes && UUID.test(id))
    result.growth_recipes = await getCatalogGrowthEvidence(id, period.as_of);
  if (schema.tables.analytics_catalog_video_sets && UUID.test(id))
    result.video_sets = await getCatalogVideoSetEvidence(id, period.as_of);
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
      settings_observed,source_observed,rows_planned,provider_result_observed,result_registered,
      to_jsonb(g)->'performance' performance,
      to_jsonb(g)->'native_sheet_mode' native_sheet_mode,
      to_jsonb(g)->'native_sheet_bound' native_sheet_bound,
      to_jsonb(g)->'native_write_acknowledged' native_write_acknowledged,
      to_jsonb(g)->'content_receipt_status' content_receipt_status,
      to_jsonb(g)->'content_policy_version' content_policy_version,
      to_jsonb(g)->'planned_row_count' planned_row_count,
      to_jsonb(g)->'automatic_row_count' automatic_row_count,
      to_jsonb(g)->'retained_row_count' retained_row_count
     from public.analytics_catalog_generations g
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
      (state === 'interrupted' && code === null) ||
      origin === 'unknown' ||
      FLAGS.some(flag => typeof row[flag] !== 'boolean')
    )
      result.unknown_projection = true;
    const content = parseCatalogContentEvidence(row);
    if (content.content_receipt_status === 'invalid') result.unknown_projection = true;
    result.records.push({
      ...content,
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
      performance: parseCatalogPerformance(row.performance, Number(row.attempt)),
      native_sheet_mode: typeof row.native_sheet_mode === 'boolean' ? row.native_sheet_mode : null,
      native_sheet_bound:
        typeof row.native_sheet_bound === 'boolean' ? row.native_sheet_bound : null,
      native_write_acknowledged:
        typeof row.native_write_acknowledged === 'boolean' ? row.native_write_acknowledged : null,
      result_registered: typeof row.result_registered === 'boolean' ? row.result_registered : null
    });
  }
  if (result.records.some(record => record.content_receipt_status === 'unavailable'))
    result.blind_spots.push(
      'Frozen automatic-content receipts are unavailable for some attempts; legacy versus automatic content is unknown.'
    );
  result.blind_spots.push(
    'Policy selection is not a frozen recipe. Frozen row counts prove planning only, never provider delivery or browser visibility.'
  );
  if (result.records.some(record => !record.performance))
    result.blind_spots.push('Per-stage duration aggregates are unavailable for some attempts.');
  result.blind_spots.push(
    'Duration aggregates overlap, exclude the final checkpoint acknowledgement, and are not a transition history or browser-delivery proof.'
  );
  if (result.unknown_projection)
    result.blind_spots.push(
      'A generation projection contains missing or unrecognized diagnostic evidence.'
    );
  return result;
}

/** Old views/attempts and malformed projections remain explicitly unmeasured. */
export function parseCatalogPerformance(
  value: unknown,
  attempt: number
): CatalogTimingSnapshot | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('attempt' in value) ||
    value.attempt !== attempt ||
    !('steps' in value) ||
    !value.steps ||
    typeof value.steps !== 'object' ||
    Array.isArray(value.steps)
  )
    return null;
  const steps: CatalogTimingSnapshot['steps'] = {};
  for (const stage of CATALOG_TIMING_STAGES) {
    const metric: unknown = Reflect.get(value.steps, stage);
    if (metric === undefined) continue;
    if (
      !metric ||
      typeof metric !== 'object' ||
      !('calls' in metric) ||
      !('total_ms' in metric) ||
      !Number.isSafeInteger(metric.calls) ||
      Number(metric.calls) < 1 ||
      Number(metric.calls) > 10000 ||
      !Number.isSafeInteger(metric.total_ms) ||
      Number(metric.total_ms) < 0 ||
      Number(metric.total_ms) > 86400000
    )
      return null;
    steps[stage] = { calls: Number(metric.calls), total_ms: Number(metric.total_ms) };
  }
  return Object.keys(steps).length ? { attempt, steps } : null;
}

/** Only a catalog intent or its operation ID can establish one inspected creation. */
export function mergeCatalogGenerationInspection(
  core: InspectData,
  evidence: CatalogGenerationEvidence
): InspectData {
  const records = evidence.records.filter(
    row => row.intent_id === core.id.toLowerCase() || row.operation_id === core.id.toLowerCase()
  );
  const exact = { ...evidence, records };
  if (core.found)
    return records.length || core.capability === 'team.product_catalog'
      ? { ...core, catalog_generations: exact }
      : core;
  if (!records.length) return core;
  const row = records[0]!;
  const expected = [
    'accepted',
    'rows_planned',
    'provider_result_observed',
    'result_registered',
    'result_visible'
  ];
  const observed = ['accepted'];
  if (row.content_receipt_status === 'policy_selected' || row.content_receipt_status === 'frozen')
    observed.push('content_policy_selected');
  if (row.content_receipt_status === 'frozen') observed.push('content_recipe_frozen');
  if (row.rows_planned === true) observed.push('rows_planned');
  if (row.provider_result_observed === true) observed.push('provider_result_observed');
  if (row.result_registered === true) observed.push('result_registered');
  if (row.state === 'interrupted' || row.state === 'cleanup_pending' || row.state === 'canceled')
    observed.push(row.state);
  return {
    ...core,
    found: true,
    matched_by: ['authoritative_table'],
    capability: 'team.product_catalog',
    tool: 'team',
    catalog_generations: exact,
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    // A current interrupted state can recover; it is not an irreversible failure terminal.
    terminal:
      row.state === 'registered' && row.result_registered === true
        ? { event: 'catalog_registered', outcome: 'success', occurred_at: row.updated_at }
        : row.state === 'canceled'
          ? { event: 'catalog_canceled', outcome: 'cancelled', occurred_at: row.updated_at }
          : null,
    last_proven_stage: observed.at(-1)!,
    first_seen_at: row.created_at,
    last_seen_at: row.updated_at,
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
    events: []
  };
}
