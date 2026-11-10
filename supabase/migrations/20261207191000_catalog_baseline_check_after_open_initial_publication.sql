-- A catalog whose create-time publication verification never finished keeps
-- its initial check in 'reading' together with the reconciliation row that
-- check inserted. The baseline check (the dialog's "verify existing links")
-- refused every such catalog with PROCESS_RESULT_UNCERTAIN because any
-- reconciliation row counted, so the legacy_adoption_required hold could
-- never be released by the person. The baseline check now ignores the open
-- initial check's own row, and on success closes that check and removes its
-- row, the same way the initial path does.
begin;
do $begin_check$
declare d text;
begin
 select pg_get_functiondef('public.service_begin_catalog_baseline_check(uuid,uuid,uuid,uuid,bigint)'::regprocedure) into d;
 if strpos(d,$find$or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN'$find$)=0 then raise exception 'BASELINE_CHECK_RECONCILIATION_PATCH_MISSING';end if;
 d:=replace(d,$find$or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN'$find$,$replace$or exists(select 1 from private.catalog_update_reconciliations r where r.catalog_material_id=p_catalog and not exists(select 1 from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.state='reading' and ic.job_id=r.publication_job_id and ic.fence=r.marker)) then raise exception 'PROCESS_RESULT_UNCERTAIN'$replace$);
 execute d;
end $begin_check$;
do $finish_check$
declare d text;
begin
 select pg_get_functiondef('public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure) into d;
 if strpos(d,$find$ update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where id=b.job_id and state='blocked' and blocked_reason='legacy_adoption_required';$find$)=0 then raise exception 'BASELINE_CHECK_RELEASE_PATCH_MISSING';end if;
 d:=replace(d,$find$ update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where id=b.job_id and state='blocked' and blocked_reason='legacy_adoption_required';$find$,$replace$ update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where id=b.job_id and state='blocked' and blocked_reason='legacy_adoption_required';
 delete from private.catalog_update_reconciliations r using private.catalog_initial_publication_checks ic where ic.catalog_material_id=b.catalog_material_id and ic.state='reading' and r.catalog_material_id=b.catalog_material_id and r.publication_job_id=ic.job_id and r.marker=ic.fence;
 update private.catalog_initial_publication_checks set state='verified',provider_revision=p_provider_revision,cells_digest=p_video_cells_digest,verified_at=clock_timestamp() where catalog_material_id=b.catalog_material_id and state='reading';$replace$);
 execute d;
end $finish_check$;
commit;
