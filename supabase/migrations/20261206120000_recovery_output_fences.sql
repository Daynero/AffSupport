-- Fence late restitch outputs without losing the receipt of an uploaded file.
begin;
alter table private.catalog_restitch_jobs
  add column claimed_source_material_id uuid,
  add column claimed_source_version text,
  add column claimed_config_generation bigint;
create function private.capture_restitch_claim_fence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state='leased' and (old.state is distinct from new.state or old.lease_token_hash is distinct from new.lease_token_hash) then
    select video.id,video.drive_version,item.config_generation
      into new.claimed_source_material_id,new.claimed_source_version,new.claimed_config_generation
    from public.team_catalog_updater_items item
    join public.team_materials sheet on sheet.id=item.catalog_material_id
    join public.team_materials video on video.id=sheet.companion_of
    where item.catalog_material_id=new.catalog_material_id;
  end if;
  return new;
end;
$$;
create trigger restitch_claim_fence before update on private.catalog_restitch_jobs
for each row execute function private.capture_restitch_claim_fence();
revoke all on function private.capture_restitch_claim_fence() from public,anon,authenticated,service_role;

create or replace function public.service_bind_restitch_job_operation(p_job uuid,p_lease_token_hash bytea,p_operation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare owning_team uuid;
begin
  update private.catalog_restitch_jobs job set operation_id=p_operation
  where job.catalog_material_id=p_job and job.state='leased' and job.lease_token_hash=p_lease_token_hash
    and job.lease_expires_at>clock_timestamp()
    and private.recovery_actor_allowed(job.team_id,job.lease_owner)
    and exists (
      select 1 from public.team_catalog_updater_items item
      join public.team_materials sheet on sheet.id=item.catalog_material_id
      join public.team_materials video on video.id=sheet.companion_of
      where item.catalog_material_id=p_job and item.config_generation=job.claimed_config_generation
        and video.id=job.claimed_source_material_id and video.lifecycle='active'
        and video.drive_version is not distinct from job.claimed_source_version
    )
    and not exists(select 1 from private.team_operation_intents intent where intent.operation_id=p_operation
      and intent.expected_source_version is distinct from job.claimed_source_version)
  returning job.team_id into owning_team;
  if owning_team is null then return false;end if;
  insert into private.catalog_restitch_operations(operation_id,catalog_material_id,team_id)
    values(p_operation,p_job,owning_team) on conflict(operation_id) do nothing;
  return true;
end;
$$;
alter table private.catalog_restitch_operations
  add column source_material_id uuid,
  add column source_version text,
  add column config_generation bigint;
-- Capture the authority of the original claim. Existing operations deliberately
-- lack this proof: their outputs remain cleanup receipts instead of being promoted.
create function private.capture_restitch_output_fence() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  select video.id,video.drive_version,item.config_generation
    into new.source_material_id,new.source_version,new.config_generation
  from public.team_catalog_updater_items item
  join public.team_materials sheet on sheet.id=item.catalog_material_id
  join public.team_materials video on video.id=sheet.companion_of
  where item.catalog_material_id=new.catalog_material_id;
  return new;
end;
$$;
create trigger restitch_output_fence before insert on private.catalog_restitch_operations
for each row execute function private.capture_restitch_output_fence();
revoke all on function private.capture_restitch_output_fence() from public,anon,authenticated,service_role;
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
     -- A completed upload is still recorded below when its authority has expired,
     -- but must never become an eligible replacement for a catalog.
     and job.lease_expires_at > clock_timestamp()
     and private.team_workspace_allowed(job.team_id)
     and private.can(job.team_id, 'process', job.lease_owner)
     and not exists (
       select 1 from public.team_operations operation
       where operation.id = p_operation and operation.state in ('canceled', 'failed')
     )
     and exists (
       select 1 from public.team_catalog_updater_items item
       join public.team_materials sheet on sheet.id=item.catalog_material_id
       join public.team_materials video on video.id=sheet.companion_of
       where item.catalog_material_id=job.catalog_material_id
         and item.config_generation=started.config_generation
         and video.id=started.source_material_id and video.lifecycle='active'
         and video.drive_version is not distinct from started.source_version
     )
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
    begin
      -- The worker can only see this copy once the transaction has committed it.
      perform private.invoke_catalog_updater_worker();
    exception when others then
      -- A failed wake-up must not discard a prepared video; cron will retry dispatch.
      null;
    end;
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

-- The HTTP request cannot be atomic with a tariff transition. Check as close to
-- dispatch as possible, then always retain the receipt of a request already sent.
create function public.service_authorize_catalog_cleanup(p_material uuid,p_kind text,p_worker text)
returns boolean language sql volatile security definer set search_path='' as $$
  select exists (
    select 1 from public.team_materials material
    join public.team_drive_connections connection on connection.id=material.connection_id
    where material.id=p_material and private.team_workspace_allowed(material.team_id)
      and connection.state='connected'
      and not private.launch_output_retained(material.team_id,material.id)
      and (
        (p_kind='retired' and exists (
          select 1 from public.team_catalog_restitch_copies copy where copy.material_id=material.id
            and copy.role='retired' and copy.next_delete_at>clock_timestamp()))
        or (p_kind='orphan' and exists (
          select 1 from private.orphan_cleanups item where item.material_id=material.id
            and item.lease_owner=p_worker and item.lease_expires_at>clock_timestamp()))
      )
  );
$$;
revoke all on function public.service_authorize_catalog_cleanup(uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_authorize_catalog_cleanup(uuid,text,text) to service_role;
commit;
