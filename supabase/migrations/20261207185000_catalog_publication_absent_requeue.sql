-- A dispatched targeted-cells publication whose atomic write (cells + this fence's
-- receipt marker) is provably not in the sheet no longer waits in `unknown` forever.
-- The readback reports `absent`; only after the provider request window has
-- certainly closed (2 minutes; the request times out after 60 s) does the server
-- drop this fence and requeue the same job, which then reserves a new fence and
-- re-proves its sources in a fresh due-validation epoch. Before that window,
-- `absent` is recorded exactly like `unknown`.
begin;
do $settle$
declare d text;
 outcomes text:='if p_outcome not in(''verified'',''unknown'',''waiting'',''blocked'')';
 unknown text:=' if p_outcome=''unknown'' then update private.catalog_video_publication_jobs set state=''unknown'',lease_until=clock_timestamp(),next_attempt_at=clock_timestamp() where id=j.id;return true;end if;';
begin
 select pg_get_functiondef('public.service_settle_catalog_publication(uuid,uuid,uuid,text,text)'::regprocedure)into d;
 if strpos(d,outcomes)=0 or strpos(d,unknown)=0 then raise exception 'CATALOG_PUBLICATION_SETTLE_SEAM_CHANGED';end if;
 d:=replace(d,outcomes,'if p_outcome not in(''verified'',''unknown'',''absent'',''waiting'',''blocked'')');
 d:=replace(d,unknown,$absent$ if p_outcome='absent' and j.state<>'published' and j.dispatched_at<=clock_timestamp()-interval '2 minutes' then
  update private.catalog_video_publication_jobs set state='retry_wait',worker_id=null,lease_until=null,writer_fence=null,dispatched_at=null,validation_epoch_started_at=null,next_attempt_at=clock_timestamp()+interval '30 seconds' where id=j.id;
  delete from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and marker=p_fence and publication_job_id=j.id;
  return true;
 end if;
 if p_outcome in('unknown','absent') then update private.catalog_video_publication_jobs set state='unknown',lease_until=clock_timestamp(),next_attempt_at=clock_timestamp()+case when p_outcome='absent' then interval '30 seconds' else interval '0 seconds' end where id=j.id;return true;end if;$absent$);
 execute d;
end $settle$;
commit;
