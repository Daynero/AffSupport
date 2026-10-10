import { createHash } from 'node:crypto';
import { query, queryOne } from './db.js';
import { eventColumnSql, getSchema, missingObjects, schemaSummary } from './schema.js';
import {
  COVERAGE_REGISTRY,
  capabilitySignals,
  emittedOnly,
  notEmitted,
  registryEventStatuses,
  signalStatus,
  type Capability,
  type CapabilitySignal,
  type ProducerStatus
} from './coverage-registry.js';
import { sanitizeEventProperties } from './sanitize.js';
import type {
  AnalyticsSchema,
  AuditCapability,
  AuditData,
  AuditDelivery,
  AuditFinding,
  AuditStatus,
  AuditUnknownCode,
  DeliveryLag,
  FindingSeverity,
  FrictionRow,
  InspectData,
  InspectFound,
  StageRow,
  UnsupportedSignal,
  CompressorData,
  EventRow,
  FunnelStage,
  OverviewData,
  ResolvedPeriod,
  ToolRow,
  TopListItem,
  TopUsersData,
  UserDetailData,
  UserSummary,
  UsersData,
  StageMetric,
  ErrorCluster,
  FrictionSignal,
  FeatureMetric,
  JourneyEvent,
  CohortMetric,
  RetentionMetric,
  TeamWorkspaceData,
  TeamFindCueMetric,
  TeamActivationWindow,
  SyncConnection,
  SyncData,
  SyncJobRow,
  ConnectionBrowserRow,
  ConnectionData,
  ConnectionOriginRow,
  ConnectionReasonRow
} from './types.js';
import {
  CONNECTION_COVERAGE_NOTE,
  INSPECT_AGENT_NOTE,
  NO_AGENT_CONTEXT_COHORT,
  UNSUPPORTED_BY_PRODUCER
} from './types.js';

/** Range params are always $1 = start (nullable), $2 = end. */
function rangeParams(period: ResolvedPeriod): [string | null, string] {
  return [period.start, period.end];
}

/**
 * Range predicate for the analytics_events table (alias `e`). The end bound is
 * inclusive so a window fixed with `--as-of X` reads `created_at <= X` (031
 * FR-055); `created_at` is the server clock, which is what a repeatable
 * snapshot has to be pinned to.
 */
const EVENTS_RANGE = `($1::timestamptz is null or e.created_at >= $1::timestamptz) and e.created_at <= $2::timestamptz`;

/* ---------------------------------------------------------------------------
 * 031 — which event names the aggregate commands compute from. Every list is
 * derived from the coverage registry so a signal without a producer never
 * reaches SQL as a number; it is reported as `unsupported_by_producer` instead.
 * ------------------------------------------------------------------------- */

const COMPRESSOR_EVENTS = [
  'tool_opened',
  'videos_added',
  'compression_batch_started',
  'compression_started',
  'compression_completed',
  'compression_failed'
] as const;

const GENERIC_LIFECYCLE_EVENTS = [
  'input_add_completed',
  'operation_started',
  'operation_completed',
  'operation_failed',
  'operation_cancelled'
] as const;

/** Terminal outcomes across tools, as the registry says a producer emits them today. */
const SUCCESS_EVENTS = emittedOnly([
  'operation_completed',
  'compression_completed',
  'landing_optimization_completed',
  'stitch_completed'
] as const);
const FAILURE_EVENTS = emittedOnly([
  'operation_failed',
  'compression_failed',
  'landing_optimization_failed',
  'stitch_failed'
] as const);
/** A start counts toward "started without outcome" only when its terminal has a producer. */
const START_EVENTS = (
  [
    ['operation_started', 'operation_completed'],
    ['compression_started', 'compression_completed'],
    ['landing_optimization_started', 'landing_optimization_completed'],
    ['stitch_started', 'stitch_completed']
  ] as const
)
  .filter(([start, terminal]) => emittedOnly([start, terminal]).length === 2)
  .map(([start]) => start);
const INPUT_EVENTS = ['input_add_completed', 'videos_added'] as const;
const BLOCKED_EVENTS = emittedOnly([
  'validation_message_shown',
  'blocked_action_attempted'
] as const);
const UPDATE_PROMPT_EVENTS = emittedOnly(['update_prompt_shown', 'agent_update_required'] as const);
const UPDATE_DONE_EVENTS = emittedOnly(['update_completed'] as const);
const FEATURE_INTERACTION_CANDIDATES = [
  'feature_enabled',
  'feature_help_opened',
  'feature_disabled',
  'setting_changed'
] as const;
const FEATURE_INTERACTION_EVENTS = emittedOnly(FEATURE_INTERACTION_CANDIDATES);

function stageEventsOf(capabilityIds: string[]): string[] {
  const names = new Set<string>();
  for (const capability of COVERAGE_REGISTRY) {
    if (!capabilityIds.includes(capability.id)) continue;
    for (const events of Object.values(capability.stageEvents)) {
      for (const event of events ?? []) names.add(event);
    }
  }
  return [...names];
}

const ONBOARDING_STAGE_EVENTS = stageEventsOf(['onboarding.local_app', 'onboarding.legacy']);
const UPDATE_STAGE_EVENTS = stageEventsOf(['update.run']);
const LINK_EVENT_NAMES = [
  'link_check_started',
  'link_check_completed',
  'link_lost',
  'link_recovered',
  'reconnect_clicked',
  'blocked_by_browser_detected',
  'link_inconsistency'
] as const;

const LINK_EVENT_LIST = LINK_EVENT_NAMES.map(name => `'${name}'`).join(',');

const TEAM_WORKSPACE_EVENTS = [
  'team_onboarding_started',
  'team_onboarding_completed',
  'team_find_started',
  'team_find_completed',
  'team_workspace_session',
  'team_preview_completed',
  'team_file_attempt_completed',
  'team_workflow_completed',
  'team_storage_connected',
  'team_index_completed',
  'team_previews_ready',
  'team_storage_attention'
] as const;

/**
 * Every event name an aggregate command computes a number from. `audit` marks
 * a registry signal `declared_but_never_emitted` when it is here without a
 * producer (SC-014). Probes the audit itself runs are listed separately.
 */
export const QUERY_EVENT_NAMES: readonly string[] = Object.freeze(
  [
    ...new Set<string>([
      ...COMPRESSOR_EVENTS,
      ...GENERIC_LIFECYCLE_EVENTS,
      ...SUCCESS_EVENTS,
      ...FAILURE_EVENTS,
      ...START_EVENTS,
      ...INPUT_EVENTS,
      ...BLOCKED_EVENTS,
      ...UPDATE_PROMPT_EVENTS,
      ...UPDATE_DONE_EVENTS,
      ...FEATURE_INTERACTION_EVENTS,
      'feature_impression',
      'error_occurred',
      ...emittedOnly(ONBOARDING_STAGE_EVENTS),
      ...emittedOnly(UPDATE_STAGE_EVENTS),
      ...TEAM_WORKSPACE_EVENTS,
      ...LINK_EVENT_NAMES
    ])
  ].sort()
);

/** Events `audit` reads to detect emission; they are probes, never metrics. */
export const AUDIT_PROBE_EVENT_NAMES: readonly string[] = Object.freeze([
  'analytics_delivery_report',
  'error_occurred'
]);

/**
 * Emitted starts the CLI deliberately leaves out of its metrics because their
 * terminal has no producer yet (FR-050): counting them would report every run
 * as "started without outcome". They return to `QUERY_EVENT_NAMES` by
 * themselves once the registry marks the terminal emitted.
 */
export const DEFERRED_EVENT_NAMES: readonly string[] = Object.freeze(
  emittedOnly([
    'landing_optimization_started',
    'stitch_started',
    'estimate_started'
  ] as const).filter(event => !QUERY_EVENT_NAMES.includes(event))
);

/** Signals the registry declares for a command but no producer emits, as rows. */
function unsupportedRows<K extends string>(
  key: K,
  events: readonly string[],
  note?: string
): Array<UnsupportedSignal & Record<K, string>> {
  return notEmitted(events)
    .sort()
    .map(event => ({
      ...({ [key]: event } as Record<K, string>),
      status: UNSUPPORTED_BY_PRODUCER,
      events: [event],
      ...(note ? { note } : {})
    }));
}

/* ---------------------------------------------------------------------------
 * 031 FR-055 — delivery lag: how long an event waited between happening in the
 * browser (`occurred_at`) and landing in the table (`created_at`).
 * ------------------------------------------------------------------------- */

const LAG_MS = `extract(epoch from (e.created_at - e.occurred_at)) * 1000`;

export async function getDeliveryLag(period: ResolvedPeriod): Promise<DeliveryLag> {
  const row = await queryOne<{ samples: number; p50: number | null; p95: number | null }>(
    `select
       count(*) filter (where e.occurred_at is not null)::int as samples,
       percentile_cont(0.5) within group (order by ${LAG_MS})
         filter (where e.occurred_at is not null) as p50,
       percentile_cont(0.95) within group (order by ${LAG_MS})
         filter (where e.occurred_at is not null) as p95
     from public.analytics_events e
     where ${EVENTS_RANGE}`,
    rangeParams(period)
  );
  return {
    p50: toMs(row?.p50),
    p95: toMs(row?.p95),
    samples: row?.samples ?? 0
  };
}

function toMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** The same statistic over rows already in memory (one attempt in `inspect`). */
export function deliveryLagOf(
  rows: Array<{ occurred_at: string; created_at: string }>
): DeliveryLag {
  const lags = rows
    .map(row => Date.parse(row.created_at) - Date.parse(row.occurred_at))
    .filter(value => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    p50: percentile(lags, 0.5),
    p95: percentile(lags, 0.95),
    samples: lags.length
  };
}

/** `percentile_cont` semantics: linear interpolation between the two nearest ranks. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Math.round(value);
}

async function topList(
  period: ResolvedPeriod,
  column: string,
  extraWhere = ''
): Promise<TopListItem[]> {
  const rows = await query<{ name: string | null; count: number }>(
    `select ${column} as name, count(*)::int as count
     from public.analytics_events e
     where ${EVENTS_RANGE} and ${column} is not null ${extraWhere}
     group by ${column}
     order by count desc, name asc
     limit 10`,
    rangeParams(period)
  );
  return rows.map(r => ({ name: r.name ?? 'unknown', count: r.count }));
}

export async function getOverview(period: ResolvedPeriod): Promise<OverviewData> {
  const params = rangeParams(period);

  const users = await queryOne<{
    total_users: number;
    new_users: number;
    active_users: number;
  }>(
    `select
       count(*) filter (where account_status <> 'deleted')::int as total_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or registered_at >= $1::timestamptz)
           and registered_at <= $2::timestamptz
       )::int as new_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or last_seen_at >= $1::timestamptz)
           and last_seen_at <= $2::timestamptz
       )::int as active_users
     from public.analytics_users`,
    params
  );

  const events = await queryOne<{
    sessions: number;
    total_events: number;
    tool_opens: number;
    compression_batches: number;
    videos_added: number;
    compressions_completed: number;
    compressions_failed: number;
  }>(
    `select
       count(distinct session_id)::int as sessions,
       count(*)::int as total_events,
       count(*) filter (where event_name = 'tool_opened')::int as tool_opens,
       count(*) filter (where event_name = 'compression_batch_started')::int as compression_batches,
       coalesce(sum(
         case when event_name = 'videos_added' and jsonb_typeof(properties -> 'video_count') = 'number'
           then (properties ->> 'video_count')::numeric else 0 end
       ), 0)::int as videos_added,
       count(*) filter (where event_name = 'compression_completed')::int as compressions_completed,
       count(*) filter (where event_name = 'compression_failed')::int as compressions_failed
     from public.analytics_events e
     where ${EVENTS_RANGE}`,
    params
  );

  const [topLocales, topPlatforms, topAppVersions, topAgentVersions] = await Promise.all([
    topList(period, 'locale'),
    topList(period, 'platform'),
    topList(period, 'app_version'),
    topList(period, 'agent_version')
  ]);

  return {
    total_users: users?.total_users ?? 0,
    new_users: users?.new_users ?? 0,
    active_users: users?.active_users ?? 0,
    sessions: events?.sessions ?? 0,
    total_events: events?.total_events ?? 0,
    tool_opens: events?.tool_opens ?? 0,
    compression_batches: events?.compression_batches ?? 0,
    videos_added: events?.videos_added ?? 0,
    videos_compressed: events?.compressions_completed ?? 0,
    compressions_completed: events?.compressions_completed ?? 0,
    compressions_failed: events?.compressions_failed ?? 0,
    top_locales: topLocales,
    top_platforms: topPlatforms,
    top_app_versions: topAppVersions,
    top_agent_versions: topAgentVersions
  };
}

export async function getCompressor(period: ResolvedPeriod): Promise<CompressorData> {
  const row = await queryOne<{
    unique_users: number;
    tool_opens: number;
    videos_added: number;
    compression_started: number;
    compression_completed: number;
    compression_failed: number;
    batch_count: number;
    total_input_bytes: number;
    total_output_bytes: number;
    saved_bytes: number;
    average_saving_percent: number | null;
    average_duration_ms: number | null;
  }>(
    `select
       count(distinct user_id) filter (where tool = 'compressor')::int as unique_users,
       count(*) filter (where event_name = 'tool_opened' and tool = 'compressor')::int as tool_opens,
       coalesce(sum(
         case when event_name = 'videos_added' and jsonb_typeof(properties -> 'video_count') = 'number'
           then (properties ->> 'video_count')::numeric else 0 end
       ), 0)::int as videos_added,
       count(*) filter (where event_name = 'compression_started')::int as compression_started,
       count(*) filter (where event_name = 'compression_completed')::int as compression_completed,
       count(*) filter (where event_name = 'compression_failed')::int as compression_failed,
       count(*) filter (where event_name = 'compression_batch_started')::int as batch_count,
       coalesce(sum(
         case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'total_input_bytes') = 'number'
           then (properties ->> 'total_input_bytes')::numeric else 0 end
       ), 0)::numeric as total_input_bytes,
       coalesce(sum(
         case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'total_output_bytes') = 'number'
           then (properties ->> 'total_output_bytes')::numeric else 0 end
       ), 0)::numeric as total_output_bytes,
       coalesce(sum(
         case when event_name = 'compression_completed'
           and jsonb_typeof(properties -> 'total_input_bytes') = 'number'
           and jsonb_typeof(properties -> 'total_output_bytes') = 'number'
           then greatest((properties ->> 'total_input_bytes')::numeric - (properties ->> 'total_output_bytes')::numeric, 0)
           else 0 end
       ), 0)::numeric as saved_bytes,
       avg(
         case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'saving_percent') = 'number'
           then (properties ->> 'saving_percent')::numeric end
       )::numeric as average_saving_percent,
       avg(
         case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'processing_duration_ms') = 'number'
           then (properties ->> 'processing_duration_ms')::numeric end
       )::numeric as average_duration_ms
     from public.analytics_events e
     where ${EVENTS_RANGE}`,
    rangeParams(period)
  );

  const completed = row?.compression_completed ?? 0;
  const failed = row?.compression_failed ?? 0;
  const started = row?.compression_started ?? 0;
  const batches = row?.batch_count ?? 0;
  const attempts = completed + failed;

  return {
    unique_users: row?.unique_users ?? 0,
    tool_opens: row?.tool_opens ?? 0,
    videos_added: row?.videos_added ?? 0,
    compression_started: started,
    compression_completed: completed,
    compression_failed: failed,
    started_without_completion: Math.max(started - completed, 0),
    batch_count: batches,
    total_videos_compressed: completed,
    average_batch_size: batches > 0 ? round(completed / batches, 2) : null,
    total_input_bytes: row?.total_input_bytes ?? 0,
    total_output_bytes: row?.total_output_bytes ?? 0,
    saved_bytes: row?.saved_bytes ?? 0,
    average_saving_percent:
      row?.average_saving_percent != null ? round(row.average_saving_percent, 2) : null,
    success_rate: attempts > 0 ? round(completed / attempts, 4) : null,
    average_duration_ms:
      row?.average_duration_ms != null ? Math.round(row.average_duration_ms) : null
  };
}

export async function getUsers(period: ResolvedPeriod, limit = 10): Promise<UsersData> {
  const params = rangeParams(period);
  const totals = await queryOne<{
    total_users: number;
    new_users: number;
    active_users: number;
  }>(
    `select
       count(*) filter (where account_status <> 'deleted')::int as total_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or registered_at >= $1::timestamptz)
           and registered_at <= $2::timestamptz
       )::int as new_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or last_seen_at >= $1::timestamptz)
           and last_seen_at <= $2::timestamptz
       )::int as active_users
     from public.analytics_users`,
    params
  );

  const lastActive = await query<UserSummary>(
    `select id, email, display_name, registered_at, last_seen_at
     from public.analytics_users
     where account_status <> 'deleted' and last_seen_at is not null
     order by last_seen_at desc
     limit $1`,
    [limit]
  );

  return {
    total_users: totals?.total_users ?? 0,
    new_users: totals?.new_users ?? 0,
    active_users: totals?.active_users ?? 0,
    last_active: lastActive
  };
}

export async function getTopUsers(
  period: ResolvedPeriod,
  by: 'activity' | 'compressions',
  limit = 10
): Promise<TopUsersData> {
  const params = [...rangeParams(period), limit];
  const eventFilter = by === 'compressions' ? `and e.event_name = 'compression_completed'` : '';
  const metric = by === 'compressions' ? 'compressions' : 'event_count';

  const users = await query<UserSummary>(
    `select
       u.id,
       u.email,
       u.display_name,
       u.registered_at,
       u.last_seen_at,
       count(e.id)::int as ${metric}
     from public.analytics_events e
     join public.analytics_users u on u.id = e.user_id
     where ${EVENTS_RANGE} and e.user_id is not null ${eventFilter}
     group by u.id, u.email, u.display_name, u.registered_at, u.last_seen_at
     order by count(e.id) desc, u.last_seen_at desc nulls last
     limit $3`,
    params
  );

  return { by, users };
}

export async function getUserDetail(
  email: string,
  recentLimit = 20
): Promise<UserDetailData | null> {
  const profile = await queryOne<{
    id: string;
    email: string | null;
    display_name: string | null;
    language: string | null;
    plan: string | null;
    account_status: string | null;
    registered_at: string | null;
    last_login_at: string | null;
    last_seen_at: string | null;
  }>(
    `select id, email, display_name, language, plan, account_status,
            registered_at, last_login_at, last_seen_at
     from public.analytics_users
     where email_normalized = lower($1)
     limit 1`,
    [email]
  );
  if (!profile) return null;

  const stats = await queryOne<{
    sessions: number;
    total_events: number;
    compressions_completed: number;
  }>(
    `select
       count(distinct session_id)::int as sessions,
       count(*)::int as total_events,
       count(*) filter (where event_name = 'compression_completed')::int as compressions_completed
     from public.analytics_events
     where user_id = $1`,
    [profile.id]
  );

  const toolUsage = await query<{ name: string | null; count: number }>(
    `select tool as name, count(*)::int as count
     from public.analytics_events
     where user_id = $1 and tool is not null
     group by tool order by count desc`,
    [profile.id]
  );

  const eventBreakdown = await query<{ name: string; count: number }>(
    `select event_name as name, count(*)::int as count
     from public.analytics_events
     where user_id = $1
     group by event_name order by count desc`,
    [profile.id]
  );

  const recent = await query<{
    event_name: string;
    tool: string | null;
    created_at: string;
    properties: Record<string, unknown>;
  }>(
    `select event_name, tool, created_at, properties
     from public.analytics_events
     where user_id = $1
     order by created_at desc
     limit $2`,
    [profile.id, recentLimit]
  );

  return {
    ...profile,
    sessions: stats?.sessions ?? 0,
    total_events: stats?.total_events ?? 0,
    compressions_completed: stats?.compressions_completed ?? 0,
    videos_compressed: stats?.compressions_completed ?? 0,
    tool_usage: toolUsage.map(t => ({ name: t.name ?? 'unknown', count: t.count })),
    event_breakdown: eventBreakdown.map(e => ({ name: e.name, count: e.count })),
    recent_events: recent.map(r => ({
      event_name: r.event_name,
      tool: r.tool,
      created_at: r.created_at,
      properties: r.properties ?? {}
    }))
  };
}

export async function getTools(period: ResolvedPeriod): Promise<ToolRow[]> {
  const rows = await query<ToolRow>(
    `select
       tool,
       count(*) filter (where event_name = 'tool_opened')::int as opens,
       count(distinct user_id)::int as unique_users,
       coalesce(sum(case
         when event_name = 'videos_added' then
           case when jsonb_typeof(properties -> 'video_count') = 'number'
             then (properties ->> 'video_count')::int else 1 end
         when event_name = 'input_add_completed' then
           case when jsonb_typeof(properties -> 'file_count') = 'number'
             then (properties ->> 'file_count')::int else 1 end
         else 0 end), 0)::int as inputs,
       coalesce(sum(case
         when event_name = 'compression_started' then 1
         when event_name = 'operation_started' then
           case when jsonb_typeof(properties -> 'file_count') = 'number'
             then (properties ->> 'file_count')::int else 1 end
         else 0 end), 0)::int as starts,
       coalesce(sum(case
         when event_name = 'compression_completed' then 1
         when event_name = 'operation_completed' then
           case when jsonb_typeof(properties -> 'file_count') = 'number'
             then (properties ->> 'file_count')::int else 1 end
         else 0 end), 0)::int as completions,
       coalesce(sum(case
         when event_name in ('compression_failed', 'operation_failed') then
           case when jsonb_typeof(properties -> 'file_count') = 'number'
             then (properties ->> 'file_count')::int else 1 end
         else 0 end), 0)::int as failures,
       coalesce(sum(case
         when event_name = 'operation_cancelled' then
           case when jsonb_typeof(properties -> 'file_count') = 'number'
             then (properties ->> 'file_count')::int else 1 end
         else 0 end), 0)::int as cancellations
     from public.analytics_events e
     where ${EVENTS_RANGE} and tool is not null
     group by tool
     order by opens desc, tool asc`,
    rangeParams(period)
  );
  return rows;
}

export async function getEvents(period: ResolvedPeriod): Promise<EventRow[]> {
  const rows = await query<EventRow>(
    `select event_name, count(*)::int as count, count(distinct user_id)::int as unique_users
     from public.analytics_events e
     where ${EVENTS_RANGE}
     group by event_name
     order by count desc, event_name asc`,
    rangeParams(period)
  );
  return rows;
}

export async function getFunnel(period: ResolvedPeriod): Promise<FunnelStage[]> {
  const row = await queryOne<{
    tool_opened: number;
    videos_added: number;
    compression_started: number;
    compression_completed: number;
  }>(
    `select
       count(distinct user_id) filter (where event_name = 'tool_opened' and tool = 'compressor')::int as tool_opened,
       count(distinct user_id) filter (where event_name = 'videos_added')::int as videos_added,
       count(distinct user_id) filter (where event_name = 'compression_started')::int as compression_started,
       count(distinct user_id) filter (where event_name = 'compression_completed')::int as compression_completed
     from public.analytics_events e
     where ${EVENTS_RANGE}`,
    rangeParams(period)
  );

  const stages: Array<[string, number]> = [
    ['tool_opened', row?.tool_opened ?? 0],
    ['videos_added', row?.videos_added ?? 0],
    ['compression_started', row?.compression_started ?? 0],
    ['compression_completed', row?.compression_completed ?? 0]
  ];

  const first = stages[0][1];
  return stages.map(([stage, users], index) => {
    const prev = index > 0 ? stages[index - 1][1] : null;
    return {
      stage,
      users,
      conversion_from_previous: prev && prev > 0 ? round(users / prev, 4) : index === 0 ? null : 0,
      conversion_from_start: first > 0 ? round(users / first, 4) : index === 0 ? null : 0
    };
  });
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Stage counts for the events a producer emits, followed by one
 * `unsupported_by_producer` row per declared stage nobody emits (031 T007).
 * The stage list comes from the coverage registry, never from this file.
 */
