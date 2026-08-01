-- Privacy-scoped team pilot analytics surface and closed team-event property allowlist.

create table private.team_pilot_enrollments (
  team_id uuid primary key references public.teams(id) on delete cascade,
  enrolled_at timestamptz not null,
  exited_at timestamptz,
  created_at timestamptz not null default now(),
  constraint team_pilot_enrollments_interval_check check (
    exited_at is null or exited_at > enrolled_at
  )
);

alter table private.team_pilot_enrollments enable row level security;
alter table private.team_pilot_enrollments force row level security;

revoke all on table private.team_pilot_enrollments
from public, anon, authenticated;

create or replace function public.analytics_properties_are_safe_v2(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
    and not exists (
      select 1 from jsonb_object_keys(payload) as property_key
      where property_key <> all (array[
        'tool_identifier', 'feature_identifier', 'screen_identifier', 'action_identifier',
        'flow_step', 'outcome', 'source_kind', 'input_method', 'format', 'video_codec',
        'audio_codec', 'image_codec', 'pixel_format', 'setting_name', 'setting_value',
        'error_category', 'error_code', 'error_stage', 'error_fingerprint', 'retryable',
        'recovered', 'success', 'video_count', 'file_count', 'total_input_bytes',
        'total_output_bytes', 'saving_percent', 'processing_duration_ms', 'duration_ms',
        'queue_wait_ms', 'attempt_number', 'width', 'height', 'mode', 'crf',
        'rate_control', 'output_fps', 'target_resolution', 'image_embedding', 'has_audio',
        'language', 'marketing_consent', 'flow_id', 'study_run_id', 'attempt_id',
        'workflow_id', 'category', 'cue_category', 'action', 'storage_kind',
        'size_bucket', 'cache_state', 'stage', 'assisted', 'invite_persisted',
        'root_confirmed', 'sync_queued', 'workspace_session', 'discovery_completed',
        'production_completed', 'window_index'
      ])
    )
    and not exists (
      select 1 from jsonb_each_text(payload) as property
      where length(property.value) > 128
         or property.value ~ '[/\\]'
         or property.value ~* '(bearer|oauth|token=|authorization)'
    )
    and case when payload ? 'category' then
      payload ->> 'category' in ('video','image','archive','transcript','landing','other')
      else true end
    and case when payload ? 'cue_category' then
      payload ->> 'cue_category' in ('geo','offer','language','category')
      else true end
    and case when payload ? 'action' then
      payload ->> 'action' in ('upload','download','rename','move','trash')
      else true end
    and case when payload ? 'storage_kind' then
      payload ->> 'storage_kind' in ('my_drive','shared_drive')
      else true end
    and case when payload ? 'size_bucket' then
      payload ->> 'size_bucket' in ('tiny','small','medium','large','agent')
      else true end
    and case when payload ? 'cache_state' then
      payload ->> 'cache_state' in ('cold','warm','unknown')
      else true end
    and case when payload ? 'stage' then
      payload ->> 'stage' in ('finding','previewing','downloading','processing','uploading','finalizing')
      else true end
    and case when payload ? 'outcome' then
      payload ->> 'outcome' in ('success','failure','cancelled','blocked','skipped','unsupported')
      else true end
    and not exists (
      select 1
      from jsonb_each(payload) as property
      where property.key in (
        'retryable','assisted','invite_persisted','root_confirmed','sync_queued',
        'workspace_session','discovery_completed','production_completed'
      ) and jsonb_typeof(property.value) <> 'boolean'
    )
    and case when payload ? 'window_index' then
      jsonb_typeof(payload -> 'window_index') = 'number'
      and (payload ->> 'window_index')::numeric between 1 and 4
      else true end
    and case when payload ? 'attempt_number' then
      jsonb_typeof(payload -> 'attempt_number') = 'number'
      and (payload ->> 'attempt_number')::numeric between 1 and 10000
      else true end
    and not exists (
      select 1
      from jsonb_each_text(payload) as property
      where property.key in ('flow_id','study_run_id','attempt_id','workflow_id')
        and property.value !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$'
    );
$$;

create or replace view public.analytics_team_workspace
with (security_invoker = off) as
select
  encode(extensions.digest(team.id::text, 'sha256'), 'hex') as workspace_key,
  member.user_id as member_user_id,
  member.joined_at as member_joined_at,
  member.removed_at as member_removed_at,
  connection.connected_at as root_connected_at,
  connection.state as root_state,
  enrollment.enrolled_at as pilot_enrolled_at,
  enrollment.exited_at as pilot_exited_at
from private.team_pilot_enrollments as enrollment
join public.teams as team
  on team.id = enrollment.team_id
 and team.status = 'active'
join public.team_members as member
  on member.team_id = team.id
join lateral (
  select drive.connected_at, drive.state
  from public.team_drive_connections as drive
  where drive.team_id = team.id
    and drive.connected_at is not null
  order by drive.created_at desc, drive.id desc
  limit 1
) as connection on true;

revoke all on public.analytics_team_workspace
from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_team_workspace to wishly_analytics_ro;
  end if;
end
$$;

comment on table private.team_pilot_enrollments is
  'Operator-controlled team pilot cohort; never exposed to browser roles.';
comment on view public.analytics_team_workspace is
  'Opaque aggregate input for SC-009; excludes team names, file/provider identifiers and content.';
