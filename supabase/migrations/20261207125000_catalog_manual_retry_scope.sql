-- A mixed bulk request must not reset an already pending catalog.
begin;
create or replace function public.run_team_catalog_update_now(p_team uuid, p_catalogs uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare wanted uuid[]; accepted uuid[]; opened integer;
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
  with new_attempts as (
  update public.team_catalog_updater_items as item
     set round_due_at = clock_timestamp(), next_attempt_at = clock_timestamp(), attempts = 0
   where item.team_id = p_team and item.catalog_material_id = any(wanted)
     and item.round_due_at is null and not item.reconciliation_required
   returning item.catalog_material_id
  ) select coalesce(array_agg(catalog_material_id), '{}'::uuid[]) into accepted from new_attempts;
  opened := cardinality(accepted);
  perform pg_catalog.set_config('soty.catalog_manual_run', 'off', true);
  perform private.sync_catalog_updater(p_team);
  if opened > 0 then
    -- A user's new run retries preparation immediately; never steal an active app lease.
    update private.catalog_restitch_jobs as job
       set next_attempt_at = clock_timestamp(), attempts = 0, last_error_code = null
     where job.team_id = p_team and job.catalog_material_id = any(accepted)
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

commit;
