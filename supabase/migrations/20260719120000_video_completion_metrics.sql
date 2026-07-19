-- Per-video completion metrics: count converted videos by mode and image embedding.
-- The batch-level counters answer "how many runs", these answer "how many videos".

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
    ),
    -- Per-video counts: how many individual videos finished in each mode / with an embedded image.
    'videos_optimal', count(*) filter (
      where event_name = 'compression_completed' and properties ->> 'mode' = 'optimal'
    ),
    'videos_custom', count(*) filter (
      where event_name = 'compression_completed' and properties ->> 'mode' = 'custom'
    ),
    'videos_with_image', count(*) filter (
      where event_name = 'compression_completed' and properties ->> 'image_embedding' = 'true'
    )
  ) into result
  from public.analytics_events
  where created_at >= p_start_date and created_at < p_end_date;

  return result;
end;
$$;

revoke all on function public.admin_overview(timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_overview(timestamptz, timestamptz) to authenticated;

comment on function public.admin_overview(timestamptz, timestamptz) is 'Admin-only aggregate metrics without raw event payloads; includes per-video completion counts.';