async function stageRows(
  period: ResolvedPeriod,
  stageEvents: readonly string[],
  note: string
): Promise<StageRow[]> {
  const observed = await query<StageMetric>(
    `select e.event_name as stage, count(*)::int as events, count(distinct e.user_id)::int as users
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.event_name = any($3::text[])
     group by e.event_name order by min(e.occurred_at), e.event_name`,
    [...rangeParams(period), emittedOnly(stageEvents)]
  );
  return [...observed, ...unsupportedRows('stage', stageEvents, note)];
}

export async function getOnboarding(period: ResolvedPeriod): Promise<StageRow[]> {
  return stageRows(
    period,
    ONBOARDING_STAGE_EVENTS,
    'legacy onboarding name without a producer; installation is proven by a later agent_connected'
  );
}

export async function getUpdates(period: ResolvedPeriod): Promise<StageRow[]> {
  return stageRows(
    period,
    UPDATE_STAGE_EVENTS,
    'the Agent performs this stage and has no analytics client; completion is proven by agent_connected with a newer local_app_version'
  );
}

export async function getErrors(period: ResolvedPeriod, limit = 50): Promise<ErrorCluster[]> {
  return query<ErrorCluster>(
    `select
       coalesce(error_code, properties ->> 'error_code', properties ->> 'error_category', 'unknown') as error_code,
       coalesce(error_stage, properties ->> 'error_stage', 'unknown') as error_stage,
       coalesce(error_fingerprint, properties ->> 'error_fingerprint', 'unknown') as error_fingerprint,
       coalesce(tool, 'unknown') as tool,
       coalesce(local_app_version, agent_version, 'unknown') as local_app_version,
       count(*)::int as occurrences,
       count(distinct user_id)::int as users,
       count(*) filter (where properties ->> 'recovered' = 'true')::int as recovered,
       max(occurred_at)::text as last_seen_at
     from public.analytics_events e
     where ${EVENTS_RANGE} and (event_name like '%failed' or event_name = 'error_occurred')
     group by 1,2,3,4,5 order by occurrences desc, last_seen_at desc limit $3`,
    [...rangeParams(period), limit]
  );
}

/**
 * Friction signals computed only from events with a producer. A signal whose
 * evidence nobody emits (`update_not_completed` needs `update_completed`) is
 * returned as `unsupported_by_producer` instead of a misleading count.
 */
export async function getFriction(period: ResolvedPeriod): Promise<FrictionRow[]> {
  const updateObservable = UPDATE_PROMPT_EVENTS.length > 0 && UPDATE_DONE_EVENTS.length > 0;
  const rows = await query<FrictionSignal>(
    `with sessions as (
       select e.user_id, e.session_id,
         bool_or(e.event_name = 'tool_opened') as opened,
         bool_or(e.event_name = any($3::text[])) as added,
         bool_or(e.event_name = any($4::text[])) as started,
         bool_or(e.event_name = any($5::text[])) as completed,
         bool_or(e.event_name = any($6::text[])) as failed,
         count(*) filter (where e.event_name = any($7::text[])) as blocked,
         bool_or(e.event_name = any($8::text[])) as update_prompt,
         bool_or(e.event_name = any($9::text[])) as updated
       from public.analytics_events e where ${EVENTS_RANGE}
       group by e.user_id, e.session_id
     ), signals as (
       select user_id, session_id, unnest(array[
         case when opened and not added then 'opened_without_input' end,
         case when added and not started then 'input_without_start' end,
         case when started and not completed and not failed then 'started_without_outcome' end,
         case when failed and not completed then 'failure_without_recovery' end,
         case when blocked >= 2 then 'repeated_blocked_action' end,
         case when $10::boolean and update_prompt and not updated then 'update_not_completed' end
       ]) as signal from sessions
     )
     select signal, count(distinct user_id)::int as users, count(distinct session_id)::int as sessions
     from signals where signal is not null group by signal order by users desc, sessions desc, signal`,
    [
      ...rangeParams(period),
      [...INPUT_EVENTS],
      START_EVENTS,
      SUCCESS_EVENTS,
      FAILURE_EVENTS,
      BLOCKED_EVENTS,
      UPDATE_PROMPT_EVENTS,
      UPDATE_DONE_EVENTS,
      updateObservable
    ]
  );
  const unsupported: FrictionRow[] = updateObservable
    ? []
    : [
        {
          signal: 'update_not_completed',
          status: UNSUPPORTED_BY_PRODUCER,
          events: notEmitted(['update_prompt_shown', 'agent_update_required', 'update_completed']),
          note: 'update_completed has no producer (the Agent restarts without the browser); use agent_connected with a newer local_app_version'
        }
      ];
  return [...rows, ...unsupported];
}

