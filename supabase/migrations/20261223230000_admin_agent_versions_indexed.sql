-- next 2026-11-22: the admin «Аналітика» tab again opened on «Не вдалося завантажити дані адмінки»
-- now and then. admin_agent_versions filtered analytics_events by occurred_at, which has no index:
-- every open read the whole table (~580 MB), 1.4 s warm and far longer cold — and the tab sends
-- eight reads at once under the authenticated role's 8 s statement timeout.
--
-- The same answer, bounded first by created_at (indexed): an event is written within moments of
-- when it happened, and a day of margin on each side keeps every event the occurred_at range
-- selects. Read-only and admin-only; signature, grants and the admin check are unchanged.
create or replace function public.admin_agent_versions(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns table (agent_version text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query
  with latest as (
    select distinct on (coalesce(events.user_id::text, events.installation_id::text))
      coalesce(events.local_app_version, events.agent_version, 'unknown') as version,
      coalesce(events.user_id::text, events.installation_id::text) as identity
    from public.analytics_events as events
    where events.created_at >= p_start_date - interval '1 day'
      and events.created_at < p_end_date + interval '1 day'
      and events.occurred_at >= p_start_date and events.occurred_at < p_end_date
      and (events.user_id is not null or events.installation_id is not null)
    order by coalesce(events.user_id::text, events.installation_id::text), events.occurred_at desc
  )
  select latest.version, count(*)::bigint
  from latest group by latest.version order by count(*) desc, latest.version;
end;
$$;
