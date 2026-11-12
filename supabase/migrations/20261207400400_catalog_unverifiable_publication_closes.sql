-- Production 2026-11-12 (DreamTeam, PK 33(адалт)_v6_catalog): «Результат ще не підтверджено» for
-- hours. The publication dispatched at 08:46 left its outcome unknown; the next update then grew
-- the sheet, so every verification since has failed on SOURCE_CHANGED (the product IDs no longer
-- match the frozen recipe) and the job stayed 'unknown' with its update reconciliation open.
-- A verification that compares against a sheet that has moved on can never succeed.
--
-- A dispatched job still unknown two hours later whose last verification said SOURCE_CHANGED is
-- closed as blocked ('stale_job'), and the reconciliation waiting on it is released. The cells
-- are left as they are; the next publication of the catalog writes them again.

create function private.close_unverifiable_catalog_publications(p_limit integer default 20) returns integer
language plpgsql security definer set search_path='' as $$
declare r record; n integer:=0;
begin
 for r in
  select j.id,j.catalog_material_id from private.catalog_video_publication_jobs j
  where j.state='unknown' and j.dispatched_at<clock_timestamp()-interval '2 hours'
   and j.preparation_error_code='SOURCE_CHANGED'
   and (j.lease_until is null or j.lease_until<=clock_timestamp()+interval '1 minute')
   and not private.settle_row_deferred('catalog_publication_unverifiable',j.id)
  order by j.dispatched_at limit p_limit
 loop
  begin
   perform 1 from public.team_materials where id=r.catalog_material_id for update;
   perform 1 from private.catalog_video_publication_policies where catalog_material_id=r.catalog_material_id for update;
   update private.catalog_video_publication_jobs
    set state='blocked',blocked_reason='stale_job',worker_id=null,lease_until=null
    where id=r.id and state='unknown';
   if found then
    delete from private.catalog_update_reconciliations where publication_job_id=r.id;
    insert into public.team_catalog_events(team_id,material_id,event_kind)
     select m.team_id,m.id,'upserted' from public.team_materials m where m.id=r.catalog_material_id;
    n:=n+1;
   end if;
   perform private.clear_settle_row_failure('catalog_publication_unverifiable',r.id);
  exception when others then
   perform private.note_settle_row_failure('catalog_publication_unverifiable',r.id,sqlstate,sqlerrm);
  end;
 end loop;
 return n;
end $$;
revoke all on function private.close_unverifiable_catalog_publications(integer) from public,anon,authenticated,service_role;

select private.close_unverifiable_catalog_publications(100);
select cron.schedule('soty-catalog-unverifiable-publications','*/10 * * * *',$cron$select private.close_unverifiable_catalog_publications()$cron$);