export async function getFeatures(period: ResolvedPeriod): Promise<FeatureMetric[]> {
  return query<FeatureMetric>(
    `select
       coalesce(e.feature, e.properties ->> 'feature_identifier', 'unknown') as feature,
       count(*) filter (where e.event_name = 'feature_impression')::int as impressions,
       count(*) filter (where e.event_name = any($3::text[]))::int as interactions,
       count(*) filter (where e.event_name = any($4::text[]))::int as successful_operations,
       count(distinct e.user_id)::int as unique_users
     from public.analytics_events e
     where ${EVENTS_RANGE} and (e.feature is not null or e.properties ? 'feature_identifier')
     group by 1 order by unique_users desc, feature`,
    [...rangeParams(period), FEATURE_INTERACTION_EVENTS, SUCCESS_EVENTS]
  );
}

/** Interaction signals `features` declares but cannot count — nothing emits them. */
export function featureUnsupportedSignals(): Array<UnsupportedSignal & { signal: string }> {
  return unsupportedRows(
    'signal',
    FEATURE_INTERACTION_CANDIDATES,
    'declared in the event contract; no call site emits it'
  );
}

const JOURNEY_COLUMNS = `e.event_id::text, e.occurred_at::text, e.created_at::text, e.session_sequence, e.session_id::text,
       e.installation_id::text, e.flow_id::text, e.run_id::text, e.event_name, e.tool,
       e.local_app_version, e.local_app_build, e.web_build_id, e.platform, e.architecture, e.properties`;

type JourneyRow = JourneyEvent & { created_at: string };
/** `inspect` reads the envelope v3 columns beside the journey's; they never reach `events`. */
type InspectRow = JourneyRow & {
  attempt_id: string | null;
  agent_instance_id: string | null;
  agent_platform: string | null;
};

/** FR-055: properties leave the CLI only through the client's own allowlist. */
function sanitizeJourney(rows: JourneyRow[]): JourneyEvent[] {
  return rows.map(({ created_at: _created, ...row }) => ({
    ...row,
    properties: sanitizeEventProperties(row.properties)
  }));
}

/**
 * One person's events, newest first. `period` bounds the read (the CLI passes
 * 30 days by default and `all` for the previous unbounded behaviour); omitted,
 * the read is unbounded.
 */
export async function getJourney(
  email: string,
  limit = 200,
  period?: ResolvedPeriod
): Promise<JourneyEvent[]> {
  const rows = await query<JourneyRow>(
    `select ${JOURNEY_COLUMNS}
     from public.analytics_events e
     join public.analytics_users u on u.id = e.user_id
     where u.email_normalized = lower($3) and ${EVENTS_RANGE}
     order by e.occurred_at desc, e.session_sequence desc nulls last limit $4`,
    [...(period ? rangeParams(period) : [null, FAR_FUTURE]), email, limit]
  );
  return sanitizeJourney(rows);
}

/** Upper bound used when a read is not pinned with `--as-of`. */
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

export async function getRun(runId: string, limit = 500, asOf?: string): Promise<JourneyEvent[]> {
  const rows = await query<JourneyRow>(
    `select ${JOURNEY_COLUMNS}
     from public.analytics_events e
     where e.run_id = $1::uuid and e.created_at <= $3::timestamptz
     order by e.occurred_at, e.session_sequence nulls last limit $2`,
    [runId, limit, asOf ?? FAR_FUTURE]
  );
  return sanitizeJourney(rows);
}

export async function diagnoseFingerprint(
  fingerprint: string,
  limit = 200,
  asOf?: string
): Promise<JourneyEvent[]> {
  const rows = await query<JourneyRow>(
    `select ${JOURNEY_COLUMNS}
     from public.analytics_events e
     where (e.error_fingerprint = $1 or e.properties ->> 'error_fingerprint' = $1)
       and e.created_at <= $3::timestamptz
     order by e.occurred_at desc limit $2`,
    [fingerprint, limit, asOf ?? FAR_FUTURE]
  );
  return sanitizeJourney(rows);
}

/**
 * Cohorts by build or platform. For `local-app-version` the rows with no local
 * app version are the browser-only context (no Agent connected), so that cohort
 * is named `no_agent_context`, never `unknown` (031 T007). Success and failure
 * count only terminal events a producer emits today.
 */
export async function getCohorts(
  period: ResolvedPeriod,
  by: 'local-app-version' | 'platform' | 'web-build'
): Promise<CohortMetric[]> {
  const dimension =
    by === 'platform'
      ? 'e.platform'
      : by === 'web-build'
        ? 'e.web_build_id'
        : 'coalesce(e.local_app_version, e.agent_version)';
  const fallback = by === 'local-app-version' ? NO_AGENT_CONTEXT_COHORT : 'unknown';
  return query<CohortMetric>(
    `select coalesce(${dimension}, $5::text) as cohort,
       count(distinct e.user_id)::int as users, count(*)::int as events,
       count(*) filter (where e.event_name = any($3::text[]))::int as successes,
       count(*) filter (where e.event_name = any($4::text[]))::int as failures
     from public.analytics_events e where ${EVENTS_RANGE}
     group by 1 order by users desc, events desc, cohort`,
    [...rangeParams(period), SUCCESS_EVENTS, FAILURE_EVENTS, fallback]
  );
}

export async function getRetention(period: ResolvedPeriod): Promise<RetentionMetric> {
  const row = await queryOne<RetentionMetric>(
    `select count(*)::int as registered_users,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '1 day'))::int as active_after_1d,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '7 days'))::int as active_after_7d,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '30 days'))::int as active_after_30d
     from public.analytics_users u
     where ($1::timestamptz is null or u.registered_at >= $1::timestamptz) and u.registered_at <= $2::timestamptz`,
    rangeParams(period)
  );
  return (
    row ?? { registered_users: 0, active_after_1d: 0, active_after_7d: 0, active_after_30d: 0 }
  );
}

