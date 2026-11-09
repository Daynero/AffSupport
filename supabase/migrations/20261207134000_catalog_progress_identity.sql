-- Read-only identities bind visible progress to the active catalog round and child.
create function public.list_team_catalog_progress_identity(p_team uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select coalesce(jsonb_object_agg(catalog.catalog_material_id::text, jsonb_build_object(
    'active_round_at', item.round_due_at,
    'active_attempt_id', active.attempt_id,
    'progress_attempt_id', case when progress.worker = item.lease_owner
      and progress.updated_at >= item.round_due_at
      and item.lease_expires_at > now() then active.attempt_id end,
    'restitch_operation_id', case when job.state = 'leased' and job.lease_expires_at > now()
      then job.operation_id end
  )), '{}'::jsonb) into result
  from private.live_product_catalogs(p_team) catalog
  left join public.team_catalog_updater_items item on item.catalog_material_id = catalog.catalog_material_id
  left join public.team_catalog_update_attempts active
    on active.catalog_material_id = catalog.catalog_material_id and active.round_due_at = item.round_due_at
  left join private.catalog_update_progress progress on progress.catalog_material_id = catalog.catalog_material_id
  left join private.catalog_restitch_jobs job on job.catalog_material_id = catalog.catalog_material_id
  ;
  return result;
end;
$$;
revoke all on function public.list_team_catalog_progress_identity(uuid) from public, anon, authenticated;
grant execute on function public.list_team_catalog_progress_identity(uuid) to authenticated;

create or replace function public.list_team_catalog_manager_snapshot(p_team uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with identities as materialized (
    select public.list_team_catalog_progress_identity(p_team) as data
  )
  select jsonb_build_object(
    'catalogs', coalesce((select jsonb_agg(to_jsonb(c) || coalesce(identities.data -> c.catalog_id::text, '{}'::jsonb))
      from public.list_team_product_catalogs(p_team) c cross join identities), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team) p), '[]'::jsonb)
  );
$$;
