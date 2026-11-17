-- next QA 2026-11-17: the admin's «Аналітика» tab opened on «Не вдалося завантажити дані
-- адмінки або доступ заборонено». admin_overview and admin_daily_activity answered 500 after
-- eight seconds, the statement timeout of the authenticated role. analytics_events now takes
-- ~37k rows a day (387k in thirty days), and both functions read every one of them:
--
-- * admin_overview counted only six event names, but scanned all rows in the range and read
--   each row's properties. It now asks the (event_name, created_at) index for those six
--   names alone — about three thousand rows in thirty days; the numbers are the same, since
--   every figure it returns is filtered to one of them.
-- * admin_daily_activity joined each day of the range to its events, a nested loop of index
--   probes and heap fetches. It now reads the range once and groups by day, then fills the
--   days without events from the series, so the answer — including events earlier on the
--   first day than p_start_date — is unchanged.
--
-- Read-only, admin-only functions; signatures, grants and the admin check are unchanged.
begin;

do $overview$
declare
  d text;
  seam constant text := E'  from public.analytics_events\n  where created_at >= p_start_date and created_at < p_end_date;';
begin
  select pg_get_functiondef('public.admin_overview(timestamptz,timestamptz)'::regprocedure) into d;
  if strpos(d, seam) = 0 then
    raise exception 'ADMIN_OVERVIEW_SEAM_MISSING';
  end if;
  d := replace(d, seam,
    E'  from public.analytics_events\n'
    || E'  where created_at >= p_start_date and created_at < p_end_date\n'
    || E'    and event_name in (\n'
    || E'      ''agent_connected'', ''tool_opened'', ''compression_batch_started'',\n'
    || E'      ''compression_completed'', ''compression_failed'', ''videos_added''\n'
    || E'    );');
  execute d;
end $overview$;

create or replace function public.admin_daily_activity(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns table(activity_date date, active_users bigint, event_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  first_day timestamptz;
  last_day timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_end_date <= p_start_date or p_end_date - p_start_date > interval '370 days' then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;
  first_day := date_trunc('day', p_start_date);
  last_day := date_trunc('day', p_end_date - interval '1 microsecond');
  return query
  with per_day as (
    select date_trunc('day', events.created_at) as day,
           count(distinct events.user_id)::bigint as users,
           count(*)::bigint as total
      from public.analytics_events as events
     where events.created_at >= first_day
       and events.created_at < last_day + interval '1 day'
     group by 1
  )
  select series.day::date,
         coalesce(per_day.users, 0)::bigint,
         coalesce(per_day.total, 0)::bigint
    from generate_series(first_day, last_day, interval '1 day') as series(day)
    left join per_day on per_day.day = series.day
   order by series.day;
end;
$$;

commit;
