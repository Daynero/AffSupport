-- Narrow, database-authorized admin RPCs. Raw auth.users and raw event JSON stay server-side.

create or replace function public.admin_overview(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_end_date <= p_start_date or p_end_date - p_start_date > interval '370 days' then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'total_users', (select count(*) from public.profiles where account_status <> 'deleted'),
    'new_users_24h', (select count(*) from public.profiles where created_at >= now() - interval '24 hours'),
    'new_users_7d', (select count(*) from public.profiles where created_at >= now() - interval '7 days'),
    'new_users_30d', (select count(*) from public.profiles where created_at >= now() - interval '30 days'),
    'active_users_7d', (select count(*) from public.profiles where last_seen_at >= now() - interval '7 days'),
    'active_users_30d', (select count(*) from public.profiles where last_seen_at >= now() - interval '30 days'),
    'marketing_consent_users', (
      select count(*) from public.profiles
      where marketing_consent = true and account_status = 'active'
    ),
    'agent_connections', count(*) filter (where event_name = 'agent_connected'),
    'compressor_opens', count(*) filter (where event_name = 'tool_opened' and tool = 'compressor'),
    'compression_batches', count(*) filter (where event_name = 'compression_batch_started'),
    'successful_compressions', count(*) filter (where event_name = 'compression_completed'),
    'failed_compressions', count(*) filter (where event_name = 'compression_failed'),
    'total_videos', coalesce(sum(
      case when event_name = 'videos_added' and jsonb_typeof(properties -> 'video_count') = 'number'
        then (properties ->> 'video_count')::numeric else 0 end
    ), 0),
    'total_input_bytes', coalesce(sum(
      case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'total_input_bytes') = 'number'
        then (properties ->> 'total_input_bytes')::numeric else 0 end
    ), 0),
    'total_output_bytes', coalesce(sum(
      case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'total_output_bytes') = 'number'
        then (properties ->> 'total_output_bytes')::numeric else 0 end
    ), 0),
    'total_saved_bytes', coalesce(sum(
      case when event_name = 'compression_completed'
        and jsonb_typeof(properties -> 'total_input_bytes') = 'number'
        and jsonb_typeof(properties -> 'total_output_bytes') = 'number'
        then greatest(
          (properties ->> 'total_input_bytes')::numeric - (properties ->> 'total_output_bytes')::numeric,
          0
        ) else 0 end
    ), 0),
    'average_saving_percent', coalesce(avg(
      case when event_name = 'compression_completed' and jsonb_typeof(properties -> 'saving_percent') = 'number'
        then (properties ->> 'saving_percent')::numeric end
    ), 0),
    'optimal_batches', count(*) filter (
      where event_name = 'compression_batch_started' and properties ->> 'mode' = 'optimal'
    ),
    'custom_batches', count(*) filter (
      where event_name = 'compression_batch_started' and properties ->> 'mode' = 'custom'
    ),
    'image_embedding_batches', count(*) filter (
      where event_name = 'compression_batch_started' and properties ->> 'image_embedding' = 'true'
    )
  ) into result
  from public.analytics_events
  where created_at >= p_start_date and created_at < p_end_date;

  return result;
end;
$$;

