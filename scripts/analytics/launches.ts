import { query } from './db.js';
import { getSchema } from './schema.js';
import { isRecord } from '../../packages/shared/src/team/contract.js';
import {
  LAUNCH_GENERATION_STATES,
  LAUNCH_STEP_STATES,
  LAUNCH_ANALYTICS_STAGES,
  safeLaunchAnalyticsCode
} from '../../packages/shared/src/team/launches.js';
const LAUNCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function utc(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
export interface LaunchEvidence {
  generation_id: string;
  launch_id: string;
  revision_id: string;
  flow_id: string | null;
  attempt_no: number;
  state: string;
  stage: string;
  method: string;
  safe_error_code: string | null;
  created_at: string;
  updated_at: string;
  result_is_active: boolean;
  catalog_registered: boolean;
  catalog_sub_binding?: { required: boolean; resolved: boolean; committed: boolean } | null;
  reuse_evidence: {
    video_operation_id: string | null;
    video_generation_id: string | null;
    catalog_revision_id: string | null;
  } | null;
  steps: Array<{
    stage: string;
    state: string;
    child_operation_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
}
export interface LaunchAssignmentEvidence {
  launch_id: string;
  agent_row_id: string | null;
  state: 'unassigned' | 'assigned' | 'released' | 'legacy_unknown';
  version: string;
  updated_at: string;
  counts_scope: 'current_read_not_as_of';
  manual_hold_count: number;
  current_assignment_count: number;
}
export interface LaunchEvidenceResult {
  assignments?: LaunchAssignmentEvidence[];
  supported: boolean;
  generations: LaunchEvidence[];
  blind_spots: string[];
}
/** Closed SELECT variant, scoped to opaque IDs; never selects config, URLs or provider payloads. */
export async function getLaunchEvidence(
  id: string,
  asOf?: string,
  since?: string | null
): Promise<LaunchEvidenceResult> {
  const schema = await getSchema();
  const assignments =
    schema.tables.analytics_launch_assignments && LAUNCH_ID_PATTERN.test(id)
      ? await getLaunchAssignmentEvidence(id, asOf, since)
      : [];
  const assignmentPart = schema.tables.analytics_launch_assignments ? { assignments } : {};
  if (!schema.tables.analytics_launch_generations)
    return {
      ...assignmentPart,
      supported: assignments.length > 0,
      generations: [],
      blind_spots: [
        'Launch authoritative diagnostic view is unavailable; absence of events does not prove no generation.'
      ]
    };
  if (!LAUNCH_ID_PATTERN.test(id)) return { supported: true, generations: [], blind_spots: [] };
  const rows = await query<Record<string, unknown>>(
    `select generation_id::text,launch_id::text,revision_id::text,flow_id,attempt_no,state,stage,method,safe_error_code,created_at::text,updated_at::text,result_is_active,catalog_registered,steps,to_jsonb(e)->'reuse_evidence' reuse_evidence,to_jsonb(e)->'catalog_sub_binding' catalog_sub_binding
 from public.analytics_launch_generations e where (generation_id=$1::uuid or launch_id=$1::uuid or revision_id=$1::uuid or actor_id=$1::uuid or flow_id=$1::text) and created_at <= $2::timestamptz and updated_at <= $2::timestamptz and ($3::timestamptz is null or created_at >= $3::timestamptz) order by created_at desc limit 100`,
    [id, asOf ?? '9999-12-31T23:59:59Z', since ?? null]
  );
  const generations: LaunchEvidence[] = [];
  let unexpectedProjection = false;
  let stepsTruncated = false;
  for (const row of rows) {
    if (
      [
        'generation_id',
        'launch_id',
        'revision_id',
        'state',
        'stage',
        'method',
        'created_at',
        'updated_at'
      ].some(k => typeof row[k] !== 'string') ||
      (row.flow_id !== null && typeof row.flow_id !== 'string') ||
      typeof row.attempt_no !== 'number' ||
      !Number.isSafeInteger(row.attempt_no) ||
      row.attempt_no < 1 ||
      (row.safe_error_code !== null && typeof row.safe_error_code !== 'string') ||
      typeof row.result_is_active !== 'boolean' ||
      typeof row.catalog_registered !== 'boolean' ||
      !Array.isArray(row.steps)
    )
      throw new Error('Invalid Launch diagnostic projection.');
    const steps: LaunchEvidence['steps'] = [];
    if (row.steps.length > 50) stepsTruncated = true;
    for (const step of row.steps.slice(0, 50)) {
      if (
        !isRecord(step) ||
        typeof step.stage !== 'string' ||
        typeof step.state !== 'string' ||
        (step.child_operation_id !== null && typeof step.child_operation_id !== 'string') ||
        typeof step.created_at !== 'string' ||
        typeof step.updated_at !== 'string'
      )
        throw new Error('Invalid Launch diagnostic stage.');
      const stage = LAUNCH_ANALYTICS_STAGES.find(value => value === step.stage) ?? 'unknown';
      const state = LAUNCH_STEP_STATES.find(value => value === step.state) ?? 'unknown';
      const childOperationId =
        step.child_operation_id === null || LAUNCH_ID_PATTERN.test(step.child_operation_id)
          ? step.child_operation_id
          : null;
      const createdAt = utc(step.created_at);
      const updatedAt = utc(step.updated_at);
      if (
        stage !== step.stage ||
        state !== step.state ||
        childOperationId !== step.child_operation_id ||
        createdAt === null ||
        updatedAt === null
      )
        unexpectedProjection = true;
      steps.push({
        stage,
        state,
        child_operation_id: childOperationId,
        created_at: createdAt ?? 'unknown',
        updated_at: updatedAt ?? 'unknown'
      });
    }
    // The projection is guarded above; assigning each property still narrows independently.
    if (
      typeof row.generation_id !== 'string' ||
      typeof row.launch_id !== 'string' ||
      typeof row.revision_id !== 'string' ||
      typeof row.state !== 'string' ||
      typeof row.stage !== 'string' ||
      typeof row.method !== 'string' ||
      typeof row.created_at !== 'string' ||
      typeof row.updated_at !== 'string'
    )
      throw new Error('Invalid Launch diagnostic identity.');
    const createdAt = utc(row.created_at);
    const updatedAt = utc(row.updated_at);
    if (createdAt === null || updatedAt === null)
      throw new Error('Invalid Launch diagnostic timestamp.');
    const state = LAUNCH_GENERATION_STATES.find(value => value === row.state) ?? 'unknown';
    const stage = LAUNCH_ANALYTICS_STAGES.find(value => value === row.stage) ?? 'unknown';
    const method = row.method === 'catalog' || row.method === 'other' ? row.method : 'unknown';
    const safeErrorCode =
      row.safe_error_code === null ? null : safeLaunchAnalyticsCode(row.safe_error_code);
    const flowId = row.flow_id === null || LAUNCH_ID_PATTERN.test(row.flow_id) ? row.flow_id : null;
    if (
      state !== row.state ||
      stage !== row.stage ||
      method !== row.method ||
      safeErrorCode !== row.safe_error_code ||
      flowId !== row.flow_id
    )
      unexpectedProjection = true;
    const reuse = row.reuse_evidence;
    const reuseEvidence =
      isRecord(reuse) &&
      ['video_operation_id', 'video_generation_id', 'catalog_revision_id'].every(
        key =>
          reuse[key] === null ||
          (typeof reuse[key] === 'string' && LAUNCH_ID_PATTERN.test(reuse[key]))
      )
        ? {
            video_operation_id: reuse.video_operation_id as string | null,
            video_generation_id: reuse.video_generation_id as string | null,
            catalog_revision_id: reuse.catalog_revision_id as string | null
          }
        : null;
    if (reuse != null && reuseEvidence === null) unexpectedProjection = true;
    const binding = row.catalog_sub_binding;
    const catalogSubBinding =
      isRecord(binding) &&
      ['required', 'resolved', 'committed'].every(key => typeof binding[key] === 'boolean')
        ? {
            required: binding.required as boolean,
            resolved: binding.resolved as boolean,
            committed: binding.committed as boolean
          }
        : null;
    if (binding != null && catalogSubBinding === null) unexpectedProjection = true;
    generations.push({
      generation_id: row.generation_id,
      launch_id: row.launch_id,
      revision_id: row.revision_id,
      flow_id: flowId,
      attempt_no: row.attempt_no,
      state,
      stage,
      method,
      safe_error_code: safeErrorCode,
      created_at: createdAt,
      updated_at: updatedAt,
      result_is_active: row.result_is_active,
      catalog_registered: row.catalog_registered,
      catalog_sub_binding: catalogSubBinding,
      reuse_evidence: reuseEvidence,
      steps
    });
  }
  return {
    ...assignmentPart,
    supported: true,
    generations,
    blind_spots: [
      'Database commit proves persistence; result visibility requires a browser signal.',
      'Assignment evidence is current and bounded to 100 rows; missing or later-updated rows cannot prove historical availability. External advertising delivery is unobservable.',
      ...(generations.some(g => g.catalog_sub_binding === null)
        ? ['Catalog SUB binding projection is unavailable; resolution cannot be inferred.']
        : []),
      ...(generations.some(g => g.reuse_evidence === null)
        ? [
            'Reuse provenance is unavailable; missing processing steps do not prove video processing was skipped.'
          ]
        : []),
      ...(generations.some(g =>
        ['cancel_requested', 'canceled_with_cleanup_pending'].includes(g.state)
      )
        ? [
            'Cancellation is unsettled; a child or provider side effect remains unknown until fenced reconciliation.'
          ]
        : []),
      ...(unexpectedProjection
        ? ['The diagnostic view returned unexpected values; their cause is unknown.']
        : []),
      ...(stepsTruncated
        ? ['The diagnostic step history exceeded 50 entries and was truncated.']
        : []),
      ...(asOf
        ? [
            'Current rows updated after as_of are excluded; the projection cannot reconstruct their historical state.'
          ]
        : [])
    ]
  };
}
export interface LaunchAuditEvidence {
  generations: number;
  missing_visibility: number;
  unknown_causes: number;
  unsettled: number;
}
export async function getLaunchAudit(
  start: string | null,
  end: string
): Promise<LaunchAuditEvidence | null> {
  const schema = await getSchema();
  if (!schema.tables.analytics_launch_generations) return null;
  const rows = await query<LaunchAuditEvidence & Record<string, unknown>>(
    `select count(*)::integer generations,
 count(*) filter(where g.state='succeeded' and not exists(select 1 from public.analytics_events e where e.event_name='team_launch_visible' and e.run_id=g.generation_id and e.properties->>'revision_id'=g.revision_id::text and e.created_at<=$2::timestamptz))::integer missing_visibility,
 count(*) filter(where g.safe_error_code='UNKNOWN' or (g.state in('failed','partial','interrupted') and g.safe_error_code is null))::integer unknown_causes,
 count(*) filter(where g.state in('cancel_requested','canceled_with_cleanup_pending') or g.state not in('succeeded','canceled') and g.next_attempt_at<=$2::timestamptz and (g.lease_expires_at is null or g.lease_expires_at<=$2::timestamptz))::integer unsettled
 from public.analytics_launch_generations g where ($1::timestamptz is null or g.created_at >= $1::timestamptz) and g.created_at <= $2::timestamptz and g.updated_at <= $2::timestamptz`,
    [start, end]
  );
  return rows[0] ?? { generations: 0, missing_visibility: 0, unknown_causes: 0, unsettled: 0 };
}

/** Current, content-free assignment proof. Later state is never reconstructed as historical. */
export async function getLaunchAssignmentEvidence(
  id: string,
  asOf?: string,
  since?: string | null
): Promise<LaunchAssignmentEvidence[]> {
  const schema = await getSchema();
  if (!schema.tables.analytics_launch_assignments || !LAUNCH_ID_PATTERN.test(id)) return [];
  const historicalMatch = schema.tables.analytics_launch_assignment_events
    ? ' or launch_id in (select launch_id from public.analytics_launch_assignment_events where (agent_row_id=$1::uuid or previous_agent_row_id=$1::uuid or actor_id=$1::uuid) and occurred_at<=$2::timestamptz)'
    : '';
  const rows = await query<Record<string, unknown>>(
    `select launch_id::text,agent_row_id::text,state,version::text,updated_at::text,manual_hold_count::integer,current_assignment_count::integer from public.analytics_launch_assignments where (launch_id=$1::uuid or agent_row_id=$1::uuid or actor_id=$1::uuid${historicalMatch}) and updated_at<=$2::timestamptz and ($3::timestamptz is null or updated_at>=$3::timestamptz) order by updated_at desc,launch_id limit 100`,
    [id, asOf ?? '9999-12-31T23:59:59Z', since ?? null]
  );
  return rows.map(row => {
    const version =
      typeof row.version === 'string'
        ? row.version
        : Number.isSafeInteger(row.version)
          ? String(row.version)
          : null;
    if (
      typeof row.launch_id !== 'string' ||
      !(row.agent_row_id === null || typeof row.agent_row_id === 'string') ||
      !['unassigned', 'assigned', 'released', 'legacy_unknown'].includes(String(row.state)) ||
      !/^[0-9]{1,19}$/u.test(version ?? '') ||
      typeof row.updated_at !== 'string' ||
      !utc(row.updated_at) ||
      !Number.isSafeInteger(row.manual_hold_count) ||
      Number(row.manual_hold_count) < 0 ||
      !Number.isSafeInteger(row.current_assignment_count) ||
      Number(row.current_assignment_count) < 0
    )
      throw new Error('Invalid Launch assignment diagnostic projection.');
    return {
      launch_id: row.launch_id,
      agent_row_id: row.agent_row_id as string | null,
      state: row.state as LaunchAssignmentEvidence['state'],
      version: version!,
      updated_at: utc(row.updated_at)!,
      counts_scope: 'current_read_not_as_of',
      manual_hold_count: Number(row.manual_hold_count),
      current_assignment_count: Number(row.current_assignment_count)
    };
  });
}
