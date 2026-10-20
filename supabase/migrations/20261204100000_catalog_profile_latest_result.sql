-- Add read-only outcome evidence without changing existing schedule/profile semantics.
-- Return types require replacement; keep the same authorization and execution grants.
begin;
drop function public.list_team_catalog_update_profiles(uuid);
create function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean,
  last_result text, latest_attempt_at timestamptz, last_successful_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when exists (
             select 1 from public.team_catalog_restitch_copies as copy
             where copy.catalog_material_id = profile.catalog_material_id and copy.role = 'spare'
           ) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased'
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and job.last_error_code is not null
           ) then 'blocked'
           else 'waiting' end,
           (select job.last_error_code from private.catalog_restitch_jobs as job
            where job.catalog_material_id = profile.catalog_material_id
            limit 1), coalesce(item.reconciliation_required, false),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null)
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$$;

revoke all on function public.list_team_catalog_update_profiles(uuid) from public, anon, authenticated;
grant execute on function public.list_team_catalog_update_profiles(uuid) to authenticated;
commit;