create or replace function public.admin_daily_activity(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns table (activity_date date, active_users bigint, event_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_end_date <= p_start_date or p_end_date - p_start_date > interval '370 days' then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;
  return query
  select
    day::date,
    count(distinct events.user_id)::bigint,
    count(events.id)::bigint
  from generate_series(
    date_trunc('day', p_start_date),
    date_trunc('day', p_end_date - interval '1 microsecond'),
    interval '1 day'
  ) as day
  left join public.analytics_events as events
    on events.created_at >= day
    and events.created_at < day + interval '1 day'
  group by day
  order by day;
end;
$$;

create or replace function public.admin_tool_usage(
  p_start_date timestamptz,
  p_end_date timestamptz
)
returns table (category text, label text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_end_date <= p_start_date or p_end_date - p_start_date > interval '370 days' then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;
  return query
  select 'mode'::text, coalesce(events.properties ->> 'mode', 'unknown'), count(*)::bigint
  from public.analytics_events as events
  where events.event_name = 'compression_batch_started'
    and events.created_at >= p_start_date and events.created_at < p_end_date
  group by coalesce(events.properties ->> 'mode', 'unknown')
  union all
  select 'language'::text, profiles.language, count(*)::bigint
  from public.profiles as profiles
  where profiles.account_status <> 'deleted'
  group by profiles.language
  union all
  select 'image_embedding'::text, 'enabled'::text, count(*)::bigint
  from public.analytics_events as events
  where events.event_name = 'compression_batch_started'
    and events.properties ->> 'image_embedding' = 'true'
    and events.created_at >= p_start_date and events.created_at < p_end_date;
end;
$$;

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
  if p_end_date <= p_start_date or p_end_date - p_start_date > interval '370 days' then
    raise exception 'Invalid date range' using errcode = '22023';
  end if;
  return query
  select coalesce(events.agent_version, 'unknown'), count(*)::bigint
  from public.analytics_events as events
  where events.event_name = 'agent_connected'
    and events.created_at >= p_start_date and events.created_at < p_end_date
  group by coalesce(events.agent_version, 'unknown')
  order by count(*) desc, coalesce(events.agent_version, 'unknown');
end;
$$;

create or replace function public.admin_list_users(
  p_search text default '',
  p_marketing_consent boolean default null,
  p_account_status text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  email text,
  display_name text,
  language text,
  plan text,
  account_status text,
  marketing_consent boolean,
  marketing_consent_at timestamptz,
  created_at timestamptz,
  last_seen_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_account_status is not null and p_account_status not in ('active', 'blocked', 'deleted') then
    raise exception 'Invalid account status' using errcode = '22023';
  end if;

  return query
  select
    profiles.id,
    profiles.email,
    profiles.display_name,
    profiles.language,
    profiles.plan,
    profiles.account_status,
    profiles.marketing_consent,
    profiles.marketing_consent_at,
    profiles.created_at,
    profiles.last_seen_at,
    count(*) over()::bigint
  from public.profiles as profiles
  where (
      coalesce(trim(p_search), '') = ''
      or profiles.email ilike '%' || trim(p_search) || '%'
      or profiles.display_name ilike '%' || trim(p_search) || '%'
    )
    and (p_marketing_consent is null or profiles.marketing_consent = p_marketing_consent)
    and (p_account_status is null or profiles.account_status = p_account_status)
  order by profiles.created_at desc
  limit least(greatest(p_limit, 1), 100)
  offset greatest(p_offset, 0);
end;
$$;

create or replace function public.admin_marketing_export()
returns table (
  email text,
  display_name text,
  language text,
  marketing_consent_at timestamptz
)
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
  select profiles.email, profiles.display_name, profiles.language, profiles.marketing_consent_at
  from public.profiles as profiles
  where profiles.marketing_consent = true
    and profiles.marketing_consent_at is not null
    and profiles.email is not null
    and profiles.account_status = 'active'
  order by profiles.marketing_consent_at desc;
end;
$$;

create or replace function public.admin_set_account_status(
  p_user_id uuid,
  p_account_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_account_status not in ('active', 'blocked') then
    raise exception 'Only active and blocked are allowed here' using errcode = '22023';
  end if;
  if exists (select 1 from public.admin_users where user_id = p_user_id) then
    raise exception 'Administrator accounts cannot be blocked here' using errcode = '42501';
  end if;
  update public.profiles
  set account_status = p_account_status
  where id = p_user_id and account_status <> 'deleted';
  return found;
end;
$$;

revoke all on function public.admin_overview(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_daily_activity(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_tool_usage(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_agent_versions(timestamptz, timestamptz) from public, anon;
revoke all on function public.admin_list_users(text, boolean, text, integer, integer) from public, anon;
revoke all on function public.admin_marketing_export() from public, anon;
revoke all on function public.admin_set_account_status(uuid, text) from public, anon;

grant execute on function public.admin_overview(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_daily_activity(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_tool_usage(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_agent_versions(timestamptz, timestamptz) to authenticated;
grant execute on function public.admin_list_users(text, boolean, text, integer, integer) to authenticated;
grant execute on function public.admin_marketing_export() to authenticated;
grant execute on function public.admin_set_account_status(uuid, text) to authenticated;

comment on function public.admin_overview(timestamptz, timestamptz) is 'Admin-only aggregate metrics without raw event payloads.';
