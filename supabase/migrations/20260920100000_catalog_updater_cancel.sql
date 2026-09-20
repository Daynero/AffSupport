-- Turning a catalog off also cancels an update that is waiting or already leased.
-- Revoking the lease makes an in-flight worker's completion/retry RPC a harmless no-op.

create or replace function public.set_team_catalog_update_interval(
  p_team uuid, p_catalogs uuid[], p_interval text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted uuid[];
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_interval is not null and private.catalog_updater_interval(p_interval) is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  wanted := private.checked_catalogs(p_team, p_catalogs);

  insert into public.team_catalog_updaters (team_id) values (p_team)
  on conflict (team_id) do nothing;
  perform 1 from public.team_catalog_updaters where team_id = p_team for update;

  if p_interval is null then
    update public.team_catalog_updater_items as item
       set update_interval = null, next_run_at = null, round_due_at = null,
           attempts = 0, lease_owner = null, lease_expires_at = null,
           next_attempt_at = clock_timestamp()
     where item.team_id = p_team and item.catalog_material_id = any(wanted);
  else
    insert into public.team_catalog_updater_items (
      catalog_material_id, team_id, update_interval, next_run_at
    )
    select catalog, p_team, p_interval,
           clock_timestamp() + private.catalog_updater_interval(p_interval)
    from unnest(wanted) as catalog
    on conflict (catalog_material_id) do update
      set update_interval = excluded.update_interval,
          next_run_at = case
            when public.team_catalog_updater_items.update_interval
                 is not distinct from excluded.update_interval
              then public.team_catalog_updater_items.next_run_at
            else excluded.next_run_at
          end;
    update public.team_catalog_updaters
       set update_interval = p_interval
     where team_id = p_team;
  end if;

  perform private.sync_catalog_updater(p_team);
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
  update public.team_catalog_updater_items as item
     set update_interval = null, next_run_at = null, round_due_at = null,
         attempts = 0, lease_owner = null, lease_expires_at = null,
         next_attempt_at = clock_timestamp()
   where item.team_id = p_team;
  perform private.sync_catalog_updater(p_team);
  return private.catalog_updater_state(p_team);
end;
$$;

revoke all on function public.set_team_catalog_update_interval(uuid, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.stop_team_catalog_updater(uuid) from public, anon, authenticated;
grant execute on function public.set_team_catalog_update_interval(uuid, uuid[], text)
  to authenticated;
grant execute on function public.stop_team_catalog_updater(uuid) to authenticated;
