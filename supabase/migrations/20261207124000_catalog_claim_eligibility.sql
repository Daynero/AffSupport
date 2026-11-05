-- Preserve claim authority and output receipts across cancellation and cleanup.
begin;
alter table private.catalog_restitch_operations
 add column handoff_actor_id uuid,
 add column handoff_expires_at timestamptz,
 add column output_recorded_at timestamptz;
-- Claim and bounded diagnosis both look up historical receipts by catalog.
create index catalog_restitch_operations_catalog_created
 on private.catalog_restitch_operations(catalog_material_id,created_at desc);
-- Only existing independent evidence may seed these markers.
update private.catalog_restitch_operations history
 set handoff_actor_id=job.lease_owner,handoff_expires_at=job.lease_expires_at
 from private.catalog_restitch_jobs job
 where job.operation_id=history.operation_id and job.catalog_material_id=history.catalog_material_id
 and job.team_id=history.team_id and job.state='leased';
update private.catalog_restitch_operations history set output_recorded_at=copy.created_at
 from public.team_catalog_restitch_copies copy where copy.operation_id=history.operation_id
 and copy.catalog_material_id=history.catalog_material_id and copy.team_id=history.team_id;
create function private.capture_restitch_handoff() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 select lease_owner,lease_expires_at into new.handoff_actor_id,new.handoff_expires_at
 from private.catalog_restitch_jobs where operation_id=new.operation_id and catalog_material_id=new.catalog_material_id;
 return new;
end $$;
create trigger restitch_handoff_receipt before insert on private.catalog_restitch_operations
for each row execute function private.capture_restitch_handoff();
-- A renewed lease remains authoritative even if Stop subsequently removes the job.
create function private.extend_restitch_handoff() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.state='leased' and new.operation_id is not null then
  update private.catalog_restitch_operations
   set handoff_expires_at=greatest(handoff_expires_at,new.lease_expires_at)
   where operation_id=new.operation_id and handoff_actor_id=new.lease_owner;
 end if;
 return new;
end $$;
create trigger restitch_handoff_extension after update on private.catalog_restitch_jobs
for each row execute function private.extend_restitch_handoff();
revoke all on function private.extend_restitch_handoff() from public,anon,authenticated,service_role;
create function private.retain_restitch_output_receipt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_restitch_operations set output_recorded_at=coalesce(output_recorded_at,clock_timestamp())
 where operation_id=new.operation_id and catalog_material_id=new.catalog_material_id and team_id=new.team_id;
 return new;
end $$;
create trigger restitch_output_receipt after insert on public.team_catalog_restitch_copies
for each row execute function private.retain_restitch_output_receipt();
revoke all on function private.capture_restitch_handoff(),private.retain_restitch_output_receipt()
 from public,anon,authenticated,service_role;

-- A second authorized desktop must compete for the member lease, not block both desktops.
-- A browser still yields whenever this actor has a native owner.
create function private.catalog_restitch_actor_blockers(p_team uuid,p_actor uuid,p_delegation text)
returns text[] language sql stable security definer set search_path='' as $$
 select array_remove(array[
 case when not private.can(p_team,'process',p_actor) then 'permission_denied' end,
 case when nullif(p_delegation,'') is not null and not exists(
  select 1 from private.team_recovery_delegations d where d.id::text=p_delegation
   and d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null and d.expires_at>clock_timestamp())
  then 'native_delegation_invalid' end,
 case when nullif(p_delegation,'') is null and exists(
  select 1 from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor
   and d.revoked_at is null and d.expires_at>clock_timestamp()) then 'native_owner' end,
 case when exists(select 1 from private.catalog_restitch_jobs j where j.team_id=p_team and j.lease_owner=p_actor
  and j.state='leased' and j.lease_expires_at>clock_timestamp()) then 'member_busy' end
 ]::text[],null);
$$;

