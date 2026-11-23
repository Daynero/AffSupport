-- 063: what the read-only analytics CLI may see of model calls and translations. Aggregates and
-- metadata only: no transcript text, no translated segments, no source fingerprint.

create view public.analytics_ai_usage_daily with (security_invoker = false) as
select
  (e.created_at at time zone 'UTC')::date as day,
  e.feature,
  e.model,
  e.outcome,
  count(*)::integer as calls,
  count(distinct e.user_id)::integer as users,
  sum(e.input_tokens)::bigint as input_tokens,
  sum(e.output_tokens)::bigint as output_tokens,
  sum(e.cache_read_tokens)::bigint as cache_read_tokens,
  sum(e.cache_write_tokens)::bigint as cache_write_tokens,
  sum(e.cost_micro_usd)::bigint as cost_micro_usd,
  sum(e.duration_ms)::bigint as duration_ms
from private.ai_usage_events e
group by 1, 2, 3, 4;

create view public.analytics_ai_usage_events with (security_invoker = false) as
select e.id, e.feature, e.user_id, e.subject_id, e.model, e.outcome, e.stop_reason,
  e.input_tokens, e.output_tokens, e.cost_micro_usd, e.duration_ms, e.created_at
from private.ai_usage_events e;

create view public.analytics_transcript_translations with (security_invoker = false) as
select t.id, t.scope, t.team_id, t.target_language, t.source_language, t.status, t.failure_code,
  t.units, t.total_segments, t.completed_segments, t.model, t.requested_by, t.created_at,
  t.completed_at,
  case when t.completed_at is null then null
       else (extract(epoch from (t.completed_at - t.created_at)) * 1000)::integer end as duration_ms
from private.transcript_translations t;

create view public.analytics_ai_allowance_daily with (security_invoker = false) as
select r.day, r.feature, r.user_id,
  sum(r.units) filter (where r.state = 'spent')::integer as spent_units,
  sum(r.units) filter (where r.state = 'released')::integer as released_units,
  count(*)::integer as reservations,
  max(a.daily_units)::integer as limit_units
from private.ai_allowance_reservations r
join private.ai_feature_allowances a on a.feature = r.feature
group by 1, 2, 3;

revoke all on public.analytics_ai_usage_daily, public.analytics_ai_usage_events,
  public.analytics_transcript_translations, public.analytics_ai_allowance_daily
  from public, anon, authenticated, service_role;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_ai_usage_daily, public.analytics_ai_usage_events,
      public.analytics_transcript_translations, public.analytics_ai_allowance_daily
      to wishly_analytics_ro;
  end if;
end $$;
