-- Feature 004: team landings gallery — shared render cache.
--
-- A landing render (WebP segments) is produced once by a paired local agent and stored in a
-- hidden .soty/landing-previews/ subtree in the connected Drive; this table records only small
-- pointers. A render is *valid* while its captured source identity (drive_version + checksum)
-- still matches the material — the same identity landing-promotion checks — so a replaced
-- landing never shows a stale render as current.
--
-- Reads are caller-checked ('view'); writes/commits are service-only. The table is NOT added to
-- supabase_realtime, so artifact_root can never leak over Realtime; the gallery is refreshed via
-- the existing public.team_catalog_events channel (an 'upserted' event on commit/stale).

create table public.team_landing_renders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  material_id uuid not null,
  preset text not null default 'default',
  source_version text,
  source_checksum text,
  fingerprint text,
  render_state text not null default 'rendering',
  failure_reason text,
  artifact_root text,
  segment_count integer not null default 0,
  rendered_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_landing_renders_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete cascade,
  constraint team_landing_renders_preset_check check (char_length(preset) between 1 and 64),
  constraint team_landing_renders_state_check check (
    render_state in ('rendering', 'ready', 'stale', 'failed')
  ),
  constraint team_landing_renders_failure_check check (
    failure_reason is null
    or failure_reason in ('unsupported', 'corrupt', 'protected', 'too_large', 'render_error')
  ),
  constraint team_landing_renders_segment_check check (segment_count >= 0),
  constraint team_landing_renders_ready_shape_check check (
    render_state <> 'ready' or (artifact_root is not null and segment_count >= 1)
  ),
  constraint team_landing_renders_fingerprint_check check (
    fingerprint is null or fingerprint ~ '^[a-f0-9]{64}$'
  )
);

create unique index team_landing_renders_unique_idx
  on public.team_landing_renders (team_id, material_id, preset);
create index team_landing_renders_ready_idx
  on public.team_landing_renders (team_id, material_id)
  where render_state = 'ready';

alter table public.team_landing_renders enable row level security;
alter table public.team_landing_renders force row level security;
revoke all on table public.team_landing_renders from public, anon, authenticated;
-- No client policy: every access path is a security-definer function below (owned by the
-- migration superuser, so it bypasses RLS); direct authenticated/anon/service_role access is
-- denied. artifact_root is never returned to clients — only the service render path reads it.

comment on table public.team_landing_renders is
  'Feature 004 shared landing render cache pointers; view-read via RPC, service-only writes, '
  'artifacts stored in the connected Drive and never published to Realtime.';

