import { query } from './db.js';
import { getSchema } from './schema.js';
import {
  isLaunchUuid,
  LAUNCH_GENERATION_STATES,
  LAUNCH_ANALYTICS_STAGES
} from '../../packages/shared/src/team/launches.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
import { INSPECT_AGENT_NOTE, type InspectData } from './types.js';
const instant = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const safeCode = (value: unknown) =>
  value === null ? null : (TEAM_ERROR_CODES.find(code => code === value) ?? 'UNKNOWN');
const videoStates = ['accepted', 'preparing', 'ready', 'cancel_requested', 'canceled', 'unknown'];
export interface DurableLaunchBatchRecord {
  batch_id: string;
  team_id: string;
  actor_id: string;
  request_key: string;
  created_at: string;
  cancel_requested_at: string | null;
  ordinal: number;
  member_count: number;
  launch_id: string;
  child_request_key: string;
  generation_id: string | null;
  video_set_id: string | null;
  admission: 'accepted' | 'refused' | 'pending' | 'unknown';
  error_code: string | null;
  admission_attempts: number | null;
  admission_next_attempt_at: string | null;
  cancel_pending: boolean | null;
  cancel_error_code: string | null;
  cancel_next_attempt_at: string | null;
  member_updated_at: string;
  snapshot_at_as_of: 'available' | 'unknown';
  generation: {
    state: string;
    stage: string;
    error_code: string | null;
    updated_at: string;
  } | null;
  video: {
    set_id: string;
    state: string;
    requested_count: number;
    registered_count: number;
    updated_at: string;
  } | null;
}
export interface DurableLaunchBatchEvidence {
  supported: boolean;
  scope: 'current_snapshot_not_transition_history';
  records: DurableLaunchBatchRecord[];
  truncated: boolean;
  invalid_record_count: number;
  blind_spots: string[];
}
/** Reads only the privacy-safe command projection. Matching a member or child
 * includes its bounded batch membership; no private intent or names are read. */
