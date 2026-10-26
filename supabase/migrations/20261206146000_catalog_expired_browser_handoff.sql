-- Recover abandoned catalog video handoffs without replaying uncertain execution.
begin;
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
  abandoned record;
begin
  if p_actor is null or not private.can(p_team, 'process', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_lease_token_hash is null or octet_length(p_lease_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if exists(select 1 from private.team_recovery_delegations delegation
      where delegation.team_id=p_team and delegation.actor_id=p_actor and delegation.revoked_at is null
        and delegation.expires_at>clock_timestamp()
        and delegation.id::text is distinct from pg_catalog.current_setting('soty.background_recovery',true)) then
    return null;
  end if;
  -- One at a time per member: their own lease still running means their computer is still working.
  if exists (
    select 1 from private.catalog_restitch_jobs as job
    where job.team_id = p_team and job.lease_owner = p_actor and job.state = 'leased'
      and job.lease_expires_at > clock_timestamp()
  ) then return null; end if;

  -- A browser can disappear between the cloud handoff and its completion report.
  -- Revoke only expired, unexecuted handoffs. A native execution reservation or
  -- provider upload is uncertainty, so it must retain its existing recovery fence.
  for abandoned in
    select operation.id from private.catalog_restitch_jobs job
    join public.team_operations operation on operation.id=job.operation_id
    where job.team_id=p_team and job.lease_owner=p_actor
      and ((job.state='leased' and job.lease_expires_at<=clock_timestamp())
        or (job.state='queued' and job.next_attempt_at<=clock_timestamp()))
      and operation.state in ('pending','running') and operation.stage='awaiting_agent'
      and operation.result_material_id is null
      and not exists(select 1 from private.team_recovery_execution_fences fence
        where fence.operation_id=operation.id)
      and not exists(select 1 from private.process_upload_ownership upload
        where upload.operation_id=operation.id)
      and not exists(select 1 from private.team_operation_intents intent
        where intent.operation_id=operation.id and intent.provider_result_id is not null)
    for update of job,operation skip locked
  loop
    -- Re-read after acquiring the operation lock: a native checkpoint or upload
    -- may have committed while this SELECT waited for its lock.
    if exists(select 1 from private.team_recovery_execution_fences where operation_id=abandoned.id)
       or exists(select 1 from private.process_upload_ownership where operation_id=abandoned.id)
       or exists(select 1 from private.team_operation_intents
         where operation_id=abandoned.id and provider_result_id is not null) then
      continue;
    end if;
    update public.team_operations set state='failed',stage='failed',error_code='LEASE_EXPIRED',
      retryable=true,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
      reservation_released_at=coalesce(reservation_released_at,clock_timestamp())
    where id=abandoned.id;
    update private.team_transfer_grants set revoked_at=clock_timestamp()
    where operation_id=abandoned.id and revoked_at is null;
    perform private.record_team_audit(p_team,p_actor,'operation.failed',
      jsonb_build_object('operation_id',abandoned.id,'state','failed'),'failed','LEASE_EXPIRED');
  end loop;

  select job.* into claimed
  from private.catalog_restitch_jobs as job
  join public.team_catalog_updaters as updater on updater.team_id = job.team_id
  join public.team_catalog_updater_items as item
    on item.catalog_material_id = job.catalog_material_id
  where job.team_id = p_team
    and updater.state = 'running'
    and private.catalog_wants_restitch(job.catalog_material_id)
    and not exists(select 1 from private.workspace_pause_items snapshot
      join private.workspace_recovery_items recovery on recovery.pause_item_id=snapshot.id
      join private.workspace_recoveries cycle on cycle.id=recovery.recovery_id
      where snapshot.kind='restitch' and snapshot.resource_id=job.catalog_material_id
        and snapshot.config_generation=item.config_generation and cycle.state<>'superseded'
        and (recovery.state in ('blocked','skipped_manual') or exists(
          select 1 from public.team_operations operation where operation.id=coalesce(recovery.operation_id,snapshot.operation_id)
            and (operation.state='canceled' or (operation.state='failed' and not operation.retryable))) or not exists(
          select 1 from public.team_materials sheet join public.team_materials source on source.id=sheet.companion_of
          where sheet.id=snapshot.resource_id and source.id=snapshot.source_material_id and source.lifecycle='active'
            and source.drive_version is not distinct from snapshot.source_version)))
    and not exists(select 1 from private.catalog_restitch_operations previous
      join public.team_operations operation on operation.id=previous.operation_id
      where previous.catalog_material_id=job.catalog_material_id and operation.state in ('pending','running'))
    and job.next_attempt_at <= clock_timestamp()
    and not exists (
      select 1 from private.catalog_restitch_operations original
      join public.team_operations finished on finished.id=original.operation_id
      where original.catalog_material_id=job.catalog_material_id and finished.state='succeeded'
        and finished.result_material_id is not null
        and not exists(select 1 from public.team_catalog_restitch_copies receipt where receipt.operation_id=finished.id)
    )
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
commit;