export async function getTeamWorkspace(period: ResolvedPeriod): Promise<TeamWorkspaceData> {
  const params = rangeParams(period);
  const { attemptId } = eventColumnSql(await getSchema());
  const onboarding = await queryOne<{ attempts: number; successes: number }>(
    `with started as (
       select distinct e.flow_id
       from public.analytics_events e
       where ${EVENTS_RANGE}
         and e.event_name = 'team_onboarding_started'
         and e.flow_id is not null
     ), completed as (
       select e.flow_id,
         bool_or(
           coalesce(e.outcome, e.properties ->> 'outcome') = 'success'
           and e.properties ->> 'invite_persisted' = 'true'
           and e.properties ->> 'root_confirmed' = 'true'
           and e.properties ->> 'sync_queued' = 'true'
           and jsonb_typeof(e.properties -> 'duration_ms') = 'number'
           and (e.properties ->> 'duration_ms')::numeric <= 300000
         ) as succeeded
       from public.analytics_events e
       where ${EVENTS_RANGE}
         and e.event_name = 'team_onboarding_completed'
         and e.flow_id is not null
       group by e.flow_id
     )
     select count(*)::int as attempts,
       count(*) filter (where completed.succeeded)::int as successes
     from started left join completed using (flow_id)`,
    params
  );

  const findRows = await query<{
    cue: TeamFindCueMetric['cue'];
    attempts: number;
    successes: number;
  }>(
    `with started as (
       select distinct
         e.properties ->> 'study_run_id' as study_run_id,
         ${attemptId} as attempt_id,
         e.properties ->> 'cue_category' as cue
       from public.analytics_events e
       where ${EVENTS_RANGE}
         and e.event_name = 'team_find_started'
         and e.properties ->> 'study_run_id' is not null
         and ${attemptId} is not null
         and e.properties ->> 'cue_category' in ('geo','offer','language','category')
     ), completed as (
       select e.properties ->> 'study_run_id' as study_run_id,
         ${attemptId} as attempt_id,
         bool_or(
           coalesce(e.outcome, e.properties ->> 'outcome') = 'success'
           and e.properties ->> 'assisted' = 'false'
           and jsonb_typeof(e.properties -> 'duration_ms') = 'number'
           and (e.properties ->> 'duration_ms')::numeric <= 30000
         ) as succeeded
       from public.analytics_events e
       where ${EVENTS_RANGE}
         and e.event_name = 'team_find_completed'
         and e.properties ->> 'study_run_id' is not null
         and ${attemptId} is not null
       group by 1, 2
     )
     select started.cue,
       count(*)::int as attempts,
       count(*) filter (where completed.succeeded)::int as successes
     from started
     left join completed using (study_run_id, attempt_id)
     group by started.cue
     order by started.cue`,
    params
  );

  const windowRows = await query<{
    window_index: number;
    denominator: number;
    numerator: number;
  }>(
    `with roots as (
       select distinct workspace_key, root_connected_at, root_state,
         pilot_enrolled_at, pilot_exited_at
       from public.analytics_team_workspace
       where root_state <> 'detached'
         and root_connected_at <= $2::timestamptz
         and ($1::timestamptz is null or root_connected_at >= $1::timestamptz)
     ), windows as (
       select roots.workspace_key, series.window_index,
         roots.root_connected_at + (series.window_index - 1) * interval '7 days' as window_start,
         roots.root_connected_at + series.window_index * interval '7 days' as window_end
       from roots
       cross join generate_series(1, 4) as series(window_index)
       where roots.pilot_enrolled_at <=
         roots.root_connected_at + (series.window_index - 1) * interval '7 days'
         and (roots.pilot_exited_at is null or roots.pilot_exited_at >
           roots.root_connected_at + (series.window_index - 1) * interval '7 days')
     ), signals as (
       select windows.workspace_key, windows.window_index,
         count(distinct member.member_user_id) filter (
           where member.member_joined_at <= windows.window_start
             and (member.member_removed_at is null or member.member_removed_at > windows.window_start)
         ) as active_members,
         bool_or(
           event.event_name = 'team_workspace_session'
           and event.properties ->> 'workspace_session' = 'true'
         ) as has_workspace_session,
         bool_or(
           event.event_name in ('team_find_completed','team_preview_completed')
           and coalesce(event.outcome, event.properties ->> 'outcome') = 'success'
         ) as has_discovery,
         bool_or(
           event.event_name in ('team_file_attempt_completed','team_workflow_completed')
           and coalesce(event.outcome, event.properties ->> 'outcome') = 'success'
         ) as has_production
       from windows
       join public.analytics_team_workspace member
         on member.workspace_key = windows.workspace_key
       left join public.analytics_events event
         on event.user_id = member.member_user_id
        and event.occurred_at >= windows.window_start
        and event.occurred_at < windows.window_end
       group by windows.workspace_key, windows.window_index
     ), eligible as (
       select * from signals
       where active_members >= 2 and has_workspace_session
     )
     select series.window_index::int,
       count(eligible.workspace_key)::int as denominator,
       count(eligible.workspace_key) filter (
         where eligible.has_discovery and eligible.has_production
       )::int as numerator
     from generate_series(1, 4) as series(window_index)
     left join eligible on eligible.window_index = series.window_index
     group by series.window_index
     order by series.window_index`,
    params
  );

  const onboardingAttempts = onboarding?.attempts ?? 0;
  const onboardingSuccesses = onboarding?.successes ?? 0;
  const findAttempts = findRows.reduce((total, row) => total + row.attempts, 0);
  const findSuccesses = findRows.reduce((total, row) => total + row.successes, 0);
  const balancedCues = findRows.length === 4 && findRows.every(row => row.attempts === 5);
  const windows = windowRows.map(row => activationWindow(row));
  // 011: the storage lifecycle, read straight from the four events the
  // explorer fires. Counts of events, not of spaces — a space that reconnects
  // twice counts twice, which is the honest number for "how often".
  const storageCounts = await queryOne<{
    storage_connected: number;
    index_completed: number;
    previews_ready: number;
    attention: number;
  }>(
    `select
       count(*) filter (where e.event_name = 'team_storage_connected')::int as storage_connected,
       count(*) filter (where e.event_name = 'team_index_completed')::int as index_completed,
       count(*) filter (where e.event_name = 'team_previews_ready')::int as previews_ready,
       count(*) filter (where e.event_name = 'team_storage_attention')::int as attention
     from public.analytics_events e
     where ${EVENTS_RANGE}
       and e.event_name in (
         'team_storage_connected', 'team_index_completed',
         'team_previews_ready', 'team_storage_attention'
       )`,
    params
  );
  const attentionReasons = await query<{ reason: string; count: number }>(
    `select coalesce(e.properties ->> 'attention_reason', 'unknown') as reason,
       count(*)::int as count
     from public.analytics_events e
     where ${EVENTS_RANGE}
       and e.event_name = 'team_storage_attention'
     group by 1
     order by count desc, reason asc`,
    params
  );

  return {
    storage: {
      storage_connected: storageCounts?.storage_connected ?? 0,
      index_completed: storageCounts?.index_completed ?? 0,
      previews_ready: storageCounts?.previews_ready ?? 0,
      attention: storageCounts?.attention ?? 0,
      attention_reasons: attentionReasons
    },
    sc001: {
      attempts: onboardingAttempts,
      successes: onboardingSuccesses,
      success_rate: rate(onboardingSuccesses, onboardingAttempts),
      status: fixedCohortStatus(onboardingAttempts, onboardingSuccesses, true)
    },
    sc005: {
      attempts: findAttempts,
      successes: findSuccesses,
      success_rate: rate(findSuccesses, findAttempts),
      status: fixedCohortStatus(findAttempts, findSuccesses, balancedCues),
      cues: findRows
    },
    sc009: {
      windows,
      all_windows_pass: windows.some(window => window.status === 'fail')
        ? false
        : windows.some(window => window.status === 'insufficient')
          ? null
          : true
    }
  };
}