create function private.catalog_restitch_job_blockers(p_catalog uuid)
returns text[] language sql stable security definer set search_path='' as $$
 select array_remove(array[
 case when job.catalog_material_id is null then 'job_missing' end,
 case when updater.state is distinct from 'running' then 'updater_stopped' end,
 case when item.catalog_material_id is null then 'item_missing' end,
 case when not private.catalog_wants_restitch(p_catalog) then 'restitch_not_requested' end,
 case when exists(select 1 from private.workspace_pause_items snapshot
      join private.workspace_recovery_items recovery on recovery.pause_item_id=snapshot.id
      join private.workspace_recoveries cycle on cycle.id=recovery.recovery_id
      where snapshot.kind='restitch' and snapshot.resource_id=job.catalog_material_id
        and snapshot.config_generation=item.config_generation and cycle.state<>'superseded'
        and (recovery.state in ('blocked','skipped_manual') or exists(
          select 1 from public.team_operations operation where operation.id=coalesce(recovery.operation_id,snapshot.operation_id)
            and (operation.state='canceled' or (operation.state='failed' and not operation.retryable))) or not exists(
          select 1 from public.team_materials sheet join public.team_materials source on source.id=sheet.companion_of
          where sheet.id=snapshot.resource_id and source.id=snapshot.source_material_id and source.lifecycle='active'
            and source.drive_version is not distinct from snapshot.source_version))) then 'recovery_blocked' end,
 case when exists(select 1 from private.catalog_restitch_operations previous
  join public.team_operations operation on operation.id=previous.operation_id
  where previous.catalog_material_id=p_catalog and operation.state in ('pending','running')) then 'previous_operation_open' end,
 case when exists(select 1 from private.catalog_restitch_operations original
  join public.team_operations finished on finished.id=original.operation_id
  where original.catalog_material_id=p_catalog and finished.state='succeeded' and finished.result_material_id is not null
   and original.output_recorded_at is null
   and not exists(select 1 from public.team_catalog_restitch_copies receipt where receipt.operation_id=finished.id))
  then 'output_receipt_missing' end,
 case when job.next_attempt_at>clock_timestamp() then 'retry_backoff' end,
 case when job.state='leased' and job.lease_expires_at>clock_timestamp() then 'job_leased' end,
 case when not exists(select 1 from private.live_product_catalogs(catalog.team_id) live where live.catalog_material_id=p_catalog)
  then 'source_link_unavailable' end
 ]::text[],null)
 from public.team_product_catalogs catalog
 left join private.catalog_restitch_jobs job on job.catalog_material_id=catalog.material_id
 left join public.team_catalog_updaters updater on updater.team_id=catalog.team_id
 left join public.team_catalog_updater_items item on item.catalog_material_id=catalog.material_id
 where catalog.material_id=p_catalog;
$$;
revoke all on function private.catalog_restitch_actor_blockers(uuid,uuid,text),private.catalog_restitch_job_blockers(uuid)
 from public,anon,authenticated,service_role;
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
  -- Serialize all browser/native claimants for one member before checking their lease.
  if not pg_try_advisory_xact_lock(hashtextextended('catalog-restitch:'||p_team::text||':'||p_actor::text,0)) then
    return null;
  end if;
  if cardinality(private.catalog_restitch_actor_blockers(p_team,p_actor,
      pg_catalog.current_setting('soty.background_recovery',true)))>0 then return null; end if;

  -- A browser can disappear between the cloud handoff and its completion report.
  -- Revoke only expired, unexecuted handoffs. A native execution reservation or
  -- provider upload is uncertainty, so it must retain its existing recovery fence.
  for abandoned in
    select operation.id from private.catalog_restitch_jobs job
    join private.catalog_restitch_operations history on history.catalog_material_id=job.catalog_material_id
    join public.team_operations operation on operation.id=history.operation_id
    where job.team_id=p_team and operation.team_id=p_team
      and (
        (job.operation_id=operation.id and job.lease_owner=operation.actor_id and
          ((job.state='leased' and job.lease_expires_at<=clock_timestamp()) or
           (job.state='queued' and job.next_attempt_at<=clock_timestamp()
            and (history.handoff_expires_at<=clock_timestamp() or job.last_error_code='PROCESS_CANCELED'))))
        or (job.operation_id is distinct from operation.id and history.handoff_actor_id=operation.actor_id
          and history.handoff_expires_at<=clock_timestamp()
          and not exists(select 1 from private.catalog_restitch_jobs active
            where active.operation_id=operation.id and active.state='leased' and active.lease_expires_at>clock_timestamp()))
      )
      and operation.state in ('pending','running') and operation.stage='awaiting_agent'
      and operation.result_material_id is null
      and not exists(select 1 from private.team_recovery_execution_fences fence
        where fence.operation_id=operation.id)
      and not exists(select 1 from private.process_upload_ownership upload
        where upload.operation_id=operation.id)
      and not exists(select 1 from private.team_operation_intents intent
        where intent.operation_id=operation.id and intent.provider_result_id is not null)
    order by history.created_at
    limit 20
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
    -- Keep lease predicates on the locked row too: PostgreSQL must recheck the
    -- new row version after a concurrent claimant, not a stable helper snapshot.
    and job.next_attempt_at <= clock_timestamp()
    and (job.state='queued' or job.lease_expires_at <= clock_timestamp())
    and cardinality(private.catalog_restitch_job_blockers(job.catalog_material_id))=0
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

