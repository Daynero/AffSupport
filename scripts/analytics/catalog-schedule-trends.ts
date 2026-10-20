import { query } from './db.js';
import type { ResolvedPeriod } from './types.js';

export interface IntervalDistribution {
  interval: string;
  catalogs: number;
  distinct_last_editors: number;
  raw_intervals: Array<{ interval: string | null; count: number }>;
}
export interface IntervalPopularity {
  interval: string;
  selections: number;
  distinct_actors: number;
  unknown_actor_changes: number;
  raw_intervals: Array<{ interval: string | null; count: number }>;
}
export interface CatalogScheduleTrendsData {
  status: 'ok' | 'unsupported_by_producer';
  period: { start: string | null; end: string; timezone: 'UTC' };
  scope: { user_id: string | null; mode: 'all' | 'actor' };
  totals: {
    confirmed_changes: number;
    interval_changes: number;
    distinct_actors: number;
    unknown_actor_changes: number;
  };
  current: {
    catalogs: number;
    known_last_editors: number;
    unknown_last_editors: number;
    distribution: IntervalDistribution[];
  };
  popularity: IntervalPopularity[];
  daily: Array<{
    date: string;
    confirmed_changes: number;
    interval_changes: number;
    distinct_actors: number;
    unknown_actor_changes: number;
  }>;
  interval_daily_endstate: Array<{ date: string; interval: string; catalogs: number }>;
  transitions: Array<{
    from: string;
    to: string;
    changes: number;
    distinct_actors: number;
    unknown_actor_changes: number;
    raw_pairs: Array<{ from: string | null; to: string | null; changes: number }>;
  }>;
  custom_hours: Array<{
    hours: number;
    catalogs: number;
    confirmed_selections: number;
    distinct_actors: number;
  }>;
  schedule_clock: Array<{
    time: string;
    weekday: number | null;
    time_zone: string;
    catalogs: number;
    confirmed_selections: number;
    distinct_actors: number;
  }>;
  options: Array<{
    field: string;
    enabled_catalogs: number;
    disabled_catalogs: number;
    enabled_changes: number;
    disabled_changes: number;
    distinct_actors: number;
    unknown_actor_changes: number;
  }>;
  users: Array<{
    user_id: string;
    confirmed_changes: number;
    catalogs_changed: number;
    first_observed_before: { at: string; interval: string };
    first_observed: { at: string; interval: string };
    latest_observed: { at: string; interval: string };
    intervals: Array<{ interval: string; selections: number }>;
    timeline: Array<{
      at: string;
      catalog_id: string;
      from: string;
      to: string;
      options_changed: string[];
    }>;
  }>;
  coverage: {
    as_of: string;
    observed_since: string | null;
    installed_at: string | null;
    capture_enabled: boolean | null;
    schema_version: number | null;
    history_complete: false;
    timezone: 'UTC';
    baseline_rows: number;
    omitted_unobserved_days: number | null;
    unknown_actor_changes: number;
    notes: string[];
  };
  truncation: {
    timeline_total: number;
    timeline_returned: number;
    timeline_limit: number;
    users_total: number;
    users_returned: number;
    users_limit: number;
    daily_days_total: number;
    daily_days_returned: number;
    daily_days_limit: number;
  };
}

/** Cadence aliases share popularity buckets; raw values remain beside every bucket. */
export function normalizeCatalogInterval(value: string | null): string {
  if (value === null) return 'off';
  if (value === '1d' || value === '24h') return '1d';
  if (value === '1w' || value === '168h') return '1w';
  if (/^[1-9][0-9]{0,2}h$/u.test(value)) {
    const hours = Number(value.slice(0, -1));
    if (hours === 24) return '1d';
    if (hours === 168) return '1w';
    if (hours >= 1 && hours <= 720) return `${hours}h`;
  }
  return value;
}

