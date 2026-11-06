import { query } from './db.js';
import { TEAM_ERROR_CODES } from '../../packages/shared/src/team/transport.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const codes = new Set<string>([
  ...TEAM_ERROR_CODES,
  'READ_FAILED',
  'SAVE_FAILED',
  'CONFLICT',
  'VALIDATION',
  'UNKNOWN'
]);
const stages = new Set([
  'opened',
  'stop_requested',
  'stop_accepted',
  'stop_not_active',
  'stop_reply_unknown',
  'stop_rejected',
  'stop_check_requested',
  'stop_readback_requested',
  'stop_target_inactive',
  'stop_target_active',
  'stop_readback_unknown',
  'result_visible'
]);
const results = new Set(['running', 'success', 'partial', 'failed', 'cancelled', 'unknown']);
interface UiRow {
  event_id: string;
  actor_id: string;
  flow_id: string;
  target_id: string | null;
  origin_id: string | null;
  event_name: string;
  stage: string;
  error_code: string | null;
  occurred_at: string;
  delivered_at: string;
}
interface TargetRow {
  attempt_id: string;
  started_at: string;
  ended_at: string | null;
  result: string;
  failure_code: string | null;
}
const iso = (value: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const failure = (cause: unknown) =>
  cause && typeof cause === 'object' && 'code' in cause && cause.code === '42P01'
    ? 'projection_unavailable'
    : 'read_failed';
/** Browser observations and current server state are separate evidence, never causal receipts. */
export async function getCatalogStopEvidence(
  id: string,
  asOf?: string,
  limit = 100,
  actorId?: string
) {
  const maximum = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 100, 1), 500);
  const unavailable: string[] = [];
  const cutoff = asOf ?? '9999-12-31T23:59:59Z';
  let ui: UiRow[] = [];
  let uiAvailable: boolean | null = UUID.test(id) && (!actorId || UUID.test(actorId)) ? true : null;
  if (UUID.test(id) && (!actorId || UUID.test(actorId))) {
    try {
      ui = await query<UiRow>(
        `select coalesce(event_id::text,id::text) event_id,user_id::text actor_id,flow_id,
        properties->>'parent_flow_id' target_id,properties->>'workflow_id' origin_id,
        event_name,properties->>'action_identifier' stage,properties->>'error_code' error_code,
        occurred_at::text,created_at::text delivered_at
        from public.analytics_events
        where properties->>'feature_identifier'='catalog_manager'
          and properties->>'flow_step'='catalog_manager_stop'
          and (${actorId ? 'user_id=$1::uuid' : "(flow_id=$1::uuid or (properties ? 'parent_flow_id' and properties->>'parent_flow_id'=$1::text) or (properties ? 'workflow_id' and properties->>'workflow_id'=$1::text))"})
          and occurred_at<=$2::timestamptz and created_at<=$2::timestamptz
          and event_name in ('operation_started','operation_stage_completed','operation_completed','operation_failed','operation_cancelled')
        order by created_at desc,id desc limit $3`,
        [actorId ?? id, cutoff, maximum + 1]
      );
    } catch (cause) {
      uiAvailable = false;
      unavailable.push('browser_stop:' + failure(cause));
    }
  }
  const grouped = new Map<string, UiRow[]>();
  for (const row of ui.slice(0, maximum)) {
    if (!UUID.test(row.flow_id) || !UUID.test(row.actor_id)) continue;
    const key = row.actor_id + ':' + row.flow_id;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const targetIds = [
    ...new Set(
      [...grouped.values()].flatMap(rows =>
        rows
          .map(row => row.target_id)
          .filter((value): value is string => Boolean(value && UUID.test(value)))
      )
    )
  ].slice(0, 20);
  let targetAvailable: boolean | null = null;
  let targets: TargetRow[] = [];
  if (targetIds.length) {
    try {
      const meta = await query<{ present: boolean }>(
        `select exists(select 1 from information_schema.views where table_schema='public' and table_name='analytics_catalog_updates') present`
      );
      targetAvailable = meta[0]?.present === true;
      if (targetAvailable)
        targets = await query<TargetRow>(
          `select attempt_id::text,started_at::text,ended_at::text,result,failure_code
        from public.analytics_catalog_updates where attempt_id=any($1::uuid[]) and started_at<=$2::timestamptz
        order by started_at desc,attempt_id limit 20`,
          [targetIds, cutoff]
        );
      else unavailable.push('target:projection_unavailable');
    } catch (cause) {
      targetAvailable = false;
      unavailable.push('target:' + failure(cause));
    }
  }
  return {
    ui_available: uiAvailable,
    scope: uiAvailable === null ? 'unresolved' : actorId ? 'actor' : 'identifier',
    uncorrelated_event_count: ui
      .slice(0, maximum)
      .filter(row => !UUID.test(row.flow_id) || !UUID.test(row.actor_id)).length,
    target_available: targetAvailable,
    observed_at: asOf || targetAvailable !== true ? null : new Date().toISOString(),
    as_of: asOf ?? null,
    target_basis: 'current_snapshot_with_terminal_cutoff' as const,
    truncated:
      ui.length > maximum || new Set(ui.map(row => row.target_id).filter(Boolean)).size > 20,
    unavailable_sources: unavailable,
    flows: [...grouped.values()].map(rows => {
      const targetIds = [
        ...new Set(
          rows
            .map(row => row.target_id)
            .filter((value): value is string => Boolean(value && UUID.test(value)))
        )
      ];
      const originIds = [
        ...new Set(
          rows
            .map(row => row.origin_id)
            .filter((value): value is string => Boolean(value && UUID.test(value)))
        )
      ];
      const invalidRelation = rows.some(
        row =>
          (row.target_id !== null && !UUID.test(row.target_id)) ||
          (row.origin_id !== null && !UUID.test(row.origin_id))
      );
      const target =
        targetIds.length === 1 && !invalidRelation
          ? targets.find(row => row.attempt_id === targetIds[0])
          : null;
      const ended = iso(target?.ended_at ?? null);
      const terminalInWindow = Boolean(ended && (!asOf || Date.parse(ended) <= Date.parse(asOf)));
      const has = (stage: string) => rows.some(row => row.stage === stage);
      const terminalNames = [
        ...new Set(
          rows
            .filter(row =>
              ['operation_completed', 'operation_failed', 'operation_cancelled'].includes(
                row.event_name
              )
            )
            .map(row => row.event_name)
        )
      ];
      return {
        flow_id: rows[0]!.flow_id,
        actor_id: rows[0]!.actor_id,
        target_attempt_id: targetIds.length === 1 && !invalidRelation ? targetIds[0] : null,
        origin_flow_id: originIds.length === 1 ? originIds[0] : null,
        correlation: invalidRelation
          ? 'invalid'
          : targetIds.length > 1 || originIds.length > 1
            ? 'conflicting'
            : targetIds.length === 1
              ? 'browser_asserted'
              : 'target_unobserved',
        expected_observations: has('stop_check_requested')
          ? [
              'stop_check_requested',
              'stop_readback_requested',
              'readback_observed',
              'result_visible'
            ]
          : [
              'stop_requested',
              'request_outcome_observed',
              'stop_readback_requested',
              'readback_observed',
              'result_visible'
            ],
        request_observed: has('stop_requested'),
        check_observed: has('stop_check_requested'),
        browser_reported_reply:
          ['stop_accepted', 'stop_not_active', 'stop_reply_unknown', 'stop_rejected'].filter(has)
            .length > 1
            ? 'conflicting'
            : has('stop_accepted')
              ? 'accepted'
              : has('stop_not_active')
                ? 'not_active'
                : has('stop_reply_unknown')
                  ? 'unknown'
                  : has('stop_rejected')
                    ? 'rejected'
                    : 'unobserved',
        browser_reported_readback:
          has('stop_target_inactive') && has('stop_target_active')
            ? 'conflicting'
            : has('stop_target_inactive')
              ? 'inactive'
              : has('stop_target_active')
                ? 'active'
                : 'unknown',
        ui_terminal:
          terminalNames.length === 1
            ? terminalNames[0]
            : terminalNames.length > 1
              ? 'conflicting'
              : null,
        visible_result_observed: has('result_visible'),
        target: target
          ? {
              attempt_id: target.attempt_id,
              started_at: iso(target.started_at),
              ended_at: terminalInWindow ? ended : null,
              result:
                results.has(target.result) && (!asOf || terminalInWindow)
                  ? target.result
                  : 'unknown',
              failure_code:
                terminalInWindow && target.failure_code
                  ? codes.has(target.failure_code)
                    ? target.failure_code
                    : 'UNKNOWN'
                  : null
            }
          : null,
        stages: rows
          .map(row => ({
            event_id: typeof row.event_id === 'string' ? row.event_id : null,
            stage: stages.has(row.stage) ? row.stage : 'unknown',
            event: row.event_name,
            code: row.error_code
              ? codes.has(row.error_code)
                ? row.error_code
                : 'UNKNOWN'
              : row.event_name === 'operation_failed'
                ? 'UNKNOWN'
                : null,
            occurred_at: iso(row.occurred_at),
            delivered_at: iso(row.delivered_at)
          }))
          .reverse()
      };
    }),
    blind_spots: [
      ...(uiAvailable === null
        ? ['Stop identifier or actor scope is unresolved; no browser query was made.']
        : []),
      'Stop is a separate browser lifecycle; its terminal never replaces the target update terminal.',
      'The target relation and RPC acknowledgement are browser observations, not a durable server Stop receipt or proof that Stop caused the target terminal.',
      'The target is a current snapshot filtered by terminal time, not reconstructed historical state. Later mutable changes remain unobservable.',
      'A target cancellation or inactive-round readback does not prove native child termination or provider quiescence.',
      'Missing or delayed browser evidence is unknown, never proof that no Stop request was sent.',
      ...(targetIds.length
        ? []
        : ['No observed attempt identity is available; no target outcome is inferred.'])
    ]
  };
}
export type CatalogStopEvidence = Awaited<ReturnType<typeof getCatalogStopEvidence>>;
