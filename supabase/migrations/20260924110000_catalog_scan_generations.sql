-- A snapshot is a visibility boundary, not MAX(sequence) or a provider cursor.
-- Store the full transaction ID on the material itself so ON CONFLICT checks
-- the locked, current row even when a concurrent insert/update just committed.
alter table public.team_materials add column catalog_mutation_xid bigint not null
  default (pg_current_xact_id()::text::bigint);
create function private.stamp_catalog_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.catalog_mutation_xid := pg_current_xact_id()::text::bigint;
  return new;
end;
$$;
create trigger catalog_material_mutation before insert or update on public.team_materials
  for each row execute function private.stamp_catalog_mutation();
revoke all on function private.stamp_catalog_mutation() from public, anon, authenticated, service_role;

alter table private.catalog_sync_jobs add column scan_initialized boolean not null default false;
create table private.catalog_scan_generations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references private.catalog_sync_jobs(id) on delete cascade,
  parent_folder_id text not null,
  baseline_snapshot pg_snapshot not null default pg_current_snapshot(),
  state text not null default 'listing' check (state in ('listing', 'reconciling', 'done', 'abandoned')),
  coverage text not null default 'unknown' check (coverage in ('unknown', 'complete', 'partial', 'permission_limited')),
  page_token text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(job_id, id)
);
create table private.catalog_scan_frontier (
  job_id uuid not null references private.catalog_sync_jobs(id) on delete cascade,
  folder_id text not null,
  parent_folder_id text,
  generation uuid,
  state text not null default 'queued' check (state in ('queued', 'listing', 'reconciling', 'done')),
  ordinal bigint generated always as identity,
  primary key(job_id, folder_id),
  foreign key(job_id, generation) references private.catalog_scan_generations(job_id, id)
);
create index catalog_scan_frontier_pending on private.catalog_scan_frontier(job_id, state, ordinal);
create table private.catalog_scan_seen (
  job_id uuid not null,
  generation uuid not null,
  parent_folder_id text not null,
  drive_file_id text not null,
  observed_version text,
  resolution text not null default 'listed' check (resolution in ('listed', 'present', 'trashed', 'out_of_root', 'unavailable', 'superseded')),
  seen_at timestamptz not null default clock_timestamp(),
  primary key(job_id, generation, parent_folder_id, drive_file_id),
  foreign key(job_id, generation) references private.catalog_scan_generations(job_id, id) on delete cascade
);
alter table private.catalog_scan_generations enable row level security;
alter table private.catalog_scan_frontier enable row level security;
alter table private.catalog_scan_seen enable row level security;
revoke all on private.catalog_scan_generations, private.catalog_scan_frontier, private.catalog_scan_seen
  from public, anon, authenticated, service_role;

create function public.service_begin_catalog_folder(
  p_job uuid, p_worker text, p_epoch bigint, p_folder text, p_restart boolean default false
)
returns table(generation uuid, page_token text)
language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; frontier private.catalog_scan_frontier; created uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return; end if;
  select * into job from private.catalog_sync_jobs where id = p_job;
  if job.job_kind = 'incremental' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if not job.scan_initialized then
    insert into private.catalog_scan_frontier(job_id, folder_id)
      select p_job, value from jsonb_array_elements_text(job.folder_queue)
      on conflict do nothing;
    update private.catalog_sync_jobs set scan_initialized = true where id = p_job;
  end if;
  select * into frontier from private.catalog_scan_frontier
    where job_id = p_job and folder_id = p_folder for update;
  if not found then raise exception 'INVALID_SCOPE' using errcode = '22023'; end if;
  if p_restart or frontier.generation is null then
    update private.catalog_scan_generations set state = 'abandoned', updated_at = clock_timestamp()
      where id = frontier.generation;
    insert into private.catalog_scan_generations(job_id, parent_folder_id)
      values (p_job, p_folder) returning id into created;
    update private.catalog_scan_frontier set generation = created, state = 'listing'
      where job_id = p_job and folder_id = p_folder;
  else created := frontier.generation;
  end if;
  return query select g.id, g.page_token from private.catalog_scan_generations g where g.id = created;
