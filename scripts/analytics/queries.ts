import { query, queryOne } from './db.js';
import type {
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
  RetentionMetric
} from './types.js';

/** Range params are always $1 = start (nullable), $2 = end. */
function rangeParams(period: ResolvedPeriod): [string | null, string] {
  return [period.start, period.end];
}

/** Range predicate for the analytics_events table (alias `e`). */
const EVENTS_RANGE = `($1::timestamptz is null or e.created_at >= $1::timestamptz) and e.created_at < $2::timestamptz`;

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
           and registered_at < $2::timestamptz
       )::int as new_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or last_seen_at >= $1::timestamptz)
           and last_seen_at < $2::timestamptz
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
           and registered_at < $2::timestamptz
       )::int as new_users,
       count(*) filter (
         where account_status <> 'deleted'
           and ($1::timestamptz is null or last_seen_at >= $1::timestamptz)
           and last_seen_at < $2::timestamptz
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
       count(*) filter (where event_name = 'compression_started')::int as starts,
       count(*) filter (where event_name = 'compression_completed')::int as completions
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

export async function getOnboarding(period: ResolvedPeriod): Promise<StageMetric[]> {
  return query<StageMetric>(
    `select event_name as stage, count(*)::int as events, count(distinct user_id)::int as users
     from public.analytics_events e
     where ${EVENTS_RANGE} and event_name in (
       'setup_prompt_shown','install_download_clicked','install_detected','pairing_started',
       'pairing_completed','tool_opened','onboarding_started','onboarding_completed','onboarding_skipped'
     )
     group by event_name order by min(occurred_at)`,
    rangeParams(period)
  );
}

export async function getUpdates(period: ResolvedPeriod): Promise<StageMetric[]> {
  return query<StageMetric>(
    `select event_name as stage, count(*)::int as events, count(distinct user_id)::int as users
     from public.analytics_events e
     where ${EVENTS_RANGE} and event_name in (
       'update_available','update_prompt_shown','agent_update_required','update_started',
       'update_download_completed','update_verification_failed','update_deferred_busy',
       'update_draining_started','update_restart_started','update_completed','update_failed','update_dismissed'
     )
     group by event_name order by min(occurred_at)`,
    rangeParams(period)
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

export async function getFriction(period: ResolvedPeriod): Promise<FrictionSignal[]> {
  return query<FrictionSignal>(
    `with sessions as (
       select user_id, session_id,
         bool_or(event_name = 'tool_opened') as opened,
         bool_or(event_name in ('input_add_completed','videos_added')) as added,
         bool_or(event_name in ('operation_started','compression_started','landing_optimization_started')) as started,
         bool_or(event_name in ('operation_completed','compression_completed','landing_optimization_completed')) as completed,
         bool_or(event_name in ('operation_failed','compression_failed','landing_optimization_failed')) as failed,
         count(*) filter (where event_name in ('validation_message_shown','blocked_action_attempted')) as blocked,
         bool_or(event_name in ('update_prompt_shown','agent_update_required')) as update_prompt,
         bool_or(event_name = 'update_completed') as updated
       from public.analytics_events e where ${EVENTS_RANGE}
       group by user_id, session_id
     ), signals as (
       select user_id, session_id, unnest(array[
         case when opened and not added then 'opened_without_input' end,
         case when added and not started then 'input_without_start' end,
         case when started and not completed and not failed then 'started_without_outcome' end,
         case when failed and not completed then 'failure_without_recovery' end,
         case when blocked >= 2 then 'repeated_blocked_action' end,
         case when update_prompt and not updated then 'update_not_completed' end
       ]) as signal from sessions
     )
     select signal, count(distinct user_id)::int as users, count(distinct session_id)::int as sessions
     from signals where signal is not null group by signal order by users desc, sessions desc`,
    rangeParams(period)
  );
}

export async function getFeatures(period: ResolvedPeriod): Promise<FeatureMetric[]> {
  return query<FeatureMetric>(
    `select
       coalesce(feature, properties ->> 'feature_identifier', 'unknown') as feature,
       count(*) filter (where event_name = 'feature_impression')::int as impressions,
       count(*) filter (where event_name in ('feature_enabled','feature_help_opened','setting_changed'))::int as interactions,
       count(*) filter (where event_name in ('operation_completed','compression_completed','landing_optimization_completed'))::int as successful_operations,
       count(distinct user_id)::int as unique_users
     from public.analytics_events e
     where ${EVENTS_RANGE} and (feature is not null or properties ? 'feature_identifier')
     group by 1 order by unique_users desc, feature`,
    rangeParams(period)
  );
}

export async function getJourney(email: string, limit = 200): Promise<JourneyEvent[]> {
  return query<JourneyEvent>(
    `select e.event_id::text, e.occurred_at::text, e.session_sequence, e.session_id::text,
       e.installation_id::text, e.run_id::text, e.event_name, e.tool,
       e.local_app_version, e.local_app_build, e.web_build_id, e.platform, e.architecture, e.properties
     from public.analytics_events e
     join public.analytics_users u on u.id = e.user_id
     where u.email_normalized = lower($1)
     order by e.occurred_at desc, e.session_sequence desc nulls last limit $2`,
    [email, limit]
  );
}

export async function getRun(runId: string, limit = 500): Promise<JourneyEvent[]> {
  return query<JourneyEvent>(
    `select event_id::text, occurred_at::text, session_sequence, session_id::text,
       installation_id::text, run_id::text, event_name, tool,
       local_app_version, local_app_build, web_build_id, platform, architecture, properties
     from public.analytics_events where run_id = $1::uuid
     order by occurred_at, session_sequence nulls last limit $2`,
    [runId, limit]
  );
}

export async function diagnoseFingerprint(
  fingerprint: string,
  limit = 200
): Promise<JourneyEvent[]> {
  return query<JourneyEvent>(
    `select event_id::text, occurred_at::text, session_sequence, session_id::text,
       installation_id::text, run_id::text, event_name, tool,
       local_app_version, local_app_build, web_build_id, platform, architecture, properties
     from public.analytics_events
     where error_fingerprint = $1 or properties ->> 'error_fingerprint' = $1
     order by occurred_at desc limit $2`,
    [fingerprint, limit]
  );
}

export async function getCohorts(
  period: ResolvedPeriod,
  by: 'local-app-version' | 'platform' | 'web-build'
): Promise<CohortMetric[]> {
  const dimension =
    by === 'platform'
      ? 'platform'
      : by === 'web-build'
        ? 'web_build_id'
        : 'coalesce(local_app_version, agent_version)';
  return query<CohortMetric>(
    `select coalesce(${dimension}, 'unknown') as cohort,
       count(distinct user_id)::int as users, count(*)::int as events,
       count(*) filter (where event_name in ('operation_completed','compression_completed','landing_optimization_completed'))::int as successes,
       count(*) filter (where event_name in ('operation_failed','compression_failed','landing_optimization_failed'))::int as failures
     from public.analytics_events e where ${EVENTS_RANGE}
     group by 1 order by users desc, events desc`,
    rangeParams(period)
  );
}

export async function getRetention(period: ResolvedPeriod): Promise<RetentionMetric> {
  const row = await queryOne<RetentionMetric>(
    `select count(*)::int as registered_users,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '1 day'))::int as active_after_1d,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '7 days'))::int as active_after_7d,
       count(*) filter (where exists (select 1 from public.analytics_events e where e.user_id = u.id and e.occurred_at >= u.registered_at + interval '30 days'))::int as active_after_30d
     from public.analytics_users u
     where ($1::timestamptz is null or u.registered_at >= $1::timestamptz) and u.registered_at < $2::timestamptz`,
    rangeParams(period)
  );
  return (
    row ?? { registered_users: 0, active_after_1d: 0, active_after_7d: 0, active_after_30d: 0 }
  );
}
