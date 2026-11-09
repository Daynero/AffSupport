-- 20261207177000 rebuilt the manager snapshot from an older body and dropped two things
-- 20261207134000/136000 had added: the runtime observation time (`observed_at`) and the
-- per-catalog progress identity (active round/attempt, restitch operation) the manager
-- uses to bind progress to the current round. Restore both; keep 177000's video_generation.
begin;
create or replace function public.list_team_catalog_manager_snapshot(p_team uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare identities jsonb;
begin
 if auth.uid() is null or private.can(p_team,'view',auth.uid()) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 identities:=coalesce(public.list_team_catalog_progress_identity(p_team),'{}'::jsonb);
 return jsonb_build_object(
  'observed_at',statement_timestamp(),
  'catalogs',coalesce((select jsonb_agg(to_jsonb(c)||coalesce(identities->(c.catalog_id::text),'{}'::jsonb)||jsonb_build_object('video_generation',private.catalog_registry_video_generation(p_team,c.catalog_id))) from public.list_team_product_catalogs(p_team)c),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from public.list_team_catalog_update_profiles(p_team)p),'[]'::jsonb));
end;$$;
revoke all on function public.list_team_catalog_manager_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.list_team_catalog_manager_snapshot(uuid) to authenticated;
commit;
