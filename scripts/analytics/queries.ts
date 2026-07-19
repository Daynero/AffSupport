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
  UsersData
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
