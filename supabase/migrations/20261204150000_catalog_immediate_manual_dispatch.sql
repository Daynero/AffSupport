-- Wake accepted manual rounds and ready replacement videos without waiting for cron.
begin;
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare wanted uuid[]; opened integer;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);
  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;
  insert into public.team_catalog_updater_items (catalog_material_id, team_id)
  select catalog, p_team from unnest(wanted) as catalog
  on conflict (catalog_material_id) do nothing;
  perform pg_catalog.set_config('soty.catalog_manual_run', 'on', true);
  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(), attempts = 0
   where item.team_id = p_team and item.catalog_material_id = any(wanted)
     and item.round_due_at is null and not item.reconciliation_required;
  get diagnostics opened = row_count;
  perform pg_catalog.set_config('soty.catalog_manual_run', 'off', true);
  perform private.sync_catalog_updater(p_team);
  if opened > 0 then
    -- A user's new run retries preparation immediately; never steal an active app lease.
    update private.catalog_restitch_jobs as job
       set next_attempt_at = clock_timestamp(), attempts = 0, last_error_code = null
     where job.team_id = p_team and job.catalog_material_id = any(wanted)
       and job.state = 'queued';
  end if;
  if opened > 0 then
    begin
      -- pg_net dispatches after this transaction commits the accepted round.
      perform private.invoke_catalog_updater_worker();
    exception when others then
      -- The durable round and periodic dispatcher remain the recovery path.
      null;
    end;
  end if;
  return opened;
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
commit;
