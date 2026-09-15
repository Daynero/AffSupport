-- Feature 023 (delivery 2) — re-stitched videos behind the catalogs.
--
-- With re-stitching on, one computer in the space keeps a spare re-stitched copy of every catalog's
-- video ready next to it. At each round the worker points the sheet's video column at the spare, the
-- spare becomes the copy in use, the copy used before is deleted for good, and the computer is asked
-- for the next spare. Only one spare per catalog ever waits; stopping deletes the spares and leaves
-- each sheet on the copy it points at.
--
-- What this adds:
--   team_updater_devices             the computer that re-stitches for a space (hashed secret)
--   team_catalog_restitch_copies     spare / in-use / retired copies per catalog
--   private.catalog_restitch_jobs    one per catalog that needs a spare; leased by the device
--   private.catalog_restitch_operations  which process operations the updater started
--   team_product_catalogs.current_video_link  the in-use copy's link
--   enroll / revoke device RPCs; save_team_catalog_updater accepts restitch
--   device claim / bind / heartbeat / complete / fail, the finalize hook, the round swap, and the
--   deletion queue for retired copies — all service-role only
--
-- The device secret is generated here and returned once; only its SHA-256 is stored. Every claim
-- re-checks that the enrolling member may still process in the space.
-- Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- Tables.

alter table public.team_product_catalogs
  add column if not exists current_video_link text;

grant select (current_video_link) on public.team_product_catalogs to authenticated;

create table public.team_updater_devices (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  -- Grants for the device's work are minted as this member, and only while they may still process.
  actor_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  secret_hash bytea not null,
  build text,
  tool_contracts jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint team_updater_devices_label_check check (char_length(label) between 1 and 120),
  constraint team_updater_devices_hash_check check (octet_length(secret_hash) = 32)
);

-- One computer re-stitches for a space at a time.
create unique index team_updater_devices_active_idx
  on public.team_updater_devices (team_id) where revoked_at is null;