end;
$$;

create function public.service_catalog_scan_frontier(p_job uuid, p_worker text, p_epoch bigint)
returns table(folder_id text, generation uuid, state text)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return; end if;
  return query select f.folder_id, f.generation, f.state from private.catalog_scan_frontier f
    where f.job_id = p_job and f.state <> 'done' order by f.ordinal limit 100;
end;
$$;

create or replace function private.upsert_catalog_snapshot(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb,
  p_snapshot pg_snapshot
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into p_files
  from jsonb_array_elements(p_files) item where item ->> 'name' <> '.soty';

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle, transcript_ingest_state
  )
  select resolved_team, p_connection, item.drive_file_id, item.drive_id, item.resource_key,
         coalesce(item.parent_folder_id, p_parent_folder_id), item.name, item.mime_type,
         item.file_extension, item.kind, item.shortcut_target_id,
         item.shortcut_target_resource_key, item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'), item.size_bytes,
         nullif(item.modified_at, '')::timestamptz, item.drive_version, item.checksum,
         'active', case when item.category = 'transcript' then 'pending' else 'not_applicable' end
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_id text, resource_key text, parent_folder_id text,
    name text, mime_type text, file_extension text, kind text,
    shortcut_target_id text, shortcut_target_resource_key text, category text,
    classification_version integer, classification_source text, size_bytes bigint,
    modified_at text, drive_version text, checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'landing'
        else excluded.category end,
      classification_version = excluded.classification_version,
      classification_source = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'inspected_landing'
        else excluded.classification_source end,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      landing_validation_state = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_state end,
      landing_validation_version = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_version end,
      landing_validation_fingerprint = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_fingerprint end,
      transcript_text = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then null
        else public.team_materials.transcript_text end,
      transcript_ingest_state = case
        when excluded.category <> 'transcript' then 'not_applicable'
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then 'pending'
        else public.team_materials.transcript_ingest_state end,
      transcript_truncated = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then false
        else public.team_materials.transcript_truncated end,
      transcript_indexed_bytes = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then 0
        else public.team_materials.transcript_indexed_bytes end,
      transcript_error_code = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then null
        else public.team_materials.transcript_error_code end,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null,
      missing_reason = null,
      updated_at = clock_timestamp()
  where pg_visible_in_snapshot(public.team_materials.catalog_mutation_xid::text::xid8, p_snapshot)
    and (public.team_materials.connection_id, public.team_materials.parent_folder_id,
      public.team_materials.name, public.team_materials.mime_type, public.team_materials.kind,
      public.team_materials.drive_version, public.team_materials.checksum, public.team_materials.lifecycle,
      public.team_materials.drive_id, public.team_materials.resource_key, public.team_materials.file_extension,
      public.team_materials.shortcut_target_id, public.team_materials.shortcut_target_resource_key,
      public.team_materials.size_bytes, public.team_materials.modified_at)
      is distinct from (excluded.connection_id, excluded.parent_folder_id, excluded.name, excluded.mime_type,
        excluded.kind, excluded.drive_version, excluded.checksum, 'active'::text, excluded.drive_id,
        excluded.resource_key, excluded.file_extension, excluded.shortcut_target_id,
        excluded.shortcut_target_resource_key, excluded.size_bytes, excluded.modified_at);
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (resolved_team, null, 'upserted');
  end if;
  return affected;
end;
$$;
revoke all on function private.upsert_catalog_snapshot(uuid,text,jsonb,pg_snapshot)
  from public, anon, authenticated, service_role;