-- ---------------------------------------------------------------------------
-- Caller-checked read: valid render pointers for a set of landing materials.
-- `valid` is computed against the material's *current* source identity, so a stale row can
-- never be reported as a ready render (SC-004 / FR-006).
-- ---------------------------------------------------------------------------
create or replace function public.list_landing_renders(
  p_team uuid,
  p_material_ids uuid[],
  p_preset text
)
returns table (
  material_id uuid,
  render_state text,
  valid boolean,
  preset text,
  segment_count integer,
  failure_reason text,
  source_version text,
  source_checksum text,
  fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select render.material_id,
         render.render_state,
         (
           render.render_state = 'ready'
           and render.artifact_root is not null
           and render.segment_count >= 1
           and render.source_version is not distinct from material.drive_version
           and render.source_checksum is not distinct from material.checksum
         ) as valid,
         render.preset,
         render.segment_count,
         render.failure_reason,
         render.source_version,
         render.source_checksum,
         render.fingerprint
  from public.team_landing_renders as render
  join public.team_materials as material
    on material.id = render.material_id
   and material.team_id = render.team_id
  where render.team_id = p_team
    and render.material_id = any (p_material_ids)
    and render.preset = p_preset;
end;
$$;

revoke all on function public.list_landing_renders(uuid, uuid[], text)
from public, anon, authenticated, service_role;
grant execute on function public.list_landing_renders(uuid, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Service-only: begin (or restart) a render for the current source identity.
-- Actor must still hold 'view'; producing a shared render is a viewer capability.
-- ---------------------------------------------------------------------------
create or replace function public.service_start_landing_render(
  p_team uuid,
  p_material uuid,
  p_actor uuid,
  p_preset text,
  p_source_version text,
  p_source_checksum text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  render_id uuid;
begin
  if not private.can(p_team, 'view', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- Only for a real, active landing/archive candidate in this team.
  if not exists (
    select 1
    from public.team_materials as material
    where material.id = p_material
      and material.team_id = p_team
      and material.kind = 'file'
      and material.lifecycle = 'active'
      and material.category in ('archive', 'landing')
  ) then
    raise exception 'MATERIAL_NOT_ELIGIBLE' using errcode = 'P0002';
  end if;
  insert into public.team_landing_renders as render (
    team_id, material_id, preset, source_version, source_checksum,
    render_state, failure_reason, artifact_root, segment_count, rendered_by, updated_at
  )
  values (
    p_team, p_material, p_preset, p_source_version, p_source_checksum,
    'rendering', null, null, 0, p_actor, clock_timestamp()
  )
  on conflict (team_id, material_id, preset) do update
    set source_version = excluded.source_version,
        source_checksum = excluded.source_checksum,
        render_state = 'rendering',
        failure_reason = null,
        artifact_root = null,
        segment_count = 0,
        rendered_by = excluded.rendered_by,
        updated_at = clock_timestamp()
  returning render.id into render_id;
  return render_id;
end;
$$;

revoke all on function public.service_start_landing_render(uuid, uuid, uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_start_landing_render(uuid, uuid, uuid, text, text, text)
to service_role;

-- ---------------------------------------------------------------------------
-- Service-only: commit a finished render. Re-checks that the captured source identity still
-- matches the material's current identity; if it moved mid-render, the render is committed as
-- 'stale' (never surfaced as ready). Emits a catalog event so other members refetch.
-- ---------------------------------------------------------------------------
create or replace function public.service_commit_landing_render(
  p_render uuid,
  p_artifact_root text,
  p_segment_count integer,
  p_fingerprint text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  final_state text;
  render_team uuid;
  render_material uuid;
  identity_ok boolean;
begin
  if p_segment_count is null or p_segment_count < 1 or p_artifact_root is null then
    raise exception 'INVALID_RENDER_ARTIFACT' using errcode = '22023';
  end if;
  select render.team_id,
         render.material_id,
         (render.source_version is not distinct from material.drive_version
          and render.source_checksum is not distinct from material.checksum)
    into render_team, render_material, identity_ok
  from public.team_landing_renders as render
  join public.team_materials as material
    on material.id = render.material_id
   and material.team_id = render.team_id
  where render.id = p_render
  for update of render;

  if render_team is null then
    raise exception 'RENDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  final_state := case when identity_ok then 'ready' else 'stale' end;

  update public.team_landing_renders as render
  set render_state = final_state,
      artifact_root = case when identity_ok then p_artifact_root else null end,
      segment_count = case when identity_ok then p_segment_count else 0 end,
      fingerprint = case when identity_ok then p_fingerprint else render.fingerprint end,
      failure_reason = null,
      updated_at = clock_timestamp()
  where render.id = p_render;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (render_team, render_material, 'upserted');

  return final_state;
end;
$$;

revoke all on function public.service_commit_landing_render(uuid, text, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_landing_render(uuid, text, integer, text)
to service_role;

-- ---------------------------------------------------------------------------
-- Service-only: record a typed render failure.
-- ---------------------------------------------------------------------------
create or replace function public.service_fail_landing_render(
  p_render uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reason is null
     or p_reason not in ('unsupported', 'corrupt', 'protected', 'too_large', 'render_error') then
    raise exception 'INVALID_FAILURE_REASON' using errcode = '22023';
  end if;
  update public.team_landing_renders as render
  set render_state = 'failed',
      failure_reason = p_reason,
      artifact_root = null,
      segment_count = 0,
      updated_at = clock_timestamp()
  where render.id = p_render;
end;
$$;

revoke all on function public.service_fail_landing_render(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_fail_landing_render(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Service-only: mark a material's renders stale on source change/removal (catalog-sync).
-- Returns the number of rows affected and emits a catalog event so the gallery refetches.
-- ---------------------------------------------------------------------------
create or replace function public.service_mark_landing_renders_stale(
  p_team uuid,
  p_material uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.team_landing_renders as render
  set render_state = 'stale',
      artifact_root = null,
      segment_count = 0,
      updated_at = clock_timestamp()
  where render.team_id = p_team
    and render.material_id = p_material
    and render.render_state <> 'stale';
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (p_team, p_material, 'upserted');
  end if;
  return affected;
end;
$$;

revoke all on function public.service_mark_landing_renders_stale(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_mark_landing_renders_stale(uuid, uuid) to service_role;
