-- Runtime observations are ordered independently of settings version.
create or replace function public.list_team_catalog_manager_snapshot(p_team uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with identities as materialized (
    select public.list_team_catalog_progress_identity(p_team) as data
  )
  select jsonb_build_object(
    'observed_at', statement_timestamp(),
    'catalogs', coalesce((select jsonb_agg(to_jsonb(c) || coalesce(identities.data -> c.catalog_id::text, '{}'::jsonb))
      from public.list_team_product_catalogs(p_team) c cross join identities), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team) p), '[]'::jsonb)
  );
$$;