/** Join independently aggregated current stock and confirmed selections without conflating them. */
export function aggregateCustomHours(
  current: IntervalDistribution[],
  popularity: IntervalPopularity[]
): CatalogScheduleTrendsData['custom_hours'] {
  const result = new Map<number, CatalogScheduleTrendsData['custom_hours'][number]>();
  for (const item of [...current, ...popularity]) {
    const normalized = normalizeCatalogInterval(item.interval);
    if (!/^\d+h$/u.test(normalized) || normalized === '1h') continue;
    const hours = Number(normalized.slice(0, -1));
    if (normalized !== `${hours}h` || hours < 1 || hours > 720) continue;
    const bucket = result.get(hours) ?? {
      hours,
      catalogs: 0,
      confirmed_selections: 0,
      distinct_actors: 0
    };
    if ('catalogs' in item) bucket.catalogs += item.catalogs;
    else {
      bucket.confirmed_selections += item.selections;
      bucket.distinct_actors += item.distinct_actors;
    }
    result.set(hours, bucket);
  }
  return [...result.values()].sort((a, b) => a.hours - b.hours);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMELINE_LIMIT = 2000;
const DAYS_LIMIT = 366;
const canonical = (expression: string) =>
  `case when ${expression} is null then 'off' when ${expression} in ('1d','24h') then '1d' when ${expression} in ('1w','168h') then '1w' else ${expression} end`;

export function catalogScheduleTrendsSql(includeCoverage = false): string {
  const before = canonical("before_state->>'updateInterval'");
  const after = canonical("after_state->>'updateInterval'");
  const current = canonical("state->>'updateInterval'");
  return `with
  history as (select *, ${before} as previous_interval, ${after} as interval
    from public.analytics_catalog_settings_history where observed_at <= $2::timestamptz),
  latest as (select distinct on (catalog_material_id) catalog_material_id, actor_id, after_state as state
    from history order by catalog_material_id, observed_at desc, transaction_id desc, event_id desc),
  current_states as (select *, ${current} as interval from latest
    where state->>'isActive' = 'true' and state->>'isDeleted' is distinct from 'true'
      and ($3::uuid is null or actor_id = $3::uuid)),
  changes as (select * from history where source = 'change'
    and ($1::timestamptz is null or observed_at >= $1::timestamptz)
    and ($3::uuid is null or actor_id = $3::uuid)),
  selections as (select * from changes where previous_interval <> interval),
  day_bounds as (select case when min(observed_at) is not null then greatest(coalesce($1::timestamptz,min(observed_at)),min(observed_at)) end as first_day from history),
  days as (select generate_series(greatest((first_day at time zone 'UTC')::date,
    ($2::timestamptz at time zone 'UTC')::date - ($6::integer - 1)),
    ($2::timestamptz at time zone 'UTC')::date, interval '1 day')::date as day from day_bounds where first_day is not null),
  end_states as (select day, latest_day.* from days cross join lateral (
    select distinct on (catalog_material_id) catalog_material_id, actor_id, after_state as state, interval
    from history where observed_at < least((days.day + 1)::timestamp at time zone 'UTC', $2::timestamptz + interval '1 microsecond')
    order by catalog_material_id, observed_at desc, transaction_id desc, event_id desc) as latest_day
    where state->>'isActive' = 'true' and state->>'isDeleted' is distinct from 'true'
      and ($3::uuid is null or actor_id = $3::uuid)),
  user_totals as (select actor_id, count(*) as confirmed_changes, count(distinct catalog_material_id) as catalogs_changed
    from changes where actor_id is not null group by actor_id),
  chosen_users as (select * from user_totals order by confirmed_changes desc, actor_id limit $4),
  timeline as (select * from changes where actor_id in (select actor_id from chosen_users)
    order by observed_at desc, event_id desc limit $5),
  clock_current as (select state->'schedule'->>'time' as time,
    case when interval = '1w' then (state->'schedule'->>'weekday')::integer end as weekday,
    state->'schedule'->>'timeZone' as time_zone, count(*) as catalogs
    from current_states where state->'schedule'->>'time' is not null group by 1,2,3),
  clock_changes as (select after_state->'schedule'->>'time' as time,
    case when interval = '1w' then (after_state->'schedule'->>'weekday')::integer end as weekday,
    after_state->'schedule'->>'timeZone' as time_zone, count(*) as confirmed_selections, count(distinct actor_id) as distinct_actors
    from changes where after_state->'schedule'->>'time' is not null and
      (before_state->'schedule' is distinct from after_state->'schedule' or previous_interval <> interval) group by 1,2,3)
  select jsonb_build_object(
    'totals',jsonb_build_object('confirmed_changes',(select count(*) from changes),'interval_changes',(select count(*) from selections),
      'distinct_actors',(select count(distinct actor_id) from changes),'unknown_actor_changes',(select count(*) from changes where actor_id is null)),
    'current', jsonb_build_object('catalogs',(select count(*) from current_states),
      'known_last_editors',(select count(distinct actor_id) from current_states),
      'unknown_last_editors',(select count(*) from current_states where actor_id is null),
      'distribution',coalesce((select jsonb_agg(bucket order by interval) from (
        select interval,count(*) as catalogs,count(distinct actor_id) as distinct_last_editors,
          (select jsonb_agg(raw_row order by raw_row.interval nulls first) from (
            select state->>'updateInterval' as interval,count(*) as count from current_states as raw
            where raw.interval = grouped.interval group by 1) raw_row) as raw_intervals
        from current_states grouped group by interval) bucket),'[]'::jsonb)),
    'popularity',coalesce((select jsonb_agg(bucket order by selections desc,interval) from (
      select interval,count(*) as selections,count(distinct actor_id) as distinct_actors,
        count(*) filter(where actor_id is null) as unknown_actor_changes,
        (select jsonb_agg(raw_row) from (select after_state->>'updateInterval' as interval,count(*) as count
          from selections as raw where raw.interval = grouped.interval group by 1) raw_row) as raw_intervals
      from selections grouped group by interval) bucket),'[]'::jsonb),
    'daily',coalesce((select jsonb_agg(jsonb_build_object('date',day::text,
      'confirmed_changes',(select count(*) from changes where (observed_at at time zone 'UTC')::date=day),
      'interval_changes',(select count(*) from selections where (observed_at at time zone 'UTC')::date=day),
      'distinct_actors',(select count(distinct actor_id) from changes where (observed_at at time zone 'UTC')::date=day),
      'unknown_actor_changes',(select count(*) from changes where (observed_at at time zone 'UTC')::date=day and actor_id is null)) order by day) from days),'[]'::jsonb),
    'interval_daily_endstate',coalesce((select jsonb_agg(bucket order by date,interval) from (
      select day::text as date,interval,count(*) as catalogs from end_states group by day,interval) bucket),'[]'::jsonb),
    'transitions',coalesce((select jsonb_agg(bucket order by changes desc,"from","to") from (
      select previous_interval as "from",interval as "to",count(*) as changes,count(distinct actor_id) as distinct_actors,
        count(*) filter(where actor_id is null) as unknown_actor_changes,
        (select jsonb_agg(raw_row) from (select before_state->>'updateInterval' as "from",after_state->>'updateInterval' as "to",count(*) as changes
          from selections raw where raw.previous_interval=grouped.previous_interval and raw.interval=grouped.interval group by 1,2) raw_row) as raw_pairs
      from selections grouped group by previous_interval,interval) bucket),'[]'::jsonb),
    'options',coalesce((select jsonb_agg(jsonb_build_object('field',field,
      'enabled_catalogs',(select count(*) from current_states where state->>field='true'),
      'disabled_catalogs',(select count(*) from current_states where state->>field='false'),
      'enabled_changes',(select count(*) from changes where before_state->>field is distinct from after_state->>field and after_state->>field='true'),
      'disabled_changes',(select count(*) from changes where before_state->>field is distinct from after_state->>field and after_state->>field='false'),
      'distinct_actors',(select count(distinct actor_id) from changes where before_state->>field is distinct from after_state->>field),
      'unknown_actor_changes',(select count(*) from changes where before_state->>field is distinct from after_state->>field and actor_id is null)))
      from (values ('restitch'),('randomLinkVariation'),('refreshImages'),('refreshTexts'),('growProducts')) fields(field)),'[]'::jsonb),
    'schedule_clock',coalesce((select jsonb_agg(jsonb_build_object('time',coalesce(c.time,e.time),
      'weekday',coalesce(c.weekday,e.weekday),'time_zone',coalesce(c.time_zone,e.time_zone),
      'catalogs',coalesce(c.catalogs,0),'confirmed_selections',coalesce(e.confirmed_selections,0),'distinct_actors',coalesce(e.distinct_actors,0)))
      from clock_current c full join clock_changes e on c.time=e.time and c.weekday is not distinct from e.weekday and c.time_zone=e.time_zone),'[]'::jsonb),
    'users',coalesce((select jsonb_agg(jsonb_build_object('user_id',u.actor_id,'confirmed_changes',u.confirmed_changes,'catalogs_changed',u.catalogs_changed,
      'first_observed_before',(select jsonb_build_object('at',observed_at,'interval',previous_interval) from changes where actor_id=u.actor_id order by observed_at,event_id limit 1),
      'first_observed',(select jsonb_build_object('at',observed_at,'interval',interval) from changes where actor_id=u.actor_id order by observed_at,event_id limit 1),
      'latest_observed',(select jsonb_build_object('at',observed_at,'interval',interval) from changes where actor_id=u.actor_id order by observed_at desc,event_id desc limit 1),
      'intervals',coalesce((select jsonb_agg(bucket) from (select interval,count(*) as selections from selections where actor_id=u.actor_id group by interval) bucket),'[]'::jsonb),
      'timeline',coalesce((select jsonb_agg(jsonb_build_object('at',observed_at,'catalog_id',catalog_material_id,'from',previous_interval,'to',interval,
        'options_changed',coalesce((select jsonb_agg(field) from unnest(changed_fields) field where field in ('restitch','randomLinkVariation','refreshImages','refreshTexts','growProducts')),'[]'::jsonb))
        order by catalog_material_id,observed_at,event_id) from timeline where actor_id=u.actor_id),'[]'::jsonb)) order by u.confirmed_changes desc,u.actor_id) from chosen_users u),'[]'::jsonb),
    'metadata',jsonb_build_object(
      'installed_at',${includeCoverage ? '(select installed_at from public.analytics_catalog_settings_coverage limit 1)' : 'null'},
      'capture_enabled',${includeCoverage ? '(select capture_enabled from public.analytics_catalog_settings_coverage limit 1)' : 'null'},
      'schema_version',${includeCoverage ? '(select schema_version from public.analytics_catalog_settings_coverage limit 1)' : 'null'},
      'observed_since',(select min(observed_at) from history),'baseline_rows',(select count(*) from history where source='baseline'),
      'unknown_actor_changes',(select count(*) from changes where actor_id is null),'timeline_total',(select count(*) from changes where actor_id in(select actor_id from chosen_users)),
      'timeline_returned',(select count(*) from timeline),'users_total',(select count(*) from user_totals),'users_returned',(select count(*) from chosen_users),
      'omitted_unobserved_days',(select case when min(observed_at) is null then null when $1::timestamptz is null then 0 else greatest(0,(min(observed_at) at time zone 'UTC')::date-($1::timestamptz at time zone 'UTC')::date) end from history),
      'daily_days_total',(select coalesce(greatest(0,($2::timestamptz at time zone 'UTC')::date-(first_day at time zone 'UTC')::date+1),0) from day_bounds),
      'daily_days_returned',(select count(*) from days))
  ) as data`;
}

export async function getCatalogScheduleTrends(
  period: ResolvedPeriod,
  options: { user?: string; limit?: number } = {}
): Promise<CatalogScheduleTrendsData> {
  if (
    options.limit !== undefined &&
    (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit < 1)
  ) {
    throw new Error('Limit must be a positive finite integer.');
  }
  const usersLimit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 20)));
  let userId: string | null = null;
  if (options.user) {
    if (UUID.test(options.user)) userId = options.user;
    else {
      const found = await query<{ id: string }>(
        'select id from public.analytics_users where email_normalized = lower($1) limit 1',
        [options.user]
      );
      if (!found[0]) throw new Error('No analytics user matched that subject.');
      userId = found[0].id;
    }
  }
  const visible = await query<{ history_view: string | null; coverage_view?: string | null }>(
    "select to_regclass('public.analytics_catalog_settings_history')::text as history_view, to_regclass('public.analytics_catalog_settings_coverage')::text as coverage_view"
  );
  const empty: CatalogScheduleTrendsData = {
    status: 'unsupported_by_producer',
    period: { start: period.start, end: period.end, timezone: 'UTC' },
    scope: { user_id: userId, mode: userId ? 'actor' : 'all' },
    totals: {
      confirmed_changes: 0,
      interval_changes: 0,
      distinct_actors: 0,
      unknown_actor_changes: 0
    },
    current: { catalogs: 0, known_last_editors: 0, unknown_last_editors: 0, distribution: [] },
    popularity: [],
    daily: [],
    interval_daily_endstate: [],
    transitions: [],
    custom_hours: [],
    schedule_clock: [],
    options: [],
    users: [],
    coverage: {
      as_of: period.end,
      observed_since: null,
      installed_at: null,
      capture_enabled: null,
      schema_version: null,
      history_complete: false,
      timezone: 'UTC',
      baseline_rows: 0,
      omitted_unobserved_days: null,
      unknown_actor_changes: 0,
      notes: []
    },
    truncation: {
      timeline_total: 0,
      timeline_returned: 0,
      timeline_limit: TIMELINE_LIMIT,
      users_total: 0,
      users_returned: 0,
      users_limit: usersLimit,
      daily_days_total: 0,
      daily_days_returned: 0,
      daily_days_limit: DAYS_LIMIT
    }
  };
  if (!visible[0]?.history_view) {
    empty.coverage.notes.push(
      'The authoritative settings journal is unavailable. Counts are unknown, not zero. Apply the journal migration before interpreting trends.'
    );
    return empty;
  }
  type Payload = Pick<
    CatalogScheduleTrendsData,
    | 'totals'
    | 'current'
    | 'popularity'
    | 'daily'
    | 'interval_daily_endstate'
    | 'transitions'
    | 'schedule_clock'
    | 'options'
    | 'users'
  > & { metadata: Record<string, number | string | boolean | null> };
  let rows: Array<{ data: Payload }>;
  try {
    rows = await query<{ data: Payload }>(
      catalogScheduleTrendsSql(Boolean(visible[0]?.coverage_view)),
      [period.start, period.end, userId, usersLimit, TIMELINE_LIMIT, DAYS_LIMIT]
    );
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code !== '42501' && code !== '42P01') throw error;
    empty.coverage.notes.push(
      'The authoritative settings journal is inaccessible to this read-only connection. Counts are unknown, not zero; check the journal migration and analytics grants.'
    );
    return empty;
  }
  if (!rows[0]?.data) throw new Error('The settings aggregate returned no result.');
  const { metadata, ...data } = rows[0].data;
  if (
    typeof metadata.installed_at === 'string' &&
    Date.parse(metadata.installed_at) > Date.parse(period.end)
  ) {
    empty.coverage.installed_at = metadata.installed_at;
    empty.coverage.capture_enabled = metadata.capture_enabled === true;
    empty.coverage.schema_version = Number(metadata.schema_version);
    empty.coverage.notes.push(
      'The requested as_of precedes journal installation. Settings and changes at that time are unknown, not zero.'
    );
    return empty;
  }
  return {
    ...empty,
    ...data,
    status: 'ok',
    custom_hours: aggregateCustomHours(data.current.distribution, data.popularity),
    coverage: {
      ...empty.coverage,
      observed_since: metadata.observed_since as string | null,
      installed_at: (metadata.installed_at as string | null) ?? null,
      capture_enabled:
        typeof metadata.capture_enabled === 'boolean' ? metadata.capture_enabled : null,
      schema_version: metadata.schema_version == null ? null : Number(metadata.schema_version),
      baseline_rows: Number(metadata.baseline_rows),
      omitted_unobserved_days:
        metadata.omitted_unobserved_days == null ? null : Number(metadata.omitted_unobserved_days),
      unknown_actor_changes: Number(metadata.unknown_actor_changes),
      notes: [
        ...(metadata.capture_enabled === false
          ? [
              'Journal capture is currently disabled or incomplete. Latest observed states may be stale; current configuration after that observation is unknown.'
            ]
          : []),
        ...(metadata.capture_enabled == null
          ? [
              'Capture installation and trigger-health metadata are unavailable; historical completeness cannot be established.'
            ]
          : []),
        'History starts at the first authoritative observation, not at account or catalog creation. Baselines are excluded from confirmed changes and transitions.',
        'Current means active, nondeleted catalog state reconstructed at as_of. Distinct last editors describe attribution, not ownership; unknown_last_editors counts catalogs with unknown attribution.',
        'Interval popularity counts confirmed cadence changes; distinct actors are deduplicated per interval and can appear in multiple intervals. Alias-only changes do not count as preference changes.',
        'First/latest observed selections span catalogs and the requested period; they are not a single user preference or the true first choice.',
        'UTC calendar days; daily end states only include catalogs already observed by that day. Earlier unavailable history is unknown.',
        'Daily charts retain at most the latest 366 observed UTC days, with omitted counts explicit. Other aggregate counts cover the entire window. User rows are ranked by confirmed activity; timelines contain the most recent bounded sample for those users, sorted by catalog and time.',
        'The client UI funnel is separate, lossy evidence. Use the existing catalog_manager flow/attempt diagnostic seams for browser delivery; this journal does not prove UI visibility.'
      ]
    },
    truncation: {
      ...empty.truncation,
      timeline_total: Number(metadata.timeline_total),
      timeline_returned: Number(metadata.timeline_returned),
      users_total: Number(metadata.users_total),
      users_returned: Number(metadata.users_returned),
      daily_days_total: Number(metadata.daily_days_total),
      daily_days_returned: Number(metadata.daily_days_returned)
    }
  };
}