export async function getDurableLaunchBatchEvidence(
  id: string,
  asOf?: string
): Promise<DurableLaunchBatchEvidence> {
  const result: DurableLaunchBatchEvidence = {
    supported: !!(await getSchema()).tables.analytics_launch_batches,
    scope: 'current_snapshot_not_transition_history',
    records: [],
    truncated: false,
    invalid_record_count: 0,
    blind_spots: []
  };
  if (!result.supported) {
    result.blind_spots.push(
      'Durable batch projection is unavailable; missing browser events do not prove no command was accepted.'
    );
    return result;
  }
  if (!isLaunchUuid(id)) return result;
  if (asOf !== undefined && !instant(asOf)) throw Error('INVALID_INPUT');
  const rows = await query<Record<string, unknown>>(
    `with matched as(
  select batch_id,max(created_at) created_at from public.analytics_launch_batches
  where(batch_id=$1::uuid or request_key=$1::uuid or team_id=$1::uuid or actor_id=$1::uuid or launch_id=$1::uuid or child_request_key=$1::uuid or generation_id=$1::uuid)
   and created_at<=$2::timestamptz group by batch_id order by max(created_at)desc,batch_id desc limit 11)
 select b.batch_id::text,b.team_id::text,b.actor_id::text,b.request_key::text,b.created_at::text,b.cancel_requested_at::text,
 b.ordinal,b.member_count,b.launch_id::text,b.child_request_key::text,b.generation_id::text,b.admission,b.error_code,
 b.admission_attempts,b.admission_next_attempt_at::text,b.cancel_pending,b.cancel_error_code,b.cancel_next_attempt_at::text,b.member_updated_at::text,
 b.generation_state,b.generation_stage,b.generation_error_code,b.generation_updated_at::text,
 b.video_set_id::text,b.video_state,b.video_requested_count,b.video_registered_count,b.video_updated_at::text
 from public.analytics_launch_batches b join matched m on m.batch_id=b.batch_id order by b.created_at desc,b.batch_id desc,b.ordinal limit 101`,
    [id, asOf ?? '9999-12-31T23:59:59Z']
  );
  const batchIds = [...new Set(rows.map(row => row.batch_id))];
  const selectedBatches = new Set(batchIds.slice(0, 10));
  result.truncated = rows.length > 100 || batchIds.length > 10;
  const cutoff = asOf === undefined ? Infinity : Date.parse(asOf);
  for (const row of rows.slice(0, 100)) {
    if (!selectedBatches.has(row.batch_id)) continue;
    if (
      !['batch_id', 'team_id', 'actor_id', 'request_key', 'launch_id', 'child_request_key'].every(
        key => isLaunchUuid(row[key])
      ) ||
      !instant(row.created_at) ||
      !instant(row.member_updated_at) ||
      !count(row.ordinal, 100) ||
      row.ordinal < 1 ||
      !count(row.member_count, 100) ||
      row.member_count < 1 ||
      !['accepted', 'refused', 'pending'].includes(String(row.admission)) ||
      !count(row.admission_attempts, 2147483647) ||
      typeof row.cancel_pending !== 'boolean' ||
      (row.generation_id !== null && !isLaunchUuid(row.generation_id)) ||
      ['cancel_requested_at', 'admission_next_attempt_at', 'cancel_next_attempt_at'].some(
        key => row[key] !== null && !instant(row[key])
      )
    ) {
      result.invalid_record_count++;
      continue;
    }
    const current = Date.parse(row.member_updated_at) <= cutoff;
    let generation: DurableLaunchBatchRecord['generation'] = null,
      video: DurableLaunchBatchRecord['video'] = null;
    if (
      current &&
      row.generation_id !== null &&
      instant(row.generation_updated_at) &&
      Date.parse(row.generation_updated_at) <= cutoff
    ) {
      generation = {
        state: LAUNCH_GENERATION_STATES.find(state => state === row.generation_state) ?? 'unknown',
        stage: LAUNCH_ANALYTICS_STAGES.find(stage => stage === row.generation_stage) ?? 'unknown',
        error_code: safeCode(row.generation_error_code),
        updated_at: new Date(row.generation_updated_at).toISOString()
      };
    }
    if (
      current &&
      isLaunchUuid(row.video_set_id) &&
      instant(row.video_updated_at) &&
      Date.parse(row.video_updated_at) <= cutoff &&
      count(row.video_requested_count, 400) &&
      row.video_requested_count > 0 &&
      count(row.video_registered_count, row.video_requested_count)
    ) {
      video = {
        set_id: row.video_set_id,
        state: videoStates.find(state => state === row.video_state) ?? 'unknown',
        requested_count: row.video_requested_count,
        registered_count: row.video_registered_count,
        updated_at: new Date(row.video_updated_at).toISOString()
      };
    }
    result.records.push({
      batch_id: String(row.batch_id),
      team_id: String(row.team_id),
      actor_id: String(row.actor_id),
      request_key: String(row.request_key),
      created_at: new Date(row.created_at).toISOString(),
      cancel_requested_at:
        instant(row.cancel_requested_at) && Date.parse(row.cancel_requested_at) <= cutoff
          ? new Date(row.cancel_requested_at).toISOString()
          : null,
      ordinal: row.ordinal,
      member_count: row.member_count,
      launch_id: String(row.launch_id),
      child_request_key: String(row.child_request_key),
      generation_id: current ? (row.generation_id as string | null) : null,
      video_set_id: current && isLaunchUuid(row.video_set_id) ? row.video_set_id : null,
      admission: current ? (row.admission as DurableLaunchBatchRecord['admission']) : 'unknown',
      error_code: current ? safeCode(row.error_code) : null,
      admission_attempts: current ? row.admission_attempts : null,
      admission_next_attempt_at:
        current && instant(row.admission_next_attempt_at)
          ? new Date(row.admission_next_attempt_at).toISOString()
          : null,
      cancel_pending: current ? row.cancel_pending : null,
      cancel_error_code: current ? safeCode(row.cancel_error_code) : null,
      cancel_next_attempt_at:
        current && instant(row.cancel_next_attempt_at)
          ? new Date(row.cancel_next_attempt_at).toISOString()
          : null,
      member_updated_at: new Date(row.member_updated_at).toISOString(),
      snapshot_at_as_of: current ? 'available' : 'unknown',
      generation,
      video
    });
  }
  if (result.records.length) {
    result.blind_spots.push(
      'Current command, generation and video receipts do not reconstruct transition history or prove that the browser displayed the result.'
    );
    if (
      result.records.some(
        row =>
          row.snapshot_at_as_of === 'unknown' ||
          (row.generation_id && !row.generation) ||
          (row.video_set_id && !row.video)
      )
    )
      result.blind_spots.push(
        'One or more current outcomes changed after the requested as-of time or lack a readable child projection; their earlier state is unknown.'
      );
  }
  if (result.truncated)
    result.blind_spots.push(
      'The result is bounded to 100 members and at most 10 recent matching batches; omitted membership remains unknown.'
    );
  if (result.invalid_record_count)
    result.blind_spots.push(
      'Unexpected diagnostic projection rows were excluded; no content from them was returned.'
    );
  return result;
}
export function mergeDurableLaunchBatchInspection(
  core: InspectData,
  evidence: DurableLaunchBatchEvidence
): InspectData {
  if (!evidence.records.length)
    return !evidence.supported || evidence.invalid_record_count || (core.found && core.launch_batch)
      ? { ...core, durable_launch_batches: evidence }
      : core;
  if (core.found)
    return {
      ...core,
      matched_by: [...new Set([...core.matched_by, 'authoritative_table' as const])],
      durable_launch_batches: evidence
    };
  const records = evidence.records,
    observed = ['batch_committed'];
  if (records.some(row => row.admission === 'pending')) observed.push('admission_pending');
  if (records.some(row => row.admission === 'accepted')) observed.push('generation_accepted');
  if (records.some(row => row.cancel_requested_at)) observed.push('cancel_requested');
  const expected = ['batch_committed', 'generation_result', 'result_visible'];
  return {
    ...core,
    found: true,
    matched_by: ['authoritative_table'],
    capability: 'launches.batch_admission',
    tool: 'team',
    terminal: null,
    stages: { expected, observed, missing: expected.filter(stage => !observed.includes(stage)) },
    last_proven_stage: observed.at(-1)!,
    first_seen_at: records.map(row => row.created_at).sort()[0]!,
    last_seen_at: records
      .map(row => (row.snapshot_at_as_of === 'available' ? row.member_updated_at : row.created_at))
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
    durable_launch_batches: evidence
  };
}