create function public.service_commit_catalog_scan_page(
  p_job uuid, p_worker text, p_epoch bigint, p_generation uuid,
  p_expected_page_token text, p_next_page_token text, p_files jsonb, p_complete boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'listing'
      and s.page_token is not distinct from p_expected_page_token for update of s;
  if not found then return false; end if;
  if p_complete is null or (p_next_page_token is null) <> p_complete then
    raise exception 'INCOMPLETE_LISTING' using errcode = '22023';
  end if;
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files) > 100
    or p_next_page_token = '' then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_files) item where
    jsonb_typeof(item) <> 'object'
    or jsonb_typeof(item -> 'drive_file_id') is distinct from 'string'
    or jsonb_typeof(item -> 'name') is distinct from 'string'
    or jsonb_typeof(item -> 'kind') is distinct from 'string'
    or coalesce(length(item ->> 'drive_file_id'), 0) not between 1 and 1024
    or coalesce(length(item ->> 'name'), 0) not between 1 and 1024
    or coalesce(item ->> 'kind', '') not in ('file', 'folder', 'shortcut')
    or item ->> 'parent_folder_id' is distinct from g.parent_folder_id)
    or (select count(distinct item ->> 'drive_file_id') from jsonb_array_elements(p_files) item) <> jsonb_array_length(p_files)
    then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  perform private.upsert_catalog_snapshot(connected, g.parent_folder_id, p_files, g.baseline_snapshot);
  insert into private.catalog_scan_seen(job_id, generation, parent_folder_id, drive_file_id, observed_version)
    select p_job, p_generation, g.parent_folder_id, item ->> 'drive_file_id', item ->> 'drive_version'
    from jsonb_array_elements(p_files) item on conflict do nothing;
  insert into private.catalog_scan_frontier(job_id, folder_id, parent_folder_id)
    select p_job, item ->> 'drive_file_id', g.parent_folder_id from jsonb_array_elements(p_files) item
    where item ->> 'kind' = 'folder' and item ->> 'name' <> '.soty'
    on conflict do nothing;
  update private.catalog_scan_generations set page_token = p_next_page_token,
    coverage = case when p_complete then 'complete' else 'unknown' end,
    state = case when p_complete then 'reconciling' else 'listing' end, updated_at = clock_timestamp()
    where id = p_generation;
  update private.catalog_scan_frontier set state = case when p_complete then 'reconciling' else 'listing' end
    where job_id = p_job and generation = p_generation;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0, last_error_code = null where id = p_job;
  return true;
end;
$$;

