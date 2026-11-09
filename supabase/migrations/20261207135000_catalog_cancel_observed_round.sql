-- A stale list must never stop a replacement round. Existing provider-lease protection remains.
create function public.cancel_team_catalog_update_attempt(
  p_team uuid, p_catalog uuid, p_expected_round timestamptz, p_expected_attempt uuid default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare current_round timestamptz; needs_reconciliation boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'process', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_expected_round is null or not isfinite(p_expected_round) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select item.round_due_at, item.reconciliation_required into current_round, needs_reconciliation
  from public.team_catalog_updater_items item
  where item.team_id = p_team and item.catalog_material_id = p_catalog
  for update;
  if not found then return false; end if;
  if needs_reconciliation then
    raise exception 'CATALOG_UPDATE_RECONCILIATION_REQUIRED' using errcode = '55000';
  end if;
  if current_round is null then return false; end if;
  if current_round is distinct from p_expected_round or
     (p_expected_attempt is not null and not exists (
       select 1 from public.team_catalog_update_attempts attempt
       where attempt.team_id = p_team and attempt.catalog_material_id = p_catalog
         and attempt.round_due_at = current_round and attempt.attempt_id = p_expected_attempt
     )) then
    raise exception 'STALE_RESULT' using errcode = '40001';
  end if;
  return public.cancel_team_catalog_update(p_team, p_catalog);
end;
$$;
revoke all on function public.cancel_team_catalog_update_attempt(uuid,uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_team_catalog_update_attempt(uuid,uuid,timestamptz,uuid)
  to authenticated;
