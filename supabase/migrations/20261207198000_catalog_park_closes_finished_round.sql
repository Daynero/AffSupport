-- When an updater round's attempt had already ended (for example 'failed' with
-- PROCESS_RESULT_UNCERTAIN) but the item still carried the round, the next
-- claim found no running attempt and parked the item with
-- reconciliation_required=true and next_attempt_at=infinity, without any
-- catalog_update_reconciliations row to resolve it. Nothing could clear that
-- state, so the catalog showed "Потрібна перевірка, зверніться до підтримки"
-- forever.
--
-- A finished attempt (success, partial, failed, cancelled) is not an
-- inconsistency: its round is over. The park now closes such a round the same
-- way Stop does and keeps the attempt's failure visible; only a round whose
-- attempt is missing, or 'unknown', is still quarantined. Items already
-- stranded that way are released once.
begin;
create or replace function public.service_park_catalog_update_claim(p_item uuid,p_worker text)
returns boolean language plpgsql security definer set search_path='' as $$
declare owning_team uuid; observed_round timestamptz; finished public.team_catalog_update_attempts%rowtype;
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
  select * into finished from public.team_catalog_update_attempts attempt
    where attempt.team_id=owning_team and attempt.catalog_material_id=p_item
      and attempt.round_due_at=observed_round
      and attempt.result in ('success','partial','failed','cancelled')
    order by attempt.started_at desc limit 1;
  if finished.attempt_id is not null and not exists(
    select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item) then
    update public.team_catalog_updater_items
      set round_due_at=null,attempts=0,lease_owner=null,lease_expires_at=null,
          next_attempt_at=clock_timestamp()
      where catalog_material_id=p_item and team_id=owning_team;
    if finished.result='failed' and finished.failure_code is not null then
      update public.team_product_catalogs
        set last_update_error=finished.failure_code,last_update_error_at=clock_timestamp()
        where material_id=p_item and team_id=owning_team;
    end if;
    perform private.sync_catalog_updater(owning_team);
    insert into public.team_catalog_events(team_id,material_id,event_kind)
      values(owning_team,p_item,'upserted');
    return true;
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
revoke all on function public.service_park_catalog_update_claim(uuid,text) from public,anon,authenticated;
grant execute on function public.service_park_catalog_update_claim(uuid,text) to service_role;

-- Release items already stranded by the old park: quarantined, nothing to
-- reconcile, and the round's attempt finished.
with stranded as (
  select item.catalog_material_id, item.team_id
  from public.team_catalog_updater_items item
  where item.reconciliation_required and item.round_due_at is not null
    and item.next_attempt_at='infinity'::timestamptz
    and not exists(select 1 from private.catalog_update_reconciliations r where r.catalog_material_id=item.catalog_material_id)
    and exists(select 1 from public.team_catalog_update_attempts a
      where a.catalog_material_id=item.catalog_material_id and a.team_id=item.team_id
        and a.round_due_at=item.round_due_at and a.result in ('success','partial','failed','cancelled'))
    and not exists(select 1 from public.team_catalog_update_attempts a
      where a.catalog_material_id=item.catalog_material_id and a.team_id=item.team_id
        and a.round_due_at=item.round_due_at and a.result in ('running','unknown'))
)
update public.team_catalog_updater_items item
  set reconciliation_required=false,round_due_at=null,attempts=0,lease_owner=null,
      lease_expires_at=null,next_attempt_at=clock_timestamp()
  from stranded
  where item.catalog_material_id=stranded.catalog_material_id and item.team_id=stranded.team_id;
commit;