function fixedCohortStatus(attempts: number, successes: number, validShape: boolean) {
  if (attempts < 20) return 'insufficient' as const;
  return attempts === 20 && successes >= 18 && validShape ? ('pass' as const) : ('fail' as const);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

function activationWindow(row: {
  window_index: number;
  denominator: number;
  numerator: number;
}): TeamActivationWindow {
  const denominator = row.denominator ?? 0;
  const numerator = row.numerator ?? 0;
  const ratio = rate(numerator, denominator);
  return {
    window_index: row.window_index as TeamActivationWindow['window_index'],
    denominator,
    numerator,
    rate: ratio,
    status: ratio === null ? 'insufficient' : ratio >= 0.7 ? 'pass' : 'fail'
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYNC_COLUMNS = `job_id::text, connection_id::text, connection_state, job_kind, phase, state,
  scope_hash, requested_by::text, request_id::text, request_outcome,
  created_at::text, updated_at::text, completed_at::text, scan_completed_at::text,
  last_progress_at::text, lease_expires_at::text, lease_epoch, run_count, attempts, lease_lost_count,
  no_progress_runs, next_attempt_at::text, replay_after, confirmed_sequence, confirmed_at::text,
  recovery_count, last_recovery_at::text, canonical_job_id::text, canonical_state,
  canonical_error_code, canonical_next_attempt_at::text, last_error_code, error_detail,
  cancel_requested_at::text, files_listed, files_added, files_updated, files_removed,
  items_unavailable, folders_done`;

/**
 * 028 — every sync job of one space, newest first, grouped by connection with
 * the connection's canonical feed job beside them. `teamOrEmail` is a team id
 * or the owner's email; the owner's email itself is never returned.
 */
export async function getSyncJobs(teamOrEmail: string, limit = 50): Promise<SyncData | null> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const byTeam = UUID.test(teamOrEmail);
  const rows = await query<SyncJobRow & { team_id: string }>(
    `select team_id::text, ${SYNC_COLUMNS}
     from public.analytics_catalog_sync_jobs
     where ${byTeam ? 'team_id = $1::uuid' : 'owner_email_normalized = lower($1)'}
     order by updated_at desc, created_at desc
     limit $2`,
    [teamOrEmail, bounded]
  );
  if (rows.length === 0) return null;
  const connections = new Map<string, SyncConnection>();
  let teamId = '';
  for (const { team_id, ...row } of rows) {
    teamId = team_id;
    let connection = connections.get(row.connection_id);
    if (!connection) {
      connection = {
        connection_id: row.connection_id,
        connection_state: row.connection_state,
        canonical: row.canonical_job_id
          ? {
              job_id: row.canonical_job_id,
              state: row.canonical_state ?? 'unknown',
              error_code: row.canonical_error_code,
              next_attempt_at: row.canonical_next_attempt_at,
              confirmed_sequence: row.confirmed_sequence,
              recovery_count: row.recovery_count
            }
          : null,
        jobs: []
      };
      connections.set(row.connection_id, connection);
    }
    connection.jobs.push(row);
  }
  return { team_id: teamId, connections: [...connections.values()] };
}

/* ---------------------------------------------------------------------------
 * 032 — `connection`: did the link to the Agent drop, did it come back, and
 * why did a check fail. Aggregates only; the one list it returns is of web
 * build ids, so a build that emits no link event at all is named as
 * uncovered rather than silently counted as healthy.
 * ------------------------------------------------------------------------- */

export async function getConnection(period: ResolvedPeriod): Promise<ConnectionData> {
  const params = rangeParams(period);
  const totals = await queryOne<{
    users_with_loss: number;
    losses: number;
    recoveries: number;
    samples: number;
    p50: number | null;
    p95: number | null;
    mode_auto: number;
    mode_manual: number;
    mode_local_copy: number;
    inconsistency_events: number;
    inconsistency_users: number;
  }>(
    `select
       count(distinct e.user_id) filter (where e.event_name = 'link_lost')::int as users_with_loss,
       count(*) filter (where e.event_name = 'link_lost')::int as losses,
       count(*) filter (where e.event_name = 'link_recovered')::int as recoveries,
       count(*) filter (
         where e.event_name = 'link_recovered'
           and jsonb_typeof(e.properties -> 'duration_ms') = 'number'
       )::int as samples,
       percentile_cont(0.5) within group (order by (e.properties ->> 'duration_ms')::numeric)
         filter (
           where e.event_name = 'link_recovered'
             and jsonb_typeof(e.properties -> 'duration_ms') = 'number'
         ) as p50,
       percentile_cont(0.95) within group (order by (e.properties ->> 'duration_ms')::numeric)
         filter (
           where e.event_name = 'link_recovered'
             and jsonb_typeof(e.properties -> 'duration_ms') = 'number'
         ) as p95,
       count(*) filter (
         where e.event_name = 'link_recovered' and e.properties ->> 'recovery_mode' = 'auto'
       )::int as mode_auto,
       count(*) filter (
         where e.event_name = 'link_recovered' and e.properties ->> 'recovery_mode' = 'manual'
       )::int as mode_manual,
       count(*) filter (
         where e.event_name = 'link_recovered' and e.properties ->> 'recovery_mode' = 'local_copy'
       )::int as mode_local_copy,
       count(*) filter (where e.event_name = 'link_inconsistency')::int as inconsistency_events,
       count(distinct e.user_id) filter (where e.event_name = 'link_inconsistency')::int as inconsistency_users
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.event_name in (${LINK_EVENT_LIST})`,
    params
  );

  const failedChecks = await query<ConnectionReasonRow>(
    `select coalesce(e.properties ->> 'link_reason', 'unknown') as reason,
       count(*)::int as events,
       count(distinct e.user_id)::int as users
     from public.analytics_events e
     where ${EVENTS_RANGE}
       and e.event_name = 'link_check_completed'
       and coalesce(e.outcome, e.properties ->> 'outcome') in ('failure', 'blocked')
     group by 1
     order by events desc, users desc, reason asc`,
    params
  );

  const blockedByBrowser = await query<ConnectionBrowserRow>(
    `select coalesce(e.properties ->> 'browser_family', 'unknown') as browser_family,
       count(distinct e.user_id)::int as users
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.event_name = 'blocked_by_browser_detected'
     group by 1
     order by users desc, browser_family asc`,
    params
  );

  const origins = await query<ConnectionOriginRow>(
    `select e.properties ->> 'link_origin' as link_origin,
       count(distinct e.user_id)::int as users,
       count(*)::int as events
     from public.analytics_events e
     where ${EVENTS_RANGE}
       and e.event_name in (${LINK_EVENT_LIST})
       and e.properties ->> 'link_origin' is not null
     group by 1
     order by users desc, events desc, link_origin asc`,
    params
  );

  const builds = await query<{ web_build_id: string; covered: boolean }>(
    `select e.web_build_id,
       bool_or(e.event_name in (${LINK_EVENT_LIST})) as covered
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.web_build_id is not null
     group by e.web_build_id
     order by e.web_build_id asc`,
    params
  );

  const toMs = (value: number | null | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

  return {
    users_with_loss: totals?.users_with_loss ?? 0,
    losses: totals?.losses ?? 0,
    recoveries: totals?.recoveries ?? 0,
    recovery_ms: {
      p50: toMs(totals?.p50),
      p95: toMs(totals?.p95),
      samples: totals?.samples ?? 0
    },
    recovery_mode: {
      auto: totals?.mode_auto ?? 0,
      manual: totals?.mode_manual ?? 0,
      local_copy: totals?.mode_local_copy ?? 0
    },
    failed_checks_by_reason: failedChecks,
    blocked_by_browser: blockedByBrowser,
    origins,
    inconsistencies: {
      events: totals?.inconsistency_events ?? 0,
      users: totals?.inconsistency_users ?? 0
    },
    coverage: {
      web_builds_with_link_events: builds.filter(build => build.covered).length,
      web_builds_without: builds.filter(build => !build.covered).map(build => build.web_build_id),
      note: CONNECTION_COVERAGE_NOTE
    }
  };
}

/* ---------------------------------------------------------------------------
 * 031 FR-056 — `audit`: the coverage registry against what the period holds.
 * Every number is an aggregate; the only lists returned are event names,
 * capability ids and web build ids.
 * ------------------------------------------------------------------------- */

type SignalRole = 'start' | 'terminal' | 'readiness' | 'error';

interface RegistryTuple {
  capability: string;
  event: string;
  role: SignalRole;
  correlate: string;
  tool: string | null;
}

function registryTuples(): RegistryTuple[] {
  const tuples: RegistryTuple[] = [];
  for (const capability of COVERAGE_REGISTRY) {
    const push = (signal: CapabilitySignal, role: SignalRole) =>
      tuples.push({
        capability: capability.id,
        event: signal.event,
        role,
        correlate: signal.correlate,
        tool: capability.toolColumn ?? null
      });
    capability.start.forEach(signal => push(signal, 'start'));
    capability.terminal.forEach(signal => push(signal, 'terminal'));
    if (capability.readiness) push(capability.readiness, 'readiness');
    if (capability.error) push(capability.error, 'error');
  }
  return tuples;
}

/** `$1/$2` range, `$3..$7` the registry as parallel arrays; `attemptId` from `eventColumnSql`. */
const auditEventsCte = (attemptId: string) => `with reg as (
       select * from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
         as r(capability, event_name, role, correlate, tool)
     ), ev as (
       select r.capability, r.role, r.event_name, e.user_id,
         case r.correlate
           when 'run_id' then coalesce(e.run_id::text, e.properties ->> 'run_id')
           when 'flow_id' then coalesce(e.flow_id::text, e.properties ->> 'flow_id')
           when 'attempt_id' then ${attemptId}
           when 'workflow_id' then e.properties ->> 'workflow_id'
           else null
         end as cid
       from public.analytics_events e
       join reg r on r.event_name = e.event_name and (r.tool is null or e.tool = r.tool)
       where ${EVENTS_RANGE}
     )`;

export async function getAudit(period: ResolvedPeriod): Promise<AuditData> {
  const schema = await getSchema();
  const AUDIT_EVENTS_CTE = auditEventsCte(eventColumnSql(schema).attemptId);
  const tuples = registryTuples();
  const params = [
    ...rangeParams(period),
    tuples.map(t => t.capability),
    tuples.map(t => t.event),
    tuples.map(t => t.role),
    tuples.map(t => t.correlate),
    tuples.map(t => t.tool)
  ];

  const observed = await query<{
    capability: string;
    role: SignalRole;
    event_name: string;
    events: number;
    users: number;
    correlated: number;
  }>(
    `${AUDIT_EVENTS_CTE}
     select capability, role, event_name, count(*)::int as events,
       count(distinct user_id)::int as users, count(cid)::int as correlated
     from ev group by 1, 2, 3 order by 1, 2, 3`,
    params
  );

  const pairs = await query<{
    capability: string;
    orphan_starts: number;
    correlated_pairs: number;
  }>(
    `${AUDIT_EVENTS_CTE}, starts as (
       select distinct capability, cid from ev where role = 'start' and cid is not null
     ), terms as (
       select distinct capability, cid from ev where role = 'terminal' and cid is not null
     )
     select s.capability,
       count(*) filter (where t.cid is null)::int as orphan_starts,
       count(*) filter (where t.cid is not null)::int as correlated_pairs
     from starts s left join terms t on t.capability = s.capability and t.cid = s.cid
     group by 1 order by 1`,
    params
  );

  // The sync view is the authoritative source for one capability; a role that cannot see it
  // counts nothing there, and `schema` says so.
  const syncJobs = schema.tables.analytics_catalog_sync_jobs
    ? await queryOne<{ jobs: number }>(
        `select count(*)::int as jobs
         from public.analytics_catalog_sync_jobs j
         where ($1::timestamptz is null or j.created_at >= $1::timestamptz)
           and j.created_at <= $2::timestamptz`,
        rangeParams(period)
      )
    : null;

  const unknownCodes = await query<AuditUnknownCode>(
    `select coalesce(e.tool, 'unknown') as tool,
       count(*) filter (
         where coalesce(e.error_code, e.properties ->> 'error_code', 'unknown') = 'unknown'
       )::int as unknown_code,
       count(*) filter (
         where coalesce(e.error_stage, e.properties ->> 'error_stage', 'unknown') = 'unknown'
       )::int as unknown_stage,
       count(*)::int as errors
     from public.analytics_events e
     where ${EVENTS_RANGE} and (e.event_name like '%failed' or e.event_name = 'error_occurred')
     group by 1 order by 1`,
    rangeParams(period)
  );

  const deliveryTotals = await queryOne<{
    reports: number;
    rejected: number;
    evicted: number;
    expired: number;
  }>(
    `select count(*)::int as reports,
       coalesce(sum(case when jsonb_typeof(e.properties -> 'rejected_count') = 'number'
         then (e.properties ->> 'rejected_count')::numeric else 0 end), 0)::int as rejected,
       coalesce(sum(case when jsonb_typeof(e.properties -> 'evicted_count') = 'number'
         then (e.properties ->> 'evicted_count')::numeric else 0 end), 0)::int as evicted,
       coalesce(sum(case when jsonb_typeof(e.properties -> 'expired_count') = 'number'
         then (e.properties ->> 'expired_count')::numeric else 0 end), 0)::int as expired
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.event_name = 'analytics_delivery_report'`,
    rangeParams(period)
  );

  const deliveryByEvent = await query<{
    event_name: string;
    rejected_reports: number;
    evicted_reports: number;
  }>(
    `with reports as (
       select e.properties from public.analytics_events e
       where ${EVENTS_RANGE} and e.event_name = 'analytics_delivery_report'
     ), names as (
       select trim(n) as event_name, 'rejected' as kind
       from reports, unnest(string_to_array(coalesce(properties ->> 'rejected_events', ''), ',')) as n
       union all
       select trim(n), 'evicted'
       from reports, unnest(string_to_array(coalesce(properties ->> 'evicted_events', ''), ',')) as n
     )
     select event_name,
       count(*) filter (where kind = 'rejected')::int as rejected_reports,
       count(*) filter (where kind = 'evicted')::int as evicted_reports
     from names where event_name <> '' group by 1 order by 1`,
    rangeParams(period)
  );

  const builds = await query<{ web_build_id: string; covered: boolean }>(
    `select e.web_build_id,
       bool_or(e.event_name in (${LINK_EVENT_LIST})) as covered
     from public.analytics_events e
     where ${EVENTS_RANGE} and e.web_build_id is not null
     group by e.web_build_id
     order by e.web_build_id asc`,
    rangeParams(period)
  );

  const deliveryLag = await getDeliveryLag(period);

  const observedBy = new Map<string, typeof observed>();
  for (const row of observed) {
    const list = observedBy.get(row.capability) ?? [];
    list.push(row);
    observedBy.set(row.capability, list);
  }
  const pairsBy = new Map(pairs.map(row => [row.capability, row]));

  const eventStatuses = registryEventStatuses();
  const capabilities = COVERAGE_REGISTRY.map(capability =>
    auditCapability(
      capability,
      eventStatuses,
      observedBy.get(capability.id) ?? [],
      pairsBy.get(capability.id),
      syncJobs ? syncJobs.jobs : null
    )
  );

  const delivery: AuditDelivery = {
    reports: deliveryTotals?.reports ?? 0,
    rejected: deliveryTotals?.rejected ?? 0,
    evicted: deliveryTotals?.evicted ?? 0,
    expired: deliveryTotals?.expired ?? 0,
    by_event: deliveryByEvent,
    note:
      (deliveryTotals?.reports ?? 0) === 0
        ? 'no analytics_delivery_report in the period: losses are unknown, not zero'
        : 'sums of the client-side counters carried by analytics_delivery_report'
  };
  const uncoveredBuilds = builds.filter(build => !build.covered).map(build => build.web_build_id);

  const summary: Record<AuditStatus, number> = {
    covered: 0,
    partial: 0,
    uncovered: 0,
    declared_but_never_emitted: 0
  };
  for (const capability of capabilities) summary[capability.status] += 1;

  return {
    registry_size: COVERAGE_REGISTRY.length,
    capabilities,
    unknown_codes: unknownCodes,
    delivery,
    uncovered_builds: uncoveredBuilds,
    delivery_lag_ms: deliveryLag,
    findings: auditFindings(capabilities, unknownCodes, delivery, uncoveredBuilds),
    summary,
    schema: { ...schemaSummary(schema), ...schemaNote(schema) }
  };
}

/** A sentence for `audit` and `inspect` when this database lacks a column or table the CLI reads. */
function schemaNote(schema: AnalyticsSchema): { note?: string } {
  const missing = missingObjects(schema);
  return missing.length === 0
    ? {}
    : {
        note: `This database lacks ${missing.join(', ')} (migrations not applied, or not visible to this role); values from them read as empty, not as zero.`
      };
}

function auditCapability(
  capability: Capability,
  eventStatuses: Map<string, ProducerStatus>,
  observed: Array<{
    role: SignalRole;
    event_name: string;
    events: number;
    users: number;
    correlated: number;
  }>,
  pairs: { orphan_starts: number; correlated_pairs: number } | undefined,
  /** Jobs in the sync view, or null when this connection cannot see the view. */
  syncJobs: number | null
): AuditCapability {
  const base = {
    id: capability.id,
    tool: capability.tool,
    producer_status: capability.producerStatus,
    source: capability.source,
    observed: observed.map(row => ({
      event: row.event_name,
      role: row.role,
      events: row.events,
      users: row.users,
      correlated: row.correlated
    })),
    orphan_starts: pairs?.orphan_starts ?? 0,
    correlated_pairs: pairs?.correlated_pairs ?? 0,
    unobservable: capability.unobservable,
    ...(capability.note ? { note: capability.note } : {})
  };

  if (capability.source === 'authoritative_table') {
    // An authoritative source this role cannot read is not coverage; `schema` names it.
    return syncJobs === null
      ? { ...base, status: 'uncovered', missing: ['analytics_catalog_sync_jobs'], samples: 0 }
      : { ...base, status: 'covered', missing: [], samples: syncJobs };
  }

  const status = (signal: CapabilitySignal): ProducerStatus => signalStatus(capability, signal);
  // An event is "declared but never emitted" when no capability at all has a
  // producer for it and a metric still computes from it; `error_occurred`
  // pending for one tool but emitted by another is not that.
  const declared = capabilitySignals(capability)
    .filter(
      signal =>
        status(signal) !== 'emitted' &&
        eventStatuses.get(signal.event) !== 'emitted' &&
        QUERY_EVENT_NAMES.includes(signal.event)
    )
    .map(signal => signal.event);
  const samples = observed
    .filter(row => row.role === 'start')
    .reduce((total, row) => total + row.events, 0);

  if (declared.length > 0) {
    return {
      ...base,
      status: 'declared_but_never_emitted',
      missing: [...new Set(declared)].sort(),
      samples
    };
  }

  const startExpected = capability.start.some(signal => status(signal) === 'emitted');
  const terminalExpected = capability.terminal.some(signal => status(signal) === 'emitted');
  const readinessExpected =
    capability.readiness !== undefined && status(capability.readiness) === 'emitted';

  const observedRoles = new Set(observed.map(row => row.role));
  const totalObserved = observed.reduce((total, row) => total + row.events, 0);

  if (totalObserved === 0) {
    const missing = [
      ...(startExpected ? ['start'] : []),
      ...(terminalExpected ? ['terminal'] : []),
      ...(readinessExpected ? ['readiness'] : [])
    ];
    return { ...base, status: 'uncovered', missing, samples: 0 };
  }

  const missing: string[] = [];
  if (startExpected && !observedRoles.has('start')) missing.push('start');
  if (!observedRoles.has('terminal')) missing.push('terminal');
  if (readinessExpected && !observedRoles.has('readiness')) missing.push('readiness');

  const correlates = capability.start.some(signal => signal.correlate !== 'none');
  if (correlates) {
    const startCorrelated = observed.some(row => row.role === 'start' && row.correlated > 0);
    const terminalCorrelated = observed.some(row => row.role === 'terminal' && row.correlated > 0);
    if (observedRoles.has('start') && !startCorrelated) missing.push('start_correlation');
    if (observedRoles.has('terminal') && !terminalCorrelated) missing.push('terminal_correlation');
    if (
      startCorrelated &&
      terminalCorrelated &&
      (pairs?.correlated_pairs ?? 0) === 0 &&
      !sameEventStartAndTerminal(capability)
    ) {
      missing.push('correlated_pair');
    }
  }

  return { ...base, status: missing.length ? 'partial' : 'covered', missing, samples };
}

function sameEventStartAndTerminal(capability: Capability): boolean {
  return (
    capability.start.length > 0 &&
    capability.start.every(start => capability.terminal.some(t => t.event === start.event))
  );
}

/** sha256 of `${capability}|${status}|${missing.sort().join(',')}` — the same finding gets the same id on every run. */
export function findingId(capability: string, status: string, missing: readonly string[]): string {
  return createHash('sha256')
    .update(`${capability}|${status}|${[...missing].sort().join(',')}`)
    .digest('hex');
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

function auditFindings(
  capabilities: AuditCapability[],
  unknownCodes: AuditUnknownCode[],
  delivery: AuditDelivery,
  uncoveredBuilds: string[]
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const add = (
    capability: string,
    status: AuditFinding['status'],
    severity: FindingSeverity,
    missing: string[],
    evidence: string[]
  ) => {
    findings.push({
      id: findingId(capability, status, missing),
      capability,
      status,
      severity,
      missing: [...missing].sort(),
      evidence
    });
  };

  for (const capability of capabilities) {
    const evidence = capability.observed.map(
      row =>
        `${row.role} ${row.event}: ${row.events} events, ${row.users} users, ${row.correlated} with id`
    );
    if (capability.status === 'declared_but_never_emitted') {
      add(capability.id, capability.status, 'high', capability.missing, [
        ...evidence,
        'a CLI metric computes from an event with no producer'
      ]);
    } else if (capability.status === 'uncovered') {
      add(
        capability.id,
        capability.status,
        capability.producer_status === 'emitted' ? 'medium' : 'info',
        capability.missing,
        [
          ...evidence,
          capability.producer_status === 'emitted'
            ? 'a producer exists but nothing arrived in the period'
            : `producer status: ${capability.producer_status}`
        ]
      );
    } else if (capability.status === 'partial') {
      add(
        capability.id,
        capability.status,
        capability.missing.includes('terminal') ? 'medium' : 'low',
        capability.missing,
        evidence
      );
    }
    if (capability.orphan_starts > 0) {
      add(
        capability.id,
        'orphan_starts',
        capability.orphan_starts > capability.correlated_pairs ? 'medium' : 'low',
        [],
        [
          `${capability.orphan_starts} start id(s) without a terminal in the period`,
          `${capability.correlated_pairs} start id(s) met a terminal`
        ]
      );
    }
  }

  for (const row of unknownCodes) {
    const missing = [
      ...(row.unknown_code > 0 ? ['error_code'] : []),
      ...(row.unknown_stage > 0 ? ['error_stage'] : [])
    ];
    if (missing.length === 0) continue;
    add(row.tool, 'unknown_codes', 'medium', missing, [
      `${row.errors} error rows; ${row.unknown_code} without a code, ${row.unknown_stage} without a stage`
    ]);
  }

  if (uncoveredBuilds.length > 0) {
    add('link', 'uncovered_builds', 'low', uncoveredBuilds, [
      'web builds seen in the period that emitted no link event (predate 032 or lost analytics)'
    ]);
  }

  const lost = [
    ...(delivery.rejected > 0 ? ['rejected'] : []),
    ...(delivery.evicted > 0 ? ['evicted'] : []),
    ...(delivery.expired > 0 ? ['expired'] : [])
  ];
  if (lost.length > 0) {
    add('analytics.delivery', 'delivery_losses', delivery.rejected > 0 ? 'high' : 'medium', lost, [
      `rejected ${delivery.rejected}, evicted ${delivery.evicted}, expired ${delivery.expired} across ${delivery.reports} report(s)`
    ]);
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.capability.localeCompare(b.capability) ||
      a.id.localeCompare(b.id)
  );
}

/* ---------------------------------------------------------------------------
 * 031 FR-056 — `inspect <id>`: every event of one attempt, oldest first, with
 * the stages the registry expected for it.
 *
 * `attempt_id` is read as `coalesce(e.attempt_id, e.properties ->> 'attempt_id')`:
 * envelope v3 (migration 20261117110000) moves it into its own column on ingest,
 * and rows written before it keep it inside `properties`. On a database without the
 * v3 columns (`schema.ts`) it is read from `properties` alone and `data.schema` says so. The audit CTE and the
 * SC-005 find study read it the same way. `workflow_id` stays a property.
 * ------------------------------------------------------------------------- */

const OPAQUE_ID = /^[a-z0-9][a-z0-9_-]{0,95}$/i;

export async function getInspect(id: string, asOf?: string, limit = 500): Promise<InspectData> {
  if (!OPAQUE_ID.test(id)) return { found: false, id };
  // The uuid columns need a uuid-typed parameter; a non-uuid id binds null there
  // and can only match the opaque ids kept in `properties`.
  const asUuid = UUID.test(id) ? id : null;
  const schema = await getSchema();
  const columns = eventColumnSql(schema);
  const missing = missingObjects(schema).filter(name => name.startsWith('analytics_events.'));
  const schemaPart =
    missing.length > 0
      ? {
          schema: {
            missing,
            note: 'This database lacks these envelope v3 columns: attempt_id is read from properties only, and the Agent run and platform are unknown, not absent.'
          }
        }
      : {};
  const rows = await query<InspectRow>(
    `select ${JOURNEY_COLUMNS},
       ${columns.attemptId} as attempt_id,
       ${columns.agentInstanceId} as agent_instance_id, ${columns.agentPlatform} as agent_platform
     from public.analytics_events e
     where (
         e.run_id = $3::uuid
         or e.flow_id = $3::uuid
         or e.properties ->> 'run_id' = $1::text
         or e.properties ->> 'flow_id' = $1::text
         or ${columns.attemptId} = $1::text
         or e.properties ->> 'workflow_id' = $1::text
       )
       and e.created_at <= $4::timestamptz
     order by e.occurred_at asc, e.session_sequence asc nulls last, e.created_at asc
     limit $2`,
    [id, limit, asUuid, asOf ?? FAR_FUTURE]
  );
  if (rows.length === 0) return { found: false, id, ...schemaPart };

  const matchedBy = new Set<InspectFound['matched_by'][number]>();
  for (const row of rows) {
    if (row.run_id === id) matchedBy.add('run_id');
    if (row.flow_id === id) matchedBy.add('flow_id');
    const props = row.properties ?? {};
    if (row.attempt_id === id) matchedBy.add('attempt_id');
    if (props.workflow_id === id) matchedBy.add('workflow_id');
    if (props.run_id === id || props.flow_id === id) matchedBy.add('properties');
  }

  const capability = inferCapability(rows);
  const events = sanitizeJourney(
    rows.map(
      ({ attempt_id: _attempt, agent_instance_id: _instance, agent_platform: _platform, ...row }) =>
        row
    )
  );
  const stageOf = new Map<string, string>();
  if (capability) {
    for (const stage of capability.stages) {
      for (const event of capability.stageEvents[stage] ?? []) {
        if (!stageOf.has(event)) stageOf.set(event, stage as string);
      }
    }
  }
  const observedStages = capability
    ? capability.stages.filter(stage => rows.some(row => stageOf.get(row.event_name) === stage))
    : [];
  const expected = capability
    ? capability.stages.filter(stage => (capability.stageEvents[stage] ?? []).length > 0)
    : [];
  const terminalEvents = new Set<string>(capability?.terminal.map(signal => signal.event) ?? []);
  const terminalRow = [...rows].reverse().find(row => terminalEvents.has(row.event_name)) ?? null;

  // Build numbers arrive as text from Postgres; `String()` keeps them text if a
  // driver ever coerces them, so the JSON shape never flips type.
  const distinct = (pick: (row: InspectRow) => string | null) =>
    [
      ...new Set(
        rows
          .map(pick)
          .filter((value): value is string => value !== null && value !== undefined)
          .map(value => String(value))
      )
    ].sort();

  return {
    found: true,
    id,
    matched_by: [...matchedBy].sort(),
    capability: capability?.id ?? null,
    tool: capability?.toolColumn ?? rows.find(row => row.tool)?.tool ?? null,
    stages: {
      expected,
      observed: observedStages,
      missing: expected.filter(stage => !observedStages.includes(stage))
    },
    terminal: terminalRow
      ? {
          event: terminalRow.event_name,
          outcome: outcomeOf(terminalRow),
          occurred_at: isoUtc(terminalRow.occurred_at) ?? terminalRow.occurred_at
        }
      : null,
    last_proven_stage: observedStages.length ? observedStages[observedStages.length - 1] : null,
    first_seen_at: isoUtc(rows[0]?.occurred_at),
    last_seen_at: isoUtc(rows[rows.length - 1]?.occurred_at),
    delivery_lag_ms: deliveryLagOf(rows),
    agent: {
      local_app_versions: distinct(row => row.local_app_version),
      local_app_builds: distinct(row => row.local_app_build),
      web_build_ids: distinct(row => row.web_build_id),
      platforms: distinct(row => row.platform),
      architectures: distinct(row => row.architecture),
      // The Agent run that saw the attempt last: a restart mid-attempt shows as a change here.
      agent_instance_id:
        [...rows].reverse().find(row => row.agent_instance_id)?.agent_instance_id ?? null,
      agent_instance_ids: distinct(row => row.agent_instance_id),
      agent_platforms: distinct(row => row.agent_platform),
      note: INSPECT_AGENT_NOTE
    },
    events,
    ...schemaPart
  };
}

/** The registry capability whose start/terminal events (and tool) the rows match best. */
function inferCapability(rows: JourneyRow[]): Capability | null {
  let best: { capability: Capability; score: number } | null = null;
  for (const capability of COVERAGE_REGISTRY) {
    if (capability.source !== 'events') continue;
    const signals = new Set<string>(
      [...capability.start, ...capability.terminal].map(signal => signal.event)
    );
    const matching = rows.filter(
      row =>
        signals.has(row.event_name) &&
        (!capability.toolColumn || row.tool === null || row.tool === capability.toolColumn)
    );
    if (matching.length === 0) continue;
    // Prefer a tool-specific capability when the rows carry that tool.
    const toolBonus =
      capability.toolColumn && matching.some(row => row.tool === capability.toolColumn) ? 1 : 0;
    const score = matching.length * 2 + toolBonus;
    if (!best || score > best.score) best = { capability, score };
  }
  return best?.capability ?? null;
}

/** Postgres renders `timestamptz::text` in the session zone; the envelope speaks UTC ISO-8601. */
export function isoUtc(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

function outcomeOf(row: JourneyRow): string {
  const props = row.properties ?? {};
  if (typeof props.outcome === 'string') return props.outcome;
  if (row.event_name.endsWith('_completed')) return 'success';
  if (row.event_name.endsWith('_failed')) return 'failure';
  if (row.event_name.endsWith('_cancelled')) return 'cancelled';
  return 'unknown';
}