create table public.team_catalog_restitch_copies (
  material_id uuid primary key references public.team_materials(id) on delete cascade,
  catalog_material_id uuid not null
    references public.team_product_catalogs(material_id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  role text not null,
  drive_file_id text not null,
  shared_link text,
  operation_id uuid,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  delete_attempts integer not null default 0,
  next_delete_at timestamptz,
  constraint team_catalog_restitch_copies_role_check
    check (role in ('spare', 'in_use', 'retired')),
  -- A copy a sheet points at, or may point at next, always has a link to point with.
  constraint team_catalog_restitch_copies_link_check
    check (role = 'retired' or shared_link is not null),
  constraint team_catalog_restitch_copies_retired_check
    check ((role = 'retired') = (retired_at is not null))
);

create unique index team_catalog_restitch_copies_role_idx
  on public.team_catalog_restitch_copies (catalog_material_id, role)
  where role in ('spare', 'in_use');
create index team_catalog_restitch_copies_retired_idx
  on public.team_catalog_restitch_copies (next_delete_at)
  where role = 'retired';

create table private.catalog_restitch_jobs (
  catalog_material_id uuid primary key
    references public.team_product_catalogs(material_id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  state text not null default 'queued',
  device_id uuid references public.team_updater_devices(id) on delete set null,
  operation_id uuid,
  lease_token_hash bytea,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  constraint catalog_restitch_jobs_state_check check (state in ('queued', 'leased')),
  constraint catalog_restitch_jobs_lease_check
    check ((state = 'leased') = (lease_token_hash is not null and lease_expires_at is not null)),
  constraint catalog_restitch_jobs_error_check
    check (last_error_code is null or last_error_code ~ '^[A-Z_]{2,64}$')
);

create index catalog_restitch_jobs_team_idx on private.catalog_restitch_jobs (team_id);

-- Outlives a cancelled job, so an operation that finishes after a stop is still recognised as the
-- updater's — and its copy deleted rather than left behind.
create table private.catalog_restitch_operations (
  operation_id uuid primary key,
  catalog_material_id uuid not null,
  team_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.team_updater_devices enable row level security;
alter table public.team_updater_devices force row level security;
alter table public.team_catalog_restitch_copies enable row level security;
alter table public.team_catalog_restitch_copies force row level security;
alter table private.catalog_restitch_jobs enable row level security;
alter table private.catalog_restitch_jobs force row level security;
alter table private.catalog_restitch_operations enable row level security;
alter table private.catalog_restitch_operations force row level security;

-- The device row holds the secret's hash: nothing in a browser reads it; the dialog reads a
-- projection through catalog_updater_state.
revoke all on public.team_updater_devices from anon, authenticated;
revoke all on public.team_catalog_restitch_copies from anon, authenticated;
revoke all on private.catalog_restitch_jobs from public, anon, authenticated;
revoke all on private.catalog_restitch_operations from public, anon, authenticated;

grant select (material_id, catalog_material_id, team_id, role, created_at)
  on public.team_catalog_restitch_copies to authenticated;

create policy team_catalog_restitch_copies_select_team
on public.team_catalog_restitch_copies for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- Helpers.

create or replace function private.restitch_contract_ok(p_contracts jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_contracts -> 'teamUpdaterRestitch') = 'number'
      then (p_contracts ->> 'teamUpdaterRestitch')::numeric >= 1
    else false
  end;
$$;

-- The space's re-stitching computer, if one is enrolled.
create or replace function private.active_updater_device(p_team uuid)
returns public.team_updater_devices
language sql
security definer
set search_path = ''
stable
as $$
  select device.* from public.team_updater_devices as device
  where device.team_id = p_team and device.revoked_at is null
  limit 1;
$$;

create or replace function private.updater_device_online(p_device public.team_updater_devices)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_device.id is not null
     and p_device.revoked_at is null
     and p_device.last_seen_at > clock_timestamp() - interval '2 minutes';
$$;

-- A job for every catalog in a re-stitching updater that has no spare and no job yet.
create or replace function private.queue_restitch_jobs(p_team uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.team_id = p_team and updater.state = 'running' and updater.restitch
  ) then return; end if;
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  where item.team_id = p_team
    and not exists (
      select 1 from public.team_catalog_restitch_copies as copy
      where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
    )
  on conflict (catalog_material_id) do nothing;
end;
$$;

/*
 * Cancels the work and retires the spares of catalogs that no longer re-stitch: every catalog of
 * the space when `p_keep` is null, otherwise those not in `p_keep`. In-use copies stay — a sheet
 * still points at them.
 */
create or replace function private.retire_restitch_spares(p_team uuid, p_keep uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.catalog_restitch_jobs as job
  where job.team_id = p_team
    and (p_keep is null or not (job.catalog_material_id = any(p_keep)));
  update public.team_catalog_restitch_copies as copy
     set role = 'retired',
         retired_at = clock_timestamp(),
         next_delete_at = clock_timestamp() + interval '2 minutes'
   where copy.team_id = p_team
     and copy.role = 'spare'
     and (p_keep is null or not (copy.catalog_material_id = any(p_keep)));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The updater's state, now with the device and the spares.

create or replace function private.catalog_updater_state(p_team uuid)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'state', coalesce(updater.state, 'stopped'),
    'interval', coalesce(updater.update_interval, '1h'),
    'restitch', coalesce(updater.restitch, false),
    'nextRunAt', updater.next_run_at,
    'startedAt', updater.started_at,
    'catalogCount', (
      select count(*) from public.team_catalog_updater_items as item where item.team_id = p_team
    ),
    'failingCount', (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_product_catalogs as record
        on record.material_id = item.catalog_material_id
      where item.team_id = p_team
        and item.attempts >= 3
        and record.last_update_error is not null
    ),
    'spareReadyCount', case when coalesce(updater.restitch, false) then (
      select count(*)
      from public.team_catalog_updater_items as item
      join public.team_catalog_restitch_copies as copy
        on copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
      where item.team_id = p_team
    ) end,
    'device', (
      select jsonb_build_object(
        'id', device.id,
        'label', device.label,
        'online', private.updater_device_online(device),
        'tooOld', not private.restitch_contract_ok(device.tool_contracts),
        'lastSeenAt', device.last_seen_at
      )
      from public.team_updater_devices as device
      where device.team_id = p_team and device.revoked_at is null
    ),
    'serverNow', clock_timestamp()
  )
  from (select 1) as anchor
  left join public.team_catalog_updaters as updater on updater.team_id = p_team;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client RPCs.

/*
 * Makes the caller's computer the space's re-stitching computer and returns its secret once. The
 * web hands the secret straight to the local app; only its hash is kept.
 */
create or replace function public.enroll_team_updater_device(
  p_team uuid,
  p_label text,
  p_build text,
  p_contracts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
  created uuid;
  v_label text := left(btrim(coalesce(p_label, '')), 120);
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if v_label = '' or jsonb_typeof(coalesce(p_contracts, 'null'::jsonb)) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not private.restitch_contract_ok(p_contracts) then
    raise exception 'AGENT_UPDATE_REQUIRED' using errcode = '22023';
  end if;

  update public.team_updater_devices as device
     set revoked_at = clock_timestamp()
   where device.team_id = p_team and device.revoked_at is null;

  -- Two v4 UUIDs: 244 random bits from the server's strong generator.
  secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.team_updater_devices (
    team_id, actor_id, label, secret_hash, build, tool_contracts, last_seen_at
  )
  values (
    p_team, auth.uid(), v_label, sha256(convert_to(secret, 'UTF8')),
    left(p_build, 80), p_contracts, clock_timestamp()
  )
  returning id into created;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return jsonb_build_object('deviceId', created, 'secret', secret);
end;
$$;

create or replace function public.revoke_team_updater_device(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_updater_devices as device
     set revoked_at = clock_timestamp()
   where device.team_id = p_team and device.revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return private.catalog_updater_state(p_team);
end;
$$;

create or replace function public.save_team_catalog_updater(
  p_team uuid,
  p_catalogs uuid[],
  p_interval text,
  p_restitch boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
  current_row public.team_catalog_updaters%rowtype;
  device public.team_updater_devices;
  v_restitch boolean := coalesce(p_restitch, false);
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct catalog), '{}') into wanted
  from unnest(coalesce(p_catalogs, '{}')) as catalog
  where catalog is not null;
  if p_interval is null
     or private.catalog_updater_interval(p_interval) is null
     or cardinality(wanted) = 0
     or cardinality(wanted) > 2000
     or exists (
       select 1 from unnest(wanted) as catalog
       where catalog not in (
         select live.catalog_material_id from private.live_product_catalogs(p_team) as live
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  select * into current_row from public.team_catalog_updaters
  where team_id = p_team for update;

  -- Turning re-stitching on needs a computer that is there and new enough. Keeping it on does not:
  -- a computer that went offline must not block a change of interval or catalogs.
  if v_restitch and not current_row.restitch then
    device := private.active_updater_device(p_team);
    if device.id is null or not private.updater_device_online(device) then
      raise exception 'AGENT_REQUIRED' using errcode = '22023';
    end if;
    if not private.restitch_contract_ok(device.tool_contracts) then
      raise exception 'AGENT_UPDATE_REQUIRED' using errcode = '22023';
    end if;
  end if;

  update public.team_catalog_updaters as updater
     set state = 'running',
         update_interval = p_interval,
         restitch = v_restitch,
         next_run_at = case
           when current_row.state <> 'running' or current_row.update_interval <> p_interval
             then clock_timestamp() + private.catalog_updater_interval(p_interval)
           else current_row.next_run_at
         end,
         started_at = case
           when current_row.state <> 'running' then clock_timestamp()
           else current_row.started_at
         end,
         started_by = case
           when current_row.state <> 'running' then auth.uid()
           else current_row.started_by
         end,
         updated_by = auth.uid(),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and not (item.catalog_material_id = any(wanted));
  insert into public.team_catalog_updater_items (catalog_material_id, team_id)
  select catalog, p_team from unnest(wanted) as catalog
  on conflict (catalog_material_id) do nothing;

  perform private.retire_restitch_spares(p_team, case when v_restitch then wanted end);
  perform private.queue_restitch_jobs(p_team);

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return private.catalog_updater_state(p_team);
end;
$$;

create or replace function public.stop_team_catalog_updater(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_catalog_updaters as updater
     set state = 'stopped',
         next_run_at = null,
         updated_by = auth.uid(),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;
  delete from public.team_catalog_updater_items as item where item.team_id = p_team;
  perform private.retire_restitch_spares(p_team, null);
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return private.catalog_updater_state(p_team);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The device's side (drive-ops, authenticated by the device secret's hash).

/*
 * The device the hash belongs to, still enrolled, whose member may still process. Refuses
 * otherwise. Records the contact, so the dialog can say the computer is there.
 */
create or replace function private.authenticate_updater_device(
  p_device uuid, p_secret_hash bytea, p_build text, p_contracts jsonb
)
returns public.team_updater_devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  device public.team_updater_devices;
begin
  select * into device from public.team_updater_devices as candidate
  where candidate.id = p_device
    and candidate.revoked_at is null
    and candidate.secret_hash = p_secret_hash
  for update;
  if device.id is null or not private.can(device.team_id, 'process', device.actor_id) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_updater_devices as candidate
     set last_seen_at = clock_timestamp(),
         build = coalesce(left(p_build, 80), candidate.build),
         tool_contracts = case
           when jsonb_typeof(p_contracts) = 'object' then p_contracts
           else candidate.tool_contracts
         end
   where candidate.id = device.id
  returning * into device;
  return device;
end;
$$;

/*
 * Leases the next spare to prepare. Returns null when there is nothing to do, or the job with
 * everything drive-ops needs to start the process as the device's member.
 */
create or replace function public.service_claim_restitch_job(
  p_device uuid,
  p_secret_hash bytea,
  p_build text,
  p_contracts jsonb,
  p_lease_token_hash bytea,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  device public.team_updater_devices;
  claimed private.catalog_restitch_jobs;
  result jsonb;
begin
  device := private.authenticate_updater_device(p_device, p_secret_hash, p_build, p_contracts);
  if not private.restitch_contract_ok(device.tool_contracts)
     or p_lease_token_hash is null or octet_length(p_lease_token_hash) <> 32 then
    return null;
  end if;
  -- One at a time per computer: its own lease still running means it is still working.
  if exists (
    select 1 from private.catalog_restitch_jobs as job
    where job.device_id = device.id and job.state = 'leased'
      and job.lease_expires_at > clock_timestamp()
  ) then return null; end if;

  select job.* into claimed
  from private.catalog_restitch_jobs as job
  join public.team_catalog_updaters as updater on updater.team_id = job.team_id
  join public.team_catalog_updater_items as item
    on item.catalog_material_id = job.catalog_material_id
  where job.team_id = device.team_id
    and updater.state = 'running' and updater.restitch
    and job.next_attempt_at <= clock_timestamp()
    and (job.state = 'queued' or job.lease_expires_at <= clock_timestamp())
    and exists (
      select 1 from private.live_product_catalogs(job.team_id) as live
      where live.catalog_material_id = job.catalog_material_id
    )
  order by job.next_attempt_at, job.created_at
  for update of job skip locked
  limit 1;
  if claimed.catalog_material_id is null then return null; end if;

  update private.catalog_restitch_jobs as job
     set state = 'leased',
         device_id = device.id,
         operation_id = null,
         lease_token_hash = p_lease_token_hash,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)),
         attempts = job.attempts + 1
   where job.catalog_material_id = claimed.catalog_material_id;

  select jsonb_build_object(
    'jobId', claimed.catalog_material_id,
    'teamId', claimed.team_id,
    'actorId', device.actor_id,
    'attempt', claimed.attempts + 1,
    'videoMaterialId', video.id,
    'videoName', video.name,
    'destinationFolderId', folder.id,
    'updateCount', record.update_count,
    -- In the shapes the agent's restitch delegate reads (shared `parseTeamRestitchDefaults` and
    -- `parseMaterialRestitchPrep`), which are the web's mapped rows.
    'defaults', (
      select jsonb_build_object(
        'operation', defaults.operation,
        'startImageIds', to_jsonb(defaults.start_image_ids),
        'endImageIds', to_jsonb(defaults.end_image_ids),
        'fitMode', defaults.fit_mode,
        'finalDurationMode', defaults.final_duration_mode,
        'customFinalDurationSeconds', defaults.custom_final_duration_seconds,
        'configured', defaults.configured,
        'updatedAt', defaults.updated_at,
        'updatedBy', defaults.updated_by
      )
      from public.team_restitch_defaults as defaults
      where defaults.team_id = claimed.team_id
    ),
    'prepared', (
      select jsonb_build_object(
        'materialId', prep.material_id,
        'driveVersion', prep.drive_version,
        'detectorVersion', prep.detector_version,
        'detectedStartSeconds', prep.detected_start_seconds,
        'detectedEndSeconds', prep.detected_end_seconds,
        'profile', prep.source_profile,
        'unsupportedReason', prep.unsupported_reason,
        'preparedAt', prep.prepared_at
      )
      from public.team_material_restitch_prep as prep
      where prep.material_id = video.id
        and prep.drive_version is not distinct from video.drive_version
    )
  ) into result
  from public.team_materials as sheet
  join public.team_materials as video on video.id = sheet.companion_of
  join public.team_product_catalogs as record on record.material_id = sheet.id
  left join public.team_materials as folder
    on folder.team_id = video.team_id
   and folder.drive_file_id = video.parent_folder_id
   and folder.kind = 'folder'
   and folder.lifecycle = 'active'
  where sheet.id = claimed.catalog_material_id;
  return result;
end;
$$;

-- The process drive-ops started for a leased job; remembered past the job's own life.
create or replace function public.service_bind_restitch_job_operation(
  p_job uuid, p_lease_token_hash bytea, p_operation uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
begin
  update private.catalog_restitch_jobs as job
     set operation_id = p_operation
   where job.catalog_material_id = p_job
     and job.state = 'leased'
     and job.lease_token_hash = p_lease_token_hash
  returning job.team_id into owning_team;
  if owning_team is null then return false; end if;
  insert into private.catalog_restitch_operations (operation_id, catalog_material_id, team_id)
  values (p_operation, p_job, owning_team)
  on conflict (operation_id) do nothing;
  return true;
end;
$$;

-- Renews a lease. True means stop: the job is gone (stopped, removed, re-stitching off) or lost.
create or replace function public.service_heartbeat_restitch_job(
  p_device uuid,
  p_secret_hash bytea,
  p_job uuid,
  p_lease_token_hash bytea,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  device public.team_updater_devices;
  renewed uuid;
begin
  device := private.authenticate_updater_device(p_device, p_secret_hash, null, null);
  update private.catalog_restitch_jobs as job
     set lease_expires_at = clock_timestamp()
       + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
    from public.team_catalog_updaters as updater
   where job.catalog_material_id = p_job
     and job.device_id = device.id
     and job.state = 'leased'
     and job.lease_token_hash = p_lease_token_hash
     and updater.team_id = job.team_id
     and updater.state = 'running'
     and updater.restitch
  returning job.catalog_material_id into renewed;
  return renewed is null;
end;
$$;

/*
 * The device's report. A failure backs the job off (1, 5, 15 minutes). Success itself is recorded
 * by the finalize hook; a job still leased after a reported success had its output refused, so it
 * is queued again. What the run discovered about the video is kept, like a member's preparation.
 */
create or replace function public.service_complete_restitch_job(
  p_device uuid,
  p_secret_hash bytea,
  p_job uuid,
  p_lease_token_hash bytea,
  p_outcome text,
  p_error text,
  p_discovered jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  device public.team_updater_devices;
  job private.catalog_restitch_jobs;
  video public.team_materials;
begin
  device := private.authenticate_updater_device(p_device, p_secret_hash, null, null);
  if p_outcome not in ('finalized', 'failed')
     or (p_error is not null and p_error !~ '^[A-Z_]{2,64}$') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if jsonb_typeof(p_discovered) = 'object' and jsonb_typeof(p_discovered -> 'profile') = 'object'
  then
    select candidate.* into video
    from public.team_materials as sheet
    join public.team_materials as candidate on candidate.id = sheet.companion_of
    where sheet.id = p_job and sheet.team_id = device.team_id;
    if video.id is not null and video.drive_version is not null then
      insert into public.team_material_restitch_prep as prep (
        material_id, team_id, drive_version, detector_version,
        detected_start_seconds, detected_end_seconds, source_profile, prepared_by
      )
      values (
        video.id, video.team_id, video.drive_version,
        greatest(0, coalesce((p_discovered ->> 'detectorVersion')::integer, 0)),
        greatest(0, coalesce((p_discovered ->> 'detectedStartSeconds')::numeric, 0)),
        greatest(0, coalesce((p_discovered ->> 'detectedEndSeconds')::numeric, 0)),
        p_discovered -> 'profile', device.actor_id
      )
      on conflict (material_id) do update
        set drive_version = excluded.drive_version,
            detector_version = excluded.detector_version,
            detected_start_seconds = excluded.detected_start_seconds,
            detected_end_seconds = excluded.detected_end_seconds,
            source_profile = excluded.source_profile,
            unsupported_reason = null,
            prepared_at = clock_timestamp(),
            prepared_by = excluded.prepared_by;
    end if;
  end if;

  select * into job from private.catalog_restitch_jobs as candidate
  where candidate.catalog_material_id = p_job
    and candidate.device_id = device.id
    and candidate.state = 'leased'
    and candidate.lease_token_hash = p_lease_token_hash
  for update;
  if job.catalog_material_id is null then return false; end if;

  update private.catalog_restitch_jobs as candidate
     set state = 'queued',
         lease_token_hash = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp() + case
           when job.attempts <= 1 then interval '1 minute'
           when job.attempts = 2 then interval '5 minutes'
           else interval '15 minutes'
         end,
         last_error_code = case
           when p_outcome = 'failed' then coalesce(p_error, 'PROCESS_FAILED')
           else 'STALE_RESULT'
         end
   where candidate.catalog_material_id = p_job;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (job.team_id, p_job, 'upserted');
  return true;
end;
$$;

/*
 * Called by drive-ops once a restitch output is committed as a material. Returns what became of it:
 *   'spare'   the catalog's new spare (the job is done)
 *   'retired' the updater started it but no longer wants it — queued for deletion
 *   'none'    not the updater's operation
 * A null link means sharing failed; the copy is then retired and the job tried again.
 */
create or replace function public.service_record_restitch_output(
  p_operation uuid, p_material uuid, p_drive_file_id text, p_shared_link text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  started private.catalog_restitch_operations;
  job private.catalog_restitch_jobs;
begin
  select * into started from private.catalog_restitch_operations as candidate
  where candidate.operation_id = p_operation;
  if started.operation_id is null then return 'none'; end if;

  select * into job from private.catalog_restitch_jobs as candidate
  where candidate.catalog_material_id = started.catalog_material_id
    and candidate.operation_id = p_operation
    and candidate.state = 'leased'
  for update;

  if job.catalog_material_id is not null
     and p_shared_link is not null
     and exists (
       select 1 from public.team_catalog_updaters as updater
       join public.team_catalog_updater_items as item on item.team_id = updater.team_id
       where updater.team_id = job.team_id and updater.state = 'running' and updater.restitch
         and item.catalog_material_id = job.catalog_material_id
     )
     and not exists (
       select 1 from public.team_catalog_restitch_copies as copy
       where copy.catalog_material_id = job.catalog_material_id and copy.role = 'spare'
     ) then
    insert into public.team_catalog_restitch_copies (
      material_id, catalog_material_id, team_id, role, drive_file_id, shared_link, operation_id
    )
    values (
      p_material, job.catalog_material_id, job.team_id, 'spare', p_drive_file_id, p_shared_link,
      p_operation
    )
    on conflict (material_id) do nothing;
    delete from private.catalog_restitch_jobs as candidate
    where candidate.catalog_material_id = job.catalog_material_id;
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (job.team_id, job.catalog_material_id, 'upserted');
    return 'spare';
  end if;

  insert into public.team_catalog_restitch_copies (
    material_id, catalog_material_id, team_id, role, drive_file_id, shared_link, operation_id,
    retired_at, next_delete_at
  )
  select p_material, started.catalog_material_id, started.team_id, 'retired', p_drive_file_id,
         p_shared_link, p_operation, clock_timestamp(), clock_timestamp()
  where exists (
    select 1 from public.team_product_catalogs as record
    where record.material_id = started.catalog_material_id
  )
  on conflict (material_id) do nothing;
  return 'retired';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The worker's side: the claim carries the copy to swap to, completion swaps, retired copies go.

drop function if exists public.service_claim_catalog_updater_items(text, integer, integer);

create or replace function public.service_claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  catalog_material_id uuid,
  team_id uuid,
  attempts integer,
  update_count integer,
  product_count smallint,
  source_link text,
  video_link text,
  settings_snapshot jsonb,
  drive_file_id text,
  resource_key text,
  credential_id uuid,
  current_video_link text,
  spare_material_id uuid,
  spare_link text
)
language sql
security definer
set search_path = ''
as $$
  select item.catalog_material_id,
         item.team_id,
         item.attempts,
         record.update_count,
         record.product_count,
         record.source_link,
         record.video_link,
         record.settings_snapshot,
         sheet.drive_file_id,
         sheet.resource_key,
         connection.credential_id,
         record.current_video_link,
         spare.material_id,
         spare.shared_link
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  join public.team_drive_connections as connection on connection.id = sheet.connection_id
  left join public.team_catalog_updaters as updater on updater.team_id = item.team_id
  left join lateral (
    select copy.material_id, copy.shared_link
    from public.team_catalog_restitch_copies as copy
    join public.team_materials as file on file.id = copy.material_id
    where updater.restitch
      and copy.catalog_material_id = item.catalog_material_id
      and copy.role = 'spare'
      and file.lifecycle = 'active'
  ) as spare on true
  where connection.state in ('connected', 'unavailable');
$$;

drop function if exists public.service_complete_catalog_update(uuid, text, integer);

create or replace function public.service_complete_catalog_update(
  p_item uuid, p_worker text, p_update_count integer, p_swapped_copy uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
  swapped public.team_catalog_restitch_copies;
begin
  update public.team_catalog_updater_items as item
     set round_due_at = null,
         attempts = 0,
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp()
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id into owning_team;
  if owning_team is null then return false; end if;

  update public.team_product_catalogs as record
     set update_count = greatest(record.update_count, p_update_count),
         last_updated_at = clock_timestamp(),
         last_update_error = null
   where record.material_id = p_item
     and p_update_count between record.update_count and record.update_count + 1;

  -- The sheet now points at this copy, whatever happened to it meanwhile: a spare retired by a stop
  -- during the round is brought back rather than deleted from under the sheet.
  if p_swapped_copy is not null then
    select * into swapped from public.team_catalog_restitch_copies as copy
    where copy.material_id = p_swapped_copy and copy.catalog_material_id = p_item
      and copy.role in ('spare', 'retired') and copy.shared_link is not null
    for update;
    if swapped.material_id is not null then
      update public.team_catalog_restitch_copies as copy
         set role = 'retired',
             retired_at = clock_timestamp(),
             next_delete_at = clock_timestamp()
       where copy.catalog_material_id = p_item and copy.role = 'in_use';
      update public.team_catalog_restitch_copies as copy
         set role = 'in_use', retired_at = null, next_delete_at = null
       where copy.material_id = swapped.material_id;
      update public.team_product_catalogs as record
         set current_video_link = swapped.shared_link
       where record.material_id = p_item;
      perform private.queue_restitch_jobs(owning_team);
    end if;
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (owning_team, p_item, 'upserted');
  return true;
end;
$$;

/*
 * Retired copies whose deletion is due, leased for five minutes. A copy retired by a stop waits two
 * minutes first, longer than a round's lease, so a round that already wrote its link can claim it
 * back (above).
 */
create or replace function public.service_claim_retired_restitch_copies(p_limit integer default 10)
returns table (material_id uuid, team_id uuid, drive_file_id text, credential_id uuid)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select copy.material_id
    from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
    order by copy.next_delete_at
    for update of copy skip locked
    limit least(greatest(p_limit, 1), 50)
  ), leased as (
    update public.team_catalog_restitch_copies as copy
       set next_delete_at = clock_timestamp() + interval '5 minutes',
           delete_attempts = copy.delete_attempts + 1
      from due
     where copy.material_id = due.material_id
    returning copy.material_id, copy.team_id, copy.drive_file_id
  )
  select leased.material_id, leased.team_id, leased.drive_file_id, connection.credential_id
  from leased
  join public.team_materials as file on file.id = leased.material_id
  join public.team_drive_connections as connection on connection.id = file.connection_id;
$$;

/*
 * A retired copy is gone from Drive (or given up on after five tries): the record goes, and the
 * material reads as missing, the way a file deleted outside the product does.
 */
create or replace function public.service_forget_restitch_copy(p_material uuid, p_deleted boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  copy public.team_catalog_restitch_copies;
begin
  select * into copy from public.team_catalog_restitch_copies as candidate
  where candidate.material_id = p_material and candidate.role = 'retired'
  for update;
  if copy.material_id is null then return false; end if;
  if not p_deleted and copy.delete_attempts < 5 then return false; end if;
  delete from public.team_catalog_restitch_copies as candidate
  where candidate.material_id = p_material;
  if p_deleted then
    update public.team_materials as file
       set lifecycle = 'missing', missing_at = clock_timestamp()
     where file.id = p_material and file.lifecycle = 'active';
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (copy.team_id, p_material, 'tombstoned');
  end if;
  return true;
end;
$$;

create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1 from public.team_catalog_updaters as updater
    where updater.state = 'running' and updater.next_run_at <= clock_timestamp()
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_updaters as updater on updater.team_id = item.team_id
    where updater.state = 'running'
      and item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  then return null; end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants.

revoke all on function private.restitch_contract_ok(jsonb) from public;
revoke all on function private.active_updater_device(uuid) from public;
revoke all on function private.updater_device_online(public.team_updater_devices) from public;
revoke all on function private.queue_restitch_jobs(uuid) from public;
revoke all on function private.retire_restitch_spares(uuid, uuid[]) from public;
revoke all on function private.authenticate_updater_device(uuid, bytea, text, jsonb) from public;

revoke all on function public.enroll_team_updater_device(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.revoke_team_updater_device(uuid) from public, anon, authenticated;
revoke all on function public.service_claim_restitch_job(uuid, bytea, text, jsonb, bytea, integer)
  from public, anon, authenticated;
revoke all on function public.service_bind_restitch_job_operation(uuid, bytea, uuid)
  from public, anon, authenticated;
revoke all on function public.service_heartbeat_restitch_job(uuid, bytea, uuid, bytea, integer)
  from public, anon, authenticated;
revoke all on function
  public.service_complete_restitch_job(uuid, bytea, uuid, bytea, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.service_record_restitch_output(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.service_complete_catalog_update(uuid, text, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.service_claim_retired_restitch_copies(integer)
  from public, anon, authenticated;
revoke all on function public.service_forget_restitch_copy(uuid, boolean)
  from public, anon, authenticated;

grant execute on function public.enroll_team_updater_device(uuid, text, text, jsonb)
  to authenticated;
grant execute on function public.revoke_team_updater_device(uuid) to authenticated;
grant execute on function public.service_claim_restitch_job(uuid, bytea, text, jsonb, bytea, integer)
  to service_role;
grant execute on function public.service_bind_restitch_job_operation(uuid, bytea, uuid)
  to service_role;
grant execute on function public.service_heartbeat_restitch_job(uuid, bytea, uuid, bytea, integer)
  to service_role;
grant execute on function
  public.service_complete_restitch_job(uuid, bytea, uuid, bytea, text, text, jsonb)
  to service_role;
grant execute on function public.service_record_restitch_output(uuid, uuid, text, text)
  to service_role;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;
grant execute on function public.service_complete_catalog_update(uuid, text, integer, uuid)
  to service_role;
grant execute on function public.service_claim_retired_restitch_copies(integer) to service_role;
grant execute on function public.service_forget_restitch_copy(uuid, boolean) to service_role;
