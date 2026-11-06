begin;

-- New findings stay out of applied error catalog batches.
insert into public.team_error_codes (code) values
  ('TEAM_TRANSPORT_UNAVAILABLE'),
  ('CATALOG_ATTEMPT_STATE_INCONSISTENT')
on conflict (code) do nothing;

-- Do not fabricate or overwrite an attempt to make an inconsistent old round run.
-- A stale worker may not park a replacement, and a healthy running attempt is
-- never quarantined merely because a separate read lost its response.
create function public.service_park_catalog_update_claim(p_item uuid,p_worker text)
returns boolean language plpgsql security definer set search_path='' as $$
declare owning_team uuid; observed_round timestamptz;
begin
  select item.team_id into owning_team from public.team_catalog_updater_items item
    where item.catalog_material_id=p_item;
  if not found then return false; end if;
  -- Keep the established team-before-item lock order.
  perform 1 from public.team_catalog_updaters where team_id=owning_team for update;
  select item.round_due_at into observed_round
    from public.team_catalog_updater_items item
    where item.catalog_material_id=p_item and item.team_id=owning_team
      and item.lease_owner=p_worker and item.lease_expires_at>clock_timestamp()
      and item.round_due_at is not null
    for update;
  if not found then return false; end if;
  if exists(select 1 from public.team_catalog_update_attempts attempt
    where attempt.team_id=owning_team and attempt.catalog_material_id=p_item
      and attempt.round_due_at=observed_round and attempt.result='running') then
    return false;
  end if;
  update public.team_catalog_updater_items
    set reconciliation_required=true,next_attempt_at='infinity'::timestamptz,
        lease_owner=null,lease_expires_at=null
    where catalog_material_id=p_item and team_id=owning_team;
  update public.team_product_catalogs
    set last_update_error='CATALOG_ATTEMPT_STATE_INCONSISTENT',
        last_update_error_at=clock_timestamp()
    where material_id=p_item and team_id=owning_team;
  insert into public.team_catalog_events(team_id,material_id,event_kind)
    values(owning_team,p_item,'upserted');
  return true;
end $$;
revoke all on function public.service_park_catalog_update_claim(uuid,text)
  from public,anon,authenticated;
grant execute on function public.service_park_catalog_update_claim(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
