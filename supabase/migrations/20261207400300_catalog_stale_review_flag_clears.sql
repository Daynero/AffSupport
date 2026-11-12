-- Production 2026-11-12 (DreamTeam, GR 2_v2_catalog): the manager showed «Потрібна перевірка ·
-- деталі» — "contact support" — for a catalog with nothing to review. A park set
-- CATALOG_ATTEMPT_STATE_INCONSISTENT on 2026-11-10; the catalog then left auto-update, so its
-- updater item was gone, there was no reconciliation and nothing running. The only pass that
-- clears the flag does it while freeing a quarantined item, and there was no item to free.
--
-- The flag now clears whenever nothing backs it: no item waiting for reconciliation, no
-- reconciliation row, no attempt running or unknown. Once now, then every ten minutes.

create function private.clear_stale_catalog_review_flags(p_limit integer default 200) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 with stale as (
  select c.material_id from public.team_product_catalogs c
  where c.last_update_error='CATALOG_ATTEMPT_STATE_INCONSISTENT'
   and not exists(select 1 from public.team_catalog_updater_items i
    where i.catalog_material_id=c.material_id and i.reconciliation_required)
   and not exists(select 1 from private.catalog_update_reconciliations r where r.catalog_material_id=c.material_id)
   and not exists(select 1 from public.team_catalog_update_attempts a
    where a.catalog_material_id=c.material_id and a.team_id=c.team_id and a.result in('running','unknown'))
  limit p_limit
 )
 update public.team_product_catalogs c set last_update_error=null,last_update_error_at=null
  from stale where c.material_id=stale.material_id;
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function private.clear_stale_catalog_review_flags(integer) from public,anon,authenticated,service_role;

select private.clear_stale_catalog_review_flags(1000);
select cron.schedule('soty-catalog-stale-review-flags','*/10 * * * *',$cron$select private.clear_stale_catalog_review_flags()$cron$);
