-- Resolve the video requirement from the active attempt, never the retired global switch.
begin;
create or replace function private.catalog_wants_restitch(p_catalog uuid, p_include_paused boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    where item.catalog_material_id = p_catalog
      and (item.update_interval is not null or item.round_due_at is not null
           or (p_include_paused and item.paused_interval is not null))
      and coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
  );
$$;
revoke all on function private.catalog_wants_restitch(uuid, boolean) from public, anon, authenticated;

create or replace function public.service_claim_restitch_job(
  p_team uuid,
  p_actor uuid,
  p_lease_token_hash bytea,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed private.catalog_restitch_jobs;
  result jsonb;
begin
  if p_actor is null or not private.can(p_team, 'process', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_lease_token_hash is null or octet_length(p_lease_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- One at a time per member: their own lease still running means their computer is still working.
  if exists (
    select 1 from private.catalog_restitch_jobs as job
    where job.team_id = p_team and job.lease_owner = p_actor and job.state = 'leased'
      and job.lease_expires_at > clock_timestamp()
  ) then return null; end if;

  select job.* into claimed
  from private.catalog_restitch_jobs as job
  join public.team_catalog_updaters as updater on updater.team_id = job.team_id
  join public.team_catalog_updater_items as item
    on item.catalog_material_id = job.catalog_material_id
  where job.team_id = p_team
    and updater.state = 'running'
    and private.catalog_wants_restitch(job.catalog_material_id)
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
         lease_owner = p_actor,
         operation_id = null,
         lease_token_hash = p_lease_token_hash,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)),
         attempts = job.attempts + 1
   where job.catalog_material_id = claimed.catalog_material_id;

  select jsonb_build_object(
    'jobId', claimed.catalog_material_id,
    'teamId', claimed.team_id,
    'actorId', p_actor,
    'attempt', claimed.attempts + 1,
    -- Earlier attempts whose leases lapsed may have left processes open, holding the copy's name.
    'openOperationIds', coalesce((
      select jsonb_agg(started.operation_id)
      from private.catalog_restitch_operations as started
      join public.team_operations as operation on operation.id = started.operation_id
      where started.catalog_material_id = claimed.catalog_material_id
        and operation.state in ('pending', 'running')
    ), '[]'::jsonb),
    'videoMaterialId', video.id,
    'videoName', video.name,
    'videoDriveVersion', video.drive_version,
    'destinationFolderId', folder.id,
    'updateCount', record.update_count,
    -- In the shapes the app's restitch delegate reads (shared `parseTeamRestitchDefaults` and
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

create or replace function public.service_heartbeat_restitch_job(
  p_actor uuid,
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
  renewed uuid;
begin
  update private.catalog_restitch_jobs as job
     set lease_expires_at = clock_timestamp()
       + make_interval(secs => least(greatest(p_lease_seconds, 30), 600))
    from public.team_catalog_updaters as updater
   where job.catalog_material_id = p_job
     and job.lease_owner = p_actor
     and job.state = 'leased'
     and job.lease_token_hash = p_lease_token_hash
     and updater.team_id = job.team_id
     and updater.state = 'running'
     and private.catalog_wants_restitch(job.catalog_material_id)
     and private.can(job.team_id, 'process', p_actor)
  returning job.catalog_material_id into renewed;
  return renewed is null;
end;
$$;

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
       where updater.team_id = job.team_id and updater.state = 'running'
    and private.catalog_wants_restitch(job.catalog_material_id)
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
create or replace function private.queue_restitch_jobs(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into private.catalog_restitch_jobs (catalog_material_id, team_id)
  select item.catalog_material_id, p_team
  from public.team_catalog_updater_items as item
  join public.team_catalog_update_profiles as profile
    on profile.catalog_material_id = item.catalog_material_id
  where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true)
    and (item.update_interval is not null or item.round_due_at is not null)
    and not exists (
      select 1 from public.team_catalog_restitch_copies as copy
      where copy.catalog_material_id = item.catalog_material_id and copy.role = 'spare'
    )
  on conflict (catalog_material_id) do nothing;
end;
$$;

create or replace function private.sync_catalog_updater(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare earliest timestamptz; preparing_one_off boolean;
begin
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null
    and item.paused_interval is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  select exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    where item.team_id = p_team
      and coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
      and item.round_due_at is not null
  ) into preparing_one_off;

  update public.team_catalog_updaters as updater
     set restitch = exists (
           select 1 from public.team_catalog_updater_items as item
           where item.team_id = p_team
             and private.catalog_wants_restitch(item.catalog_material_id)
         ),
         state = case when earliest is null and not preparing_one_off then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null and not preparing_one_off then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at end,
         started_by = case
           when (earliest is not null or preparing_one_off) and updater.state <> 'running'
             then auth.uid() else updater.started_by end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  if exists (select 1 from public.team_catalog_updaters
             where team_id = p_team and state = 'running') then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true)
        and (item.update_interval is not null or item.round_due_at is not null
             or item.paused_interval is not null)
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true) and item.paused_interval is not null
    ));
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;
commit;
