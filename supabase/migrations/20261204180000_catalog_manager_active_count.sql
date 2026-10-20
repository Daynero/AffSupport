-- Authoritative work in flight, separate from the next scheduled time.
begin;
create or replace function public.get_team_catalog_updater(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return private.catalog_updater_state(p_team) || jsonb_build_object(
    'activeCount', (
      select count(*)
      from private.live_product_catalogs(p_team) as live
      join public.team_catalog_updater_items as item
        on item.catalog_material_id = live.catalog_material_id and item.team_id = p_team
      left join lateral (
        select attempt.result
        from public.team_catalog_update_attempts as attempt
        where attempt.catalog_material_id = item.catalog_material_id and attempt.team_id = p_team
        order by attempt.started_at desc, attempt.attempt_id desc
        limit 1
      ) as latest on true
      where (item.round_due_at is not null and not item.reconciliation_required)
         or (item.reconciliation_required and latest.result = 'running')
    )
  );
end;
$$;
commit;