create function public.service_catalog_missing_candidates(
  p_job uuid, p_worker text, p_epoch bigint, p_generation uuid
)
returns table(file_id text, expected_revision bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return; end if;
  return query select m.drive_file_id, m.catalog_mutation_xid
  from private.catalog_scan_generations g
  join private.catalog_sync_jobs j on j.id = g.job_id
  join private.catalog_scan_frontier f on f.job_id = j.id and f.generation = g.id
  join public.team_materials m on m.connection_id = j.connection_id and m.parent_folder_id = g.parent_folder_id
  where g.id = p_generation and g.job_id = p_job and g.state = 'reconciling'
    and g.coverage in ('complete', 'permission_limited') and m.lifecycle = 'active'
    and pg_visible_in_snapshot(m.catalog_mutation_xid::text::xid8, g.baseline_snapshot)
    and not exists (select 1 from private.catalog_scan_seen s where s.generation = g.id and s.drive_file_id = m.drive_file_id)
  order by m.drive_file_id limit 100;
end;
$$;

revoke all on function public.service_begin_catalog_folder(uuid,text,bigint,text,boolean),
  public.service_catalog_scan_frontier(uuid,text,bigint),
  public.service_commit_catalog_scan_page(uuid,text,bigint,uuid,text,text,jsonb,boolean),
  public.service_catalog_missing_candidates(uuid,text,bigint,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.service_begin_catalog_folder(uuid,text,bigint,text,boolean),
  public.service_catalog_scan_frontier(uuid,text,bigint),
  public.service_commit_catalog_scan_page(uuid,text,bigint,uuid,text,text,jsonb,boolean),
  public.service_catalog_missing_candidates(uuid,text,bigint,uuid) to service_role;

create function public.service_resolve_catalog_candidate(
  p_job uuid, p_worker text, p_epoch bigint, p_generation uuid, p_file_id text,
  p_expected_revision bigint, p_outcome text, p_file jsonb default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid; material public.team_materials;
  resolution text := p_outcome;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  if p_outcome is null or p_outcome not in ('present', 'trashed', 'out_of_root', 'unavailable') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_outcome <> 'unavailable' and (jsonb_typeof(p_file) is distinct from 'object'
    or p_file ->> 'drive_file_id' is distinct from p_file_id
    or jsonb_typeof(p_file -> 'trashed') is distinct from 'boolean'
    or (p_file ->> 'trashed')::boolean <> (p_outcome = 'trashed')) then
    raise exception 'PROVIDER_PROOF_REQUIRED' using errcode = '22023';
  end if;
  -- A filtered/partial record must not consume a missing candidate as "present".
  if p_outcome = 'present' and (
    jsonb_typeof(p_file -> 'name') is distinct from 'string'
    or coalesce(length(p_file ->> 'name'), 0) not between 1 and 1024
    or jsonb_typeof(p_file -> 'kind') is distinct from 'string'
    or coalesce(p_file ->> 'kind', '') not in ('file', 'folder', 'shortcut')
    or jsonb_typeof(p_file -> 'parent_folder_id') is distinct from 'string'
    or coalesce(length(p_file ->> 'parent_folder_id'), 0) not between 1 and 1024
  ) then
    raise exception 'PROVIDER_PROOF_REQUIRED' using errcode = '22023';
  end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'reconciling' for update of s;
  if not found then return false; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  select * into material from public.team_materials m
    where m.connection_id = connected and m.drive_file_id = p_file_id for update;
  if not found or material.catalog_mutation_xid is distinct from p_expected_revision
    or material.parent_folder_id is distinct from g.parent_folder_id
    or not pg_visible_in_snapshot(material.catalog_mutation_xid::text::xid8, g.baseline_snapshot) then
    resolution := 'superseded';
  elsif p_outcome = 'unavailable' then
    -- Permission loss / ambiguous 404 never authorize removal or cleanup.
    update private.catalog_scan_generations set coverage = 'permission_limited', updated_at = clock_timestamp()
      where id = p_generation;
    update private.catalog_sync_jobs set last_error_code = 'PERMISSION_DENIED' where id = p_job;
  elsif p_outcome = 'present' then
    perform private.upsert_catalog_snapshot(connected, null, jsonb_build_array(p_file), g.baseline_snapshot);
  else
    update public.team_materials set lifecycle = case when p_outcome = 'trashed' then 'trashed' else 'missing' end,
      missing_reason = case when p_outcome = 'out_of_root' then 'out_of_root' else null end,
      missing_at = case when p_outcome = 'out_of_root' then clock_timestamp() else null end,
      trashed_at = case when p_outcome = 'trashed' then clock_timestamp() else null end,
      updated_at = clock_timestamp() where id = material.id;
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (material.team_id, material.id, 'tombstoned');
  end if;
  insert into private.catalog_scan_seen(job_id, generation, parent_folder_id, drive_file_id, resolution)
    values (p_job, p_generation, g.parent_folder_id, p_file_id, resolution) on conflict do nothing;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0 where id = p_job;
  return true;
end;
$$;

create function public.service_finish_catalog_folder(p_job uuid, p_worker text, p_epoch bigint, p_generation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare g private.catalog_scan_generations; connected uuid;
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  select s.* into g from private.catalog_scan_generations s
    join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.id
    where s.id = p_generation and s.job_id = p_job and s.state = 'reconciling' for update of s;
  if not found then return false; end if;
  if exists (select 1 from public.service_catalog_missing_candidates(p_job, p_worker, p_epoch, p_generation))
    then return false; end if;
  select connection_id into connected from private.catalog_sync_jobs where id = p_job;
  if g.coverage = 'complete' then perform public.service_mark_folder_indexed(connected, g.parent_folder_id); end if;
  update private.catalog_scan_generations set state = 'done', updated_at = clock_timestamp() where id = p_generation;
  update private.catalog_scan_frontier set state = 'done' where job_id = p_job and generation = p_generation;
  update private.catalog_sync_jobs set last_progress_at = clock_timestamp(), updated_at = clock_timestamp(),
    attempts = 0 where id = p_job;
  return true;
end;
$$;

-- Once a worker opts into durable generations it cannot bypass their completion
-- or conceal partial coverage by calling the legacy completion seam directly.
create or replace function public.service_complete_catalog_sync_job(
  p_job uuid, p_worker text, p_epoch bigint, p_change_token text, p_next_phase text default 'incremental'
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not private.lock_catalog_sync_lease(p_job, p_worker, p_epoch) then return false; end if;
  if exists (select 1 from private.catalog_sync_jobs j
    where j.id = p_job and j.job_kind <> 'incremental' and j.scan_initialized)
    and exists (select 1 from private.catalog_scan_frontier f
      left join private.catalog_scan_generations g on g.id = f.generation
      where f.job_id = p_job and (f.state <> 'done' or g.coverage is distinct from 'complete')) then
    raise exception 'INCOMPLETE_SCAN' using errcode = '22023';
  end if;
  return public.service_complete_catalog_sync_job(p_job, p_worker, p_change_token, p_next_phase);
end;
$$;

create function public.get_team_folder_sync_status(p_team uuid, p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.catalog_sync_jobs; connected_state text; phase text; state text;
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select j.* into job from private.catalog_sync_jobs j
    join public.team_drive_connections c on c.id = j.connection_id
    where j.id = p_job and c.team_id = p_team and j.requested_folder_id is not null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select c.state into connected_state from public.team_drive_connections c where c.id = job.connection_id;
  state := case when connected_state = 'detached' then 'canceled'
    when job.state in ('failed', 'succeeded', 'canceled') then job.state
    when job.state = 'leased' or job.replay_after is not null then 'running' else 'queued' end;
  phase := case when state in ('failed', 'succeeded', 'canceled') then 'done'
    when job.replay_after is not null then 'replaying_changes'
    when exists (select 1 from private.catalog_scan_frontier f where f.job_id = p_job and f.state = 'reconciling')
      then 'reconciling' else 'listing' end;
  return jsonb_build_object('jobId', job.id, 'scopeFolderId', job.requested_folder_id, 'state', state, 'phase', phase,
    'discoveredFiles', (select count(*) from private.catalog_scan_seen s
      join private.catalog_scan_frontier f on f.job_id = s.job_id and f.generation = s.generation
      where s.job_id = p_job and s.resolution = 'listed'),
    'completedFolders', (select count(*) from private.catalog_scan_frontier f where f.job_id = p_job and f.state = 'done'),
    'pendingFolders', case when not job.scan_initialized then null else
      (select count(*) from private.catalog_scan_frontier f where f.job_id = p_job and f.state <> 'done') end,
    'lastProgressAt', job.last_progress_at, 'completedAt', job.completed_at, 'errorCode', job.last_error_code);
end;
$$;

revoke all on function public.service_resolve_catalog_candidate(uuid,text,bigint,uuid,text,bigint,text,jsonb),
  public.service_finish_catalog_folder(uuid,text,bigint,uuid) from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_catalog_candidate(uuid,text,bigint,uuid,text,bigint,text,jsonb),
  public.service_finish_catalog_folder(uuid,text,bigint,uuid) to service_role;
revoke all on function public.get_team_folder_sync_status(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_team_folder_sync_status(uuid,uuid) to authenticated;
notify pgrst, 'reload schema';
