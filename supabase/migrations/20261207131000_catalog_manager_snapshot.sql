-- One MVCC snapshot for registry, schedule, profile version and runtime facts.
-- Both existing projections retain their own membership/view checks.
create function public.list_team_catalog_manager_snapshot(p_team uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'catalogs', coalesce((select jsonb_agg(to_jsonb(c)) from public.list_team_product_catalogs(p_team) c), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team) p), '[]'::jsonb)
  );
$$;
revoke all on function public.list_team_catalog_manager_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.list_team_catalog_manager_snapshot(uuid) to authenticated;