-- An unproven successful output requires reconciliation, not endless waiting.
create function private.catalog_restitch_visible_error(p_catalog uuid) returns text
language sql stable security definer set search_path='' as $$
 select coalesce(job.last_error_code,
  case when 'output_receipt_missing'=any(private.catalog_restitch_job_blockers(p_catalog))
    or exists(select 1 from private.catalog_restitch_operations history
      join public.team_operations operation on operation.id=history.operation_id
      where history.catalog_material_id=p_catalog and operation.state in ('pending','running')
        and not exists(select 1 from private.catalog_restitch_jobs live
          where live.operation_id=operation.id and live.state='leased' and live.lease_expires_at>clock_timestamp())
        and (history.handoff_expires_at is null or
          (history.handoff_expires_at<=clock_timestamp() and (
            operation.stage is distinct from 'awaiting_agent' or exists(select 1 from private.team_recovery_execution_fences f where f.operation_id=operation.id)
            or exists(select 1 from private.process_upload_ownership u where u.operation_id=operation.id)
            or exists(select 1 from private.team_operation_intents i where i.operation_id=operation.id and i.provider_result_id is not null)))))
    then 'PROCESS_RESULT_UNCERTAIN' end)
 from private.catalog_restitch_jobs job where job.catalog_material_id=p_catalog;
$$;
revoke all on function private.catalog_restitch_visible_error(uuid) from public,anon,authenticated,service_role;
create or replace function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean,
  last_result text, latest_attempt_at timestamptz, last_successful_at timestamptz, schedule jsonb
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when private.catalog_has_usable_spare(profile.catalog_material_id) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and private.catalog_restitch_visible_error(profile.catalog_material_id) is not null
           ) then 'blocked'
           else 'waiting' end,
           private.catalog_restitch_visible_error(profile.catalog_material_id), coalesce(item.reconciliation_required, false),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null), profile.schedule
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$$;

-- Current eligibility is a snapshot, not a history or proof of native execution.
create view public.analytics_catalog_claim_eligibility with(security_barrier=true) as
select catalog.material_id as catalog_id,catalog.team_id,
 (select owner_id from public.teams where id=catalog.team_id) as owner_id,
 (select state from private.catalog_restitch_jobs where catalog_material_id=catalog.material_id) as job_state,
 private.catalog_restitch_job_blockers(catalog.material_id) as blockers,
 (select count(*) from private.catalog_restitch_operations previous join public.team_operations operation
  on operation.id=previous.operation_id where previous.catalog_material_id=catalog.material_id
   and operation.state in ('pending','running')) as open_operations,
 (select jsonb_build_object('records',coalesce(jsonb_agg(jsonb_build_object(
    'operation_id',evidence.operation_id,'actor_id',evidence.actor_id,
    'state',evidence.state,'stage',evidence.stage,
    'handoff_expires_at',evidence.handoff_expires_at,
    'execution_reserved',exists(select 1 from private.team_recovery_execution_fences f where f.operation_id=evidence.operation_id),
    'upload_owned',exists(select 1 from private.process_upload_ownership u where u.operation_id=evidence.operation_id),
    'provider_result_recorded',exists(select 1 from private.team_operation_intents i where i.operation_id=evidence.operation_id and i.provider_result_id is not null)
   )),'[]'::jsonb),'truncated',coalesce(max(evidence.total)>20,false))
  from (select history.operation_id,history.handoff_expires_at,operation.actor_id,operation.state,operation.stage,
    count(*) over() as total
   from private.catalog_restitch_operations history join public.team_operations operation on operation.id=history.operation_id
   where history.catalog_material_id=catalog.material_id and
    (operation.state in ('pending','running') or (operation.state='succeeded' and operation.result_material_id is not null
     and history.output_recorded_at is null and not exists(select 1 from public.team_catalog_restitch_copies receipt where receipt.operation_id=operation.id)))
   order by history.created_at desc,history.operation_id limit 20) evidence) as prior_operations,
 coalesce((select jsonb_agg(jsonb_build_object('actor_id',d.actor_id,'delegation_id',d.id,
  'last_claim_at',d.last_claim_at,'blockers',private.catalog_restitch_actor_blockers(d.team_id,d.actor_id,d.id::text)))
  from (select * from private.team_recovery_delegations d where d.team_id=catalog.team_id
   and d.revoked_at is null and d.expires_at>clock_timestamp() order by d.id limit 20) d),'[]'::jsonb) as native_claimants,
 (select count(*)>20 from private.team_recovery_delegations d where d.team_id=catalog.team_id
   and d.revoked_at is null and d.expires_at>clock_timestamp()) as native_claimants_truncated,
 clock_timestamp() as observed_at
from public.team_product_catalogs catalog;
revoke all on public.analytics_catalog_claim_eligibility from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  revoke all on public.analytics_catalog_claim_eligibility from wishly_analytics_ro;
  grant select on public.analytics_catalog_claim_eligibility to wishly_analytics_ro;
  grant execute on function private.catalog_restitch_actor_blockers(uuid,uuid,text),private.catalog_restitch_job_blockers(uuid) to wishly_analytics_ro;
 end if;
end $$;
commit;
