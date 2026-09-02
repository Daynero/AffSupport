-- Feature 015 — re-stitch defaults and prepared materials in the team space.
--
-- Three tables and four functions. The shape is `team_share_preferences`': RLS on, direct
-- writes revoked, every client path through a `security definer` function that derives the
-- caller from `auth.uid()` and re-checks the effective permission through `private.can`.
--
-- What each table is for:
--   team_restitch_defaults      one answer per space, changed by whoever manages it
--   team_material_restitch_prep what was found in one material's bytes, written by the web
--                               from what a member's agent reported
--   team_workspace_folders      where the space's Soty folder is, and the marker that finds
--                               it again after a rename or a move

create table public.team_restitch_defaults (
  team_id uuid primary key references public.teams(id) on delete cascade,
  operation text not null default 'restitch',
  start_image_ids uuid[] not null default '{}',
  end_image_ids uuid[] not null default '{}',
  fit_mode text not null default 'cover',
  final_duration_mode text not null default 'random-40-50',
  custom_final_duration_seconds integer not null default 2700,
  configured boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_restitch_defaults_operation_check
    check (operation in ('restitch', 'stitch', 'unstitch')),
  constraint team_restitch_defaults_fit_check
    check (fit_mode in ('cover', 'contain', 'stretch')),
  constraint team_restitch_defaults_duration_mode_check
    check (final_duration_mode in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')),
  -- The shared clamp is the rule; this check exists to stop a direct call, not to define it.
  constraint team_restitch_defaults_duration_check
    check (custom_final_duration_seconds between 1 and 359999)
);

create table public.team_material_restitch_prep (
  material_id uuid primary key references public.team_materials(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  -- The whole invalidation rule. A record describes a file's bytes, so it is true exactly as
  -- long as those bytes are, and a mismatch reads as "nothing prepared" rather than an error.
  drive_version text not null,
  detected_start_seconds numeric not null default 0,
  detected_end_seconds numeric not null default 0,
  -- Null exactly when the row is a refusal: there is nothing to cut, so there is nothing a
  -- cut would need to know.
  source_profile jsonb,
  unsupported_reason text,
  prepared_at timestamptz not null default now(),
  prepared_by uuid references auth.users(id) on delete set null,
  constraint team_material_restitch_prep_edges_check
    check (detected_start_seconds >= 0 and detected_end_seconds >= 0),
  constraint team_material_restitch_prep_profile_check
    check (source_profile is not null or unsupported_reason is not null)
);

create index team_material_restitch_prep_team_idx
  on public.team_material_restitch_prep (team_id, material_id);

create table public.team_workspace_folders (
  team_id uuid primary key references public.teams(id) on delete cascade,
  drive_folder_id text not null,
  -- What is written into the folder's own appProperties. The folder is found by this, never
  -- by its name: a rename or a move changes neither the id nor the marker.
  marker text not null,
  created_at timestamptz not null default now(),
  verified_at timestamptz not null default now()
);

-- Enabled *and* forced, like every other team table: without `force`, the table's owner is
-- exempt from its own policies, and `team-workspace.test.sql` checks for exactly that.
alter table public.team_restitch_defaults enable row level security;
alter table public.team_restitch_defaults force row level security;
alter table public.team_material_restitch_prep enable row level security;
alter table public.team_material_restitch_prep force row level security;
alter table public.team_workspace_folders enable row level security;
alter table public.team_workspace_folders force row level security;

revoke all on public.team_restitch_defaults from anon, authenticated;
revoke all on public.team_material_restitch_prep from anon, authenticated;
revoke all on public.team_workspace_folders from anon, authenticated;

grant select (
  team_id, operation, start_image_ids, end_image_ids, fit_mode,
  final_duration_mode, custom_final_duration_seconds, configured, updated_by, updated_at
) on public.team_restitch_defaults to authenticated;

grant select (
  material_id, team_id, drive_version, detected_start_seconds, detected_end_seconds,
  source_profile, unsupported_reason, prepared_at
) on public.team_material_restitch_prep to authenticated;

grant select (team_id, drive_folder_id, created_at, verified_at)
  on public.team_workspace_folders to authenticated;

-- Reading is membership; the marker is not readable by the client because nothing in the
-- browser needs it — only the edge function that resolves the folder does.
create policy team_restitch_defaults_select_team
on public.team_restitch_defaults for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_material_restitch_prep_select_team
on public.team_material_restitch_prep for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_workspace_folders_select_team
on public.team_workspace_folders for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create or replace function public.get_restitch_defaults(p_team uuid)
returns public.team_restitch_defaults
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  found public.team_restitch_defaults;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  select * into found from public.team_restitch_defaults where team_id = p_team;
  -- A space that was never configured has no row, and that is the same answer as a row
  -- saying it is not configured. The caller narrows both into one state.
  return found;
end;
$$;

create or replace function public.set_restitch_defaults(p_team uuid, p_defaults jsonb)
returns public.team_restitch_defaults
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation text := coalesce(p_defaults ->> 'operation', 'restitch');
  v_fit text := coalesce(p_defaults ->> 'fitMode', 'cover');
  v_mode text := coalesce(p_defaults ->> 'finalDurationMode', 'random-40-50');
  v_custom integer := coalesce((p_defaults ->> 'customFinalDurationSeconds')::integer, 2700);
  v_start uuid[] := coalesce(
    (select array_agg(value::uuid) from jsonb_array_elements_text(p_defaults -> 'startImageIds')),
    '{}'
  );
  v_end uuid[] := coalesce(
    (select array_agg(value::uuid) from jsonb_array_elements_text(p_defaults -> 'endImageIds')),
    '{}'
  );
  saved public.team_restitch_defaults;
begin
  -- Changing what a whole space does is a manage_metadata act, not an editing one.
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  if v_operation not in ('restitch', 'stitch', 'unstitch')
     or v_fit not in ('cover', 'contain', 'stretch')
     or v_mode not in ('random-30-40', 'random-40-50', 'random-50-60', 'custom')
     or v_custom < 1 or v_custom > 359999 then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  -- The one refusal that is about meaning rather than range: removing the stitching needs no
  -- photograph, everything else needs somewhere to draw one.
  if v_operation <> 'unstitch'
     and cardinality(v_start) = 0 and cardinality(v_end) = 0 then
    raise exception 'RESTITCH_NO_SCREENS' using errcode = '22023';
  end if;

  insert into public.team_restitch_defaults as d (
    team_id, operation, start_image_ids, end_image_ids, fit_mode,
    final_duration_mode, custom_final_duration_seconds, configured, updated_by, updated_at
  )
  values (
    p_team, v_operation, v_start, v_end, v_fit, v_mode, v_custom, true, auth.uid(), clock_timestamp()
  )
  on conflict (team_id) do update
    set operation = excluded.operation,
        start_image_ids = excluded.start_image_ids,
        end_image_ids = excluded.end_image_ids,
        fit_mode = excluded.fit_mode,
        final_duration_mode = excluded.final_duration_mode,
        custom_final_duration_seconds = excluded.custom_final_duration_seconds,
        configured = true,
        updated_by = excluded.updated_by,
        updated_at = clock_timestamp()
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.get_material_restitch_prep(p_team uuid, p_materials uuid[])
returns setof public.team_material_restitch_prep
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  -- Only records that still describe the material in front of the caller. A stale one is not
  -- an error and is not deleted — it simply is not returned, so a rollback finds it again.
  return query
    select prep.*
    from public.team_material_restitch_prep as prep
    join public.team_materials as material on material.id = prep.material_id
    where prep.team_id = p_team
      and prep.material_id = any(p_materials)
      and prep.drive_version is not distinct from material.drive_version;
end;
$$;

create or replace function public.set_material_restitch_prep(
  p_material uuid,
  p_drive_version text,
  p_prep jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.team_materials where id = p_material;
  if v_team is null then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  -- Writing what a run found is part of running a tool, so it is the `process` permission.
  if auth.uid() is null or not private.can(v_team, 'process', auth.uid()) then
    raise exception 'RESTITCH_FORBIDDEN' using errcode = '42501';
  end if;
  -- A servable material must carry a profile; a refusal carries none and needs none, and
  -- storing it is the whole point — the refusal is then never re-derived.
  if p_drive_version is null or p_drive_version = ''
     or (jsonb_typeof(p_prep -> 'profile') <> 'object'
         and coalesce(p_prep ->> 'unsupportedReason', '') = '') then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;

  insert into public.team_material_restitch_prep as prep (
    material_id, team_id, drive_version, detected_start_seconds, detected_end_seconds,
    source_profile, unsupported_reason, prepared_at, prepared_by
  )
  values (
    p_material, v_team, p_drive_version,
    coalesce((p_prep ->> 'detectedStartSeconds')::numeric, 0),
    coalesce((p_prep ->> 'detectedEndSeconds')::numeric, 0),
    case when jsonb_typeof(p_prep -> 'profile') = 'object' then p_prep -> 'profile' end,
    nullif(p_prep ->> 'unsupportedReason', ''),
    clock_timestamp(), auth.uid()
  )
  on conflict (material_id) do update
    set drive_version = excluded.drive_version,
        detected_start_seconds = excluded.detected_start_seconds,
        detected_end_seconds = excluded.detected_end_seconds,
        source_profile = excluded.source_profile,
        unsupported_reason = excluded.unsupported_reason,
        prepared_at = excluded.prepared_at,
        prepared_by = excluded.prepared_by;
  return true;
end;
$$;

/**
 * Where a space's Soty folder is, for the edge function that resolves it.
 *
 * Only the service role reads this: the marker is what finds the folder again after somebody
 * renames or moves it, and nothing in a browser has any use for it.
 */
create or replace function public.service_get_workspace_folder(p_team uuid)
returns table (drive_folder_id text, marker text)
language sql
stable
security definer
set search_path = ''
as $$
  select folder.drive_folder_id, folder.marker
  from public.team_workspace_folders as folder
  where folder.team_id = p_team;
$$;

revoke all on function public.service_get_workspace_folder(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_workspace_folder(uuid) to service_role;

/** Records the folder the edge function just proved or created. */
create or replace function public.service_commit_workspace_folder(
  p_team uuid,
  p_drive_folder_id text,
  p_marker text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_drive_folder_id is null or p_drive_folder_id = '' or p_marker is null or p_marker = '' then
    return false;
  end if;
  insert into public.team_workspace_folders as folder (team_id, drive_folder_id, marker)
  values (p_team, p_drive_folder_id, p_marker)
  on conflict (team_id) do update
    set drive_folder_id = excluded.drive_folder_id,
        marker = excluded.marker,
        verified_at = clock_timestamp();
  return true;
end;
$$;

revoke all on function public.service_commit_workspace_folder(uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_workspace_folder(uuid, text, text) to service_role;

-- Take PostgreSQL's default PUBLIC execute grant away before granting anything back.
--
-- This has to run *after* the functions exist: a loop over `pg_proc` placed above the
-- definitions matches nothing, silently leaves every function executable by `anon`, and the
-- only thing that catches it is a test that asks. Ours did.
do $$
declare
  feature_function record;
begin
  for feature_function in
    select p.oid::regprocedure::text as signature
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname like '%restitch%'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated', feature_function.signature
    );
  end loop;
end;
$$;

grant execute on function public.get_restitch_defaults(uuid) to authenticated;
grant execute on function public.set_restitch_defaults(uuid, jsonb) to authenticated;
grant execute on function public.get_material_restitch_prep(uuid, uuid[]) to authenticated;
grant execute on function public.set_material_restitch_prep(uuid, text, jsonb) to authenticated;
