-- A due publication waits while its video set is still being made. The one-hour
-- validation window used to start at the due time, so a set that took longer than
-- an hour after it (many variants, a slow machine, Soty closed for a while) blocked
-- the publication for good ("validation_epoch_expired"). The window now starts only
-- when the videos are ready: every "still waiting" answer clears an undispatched
-- epoch, and the next ready observation starts a fresh one.
begin;
do $ctx$
declare d text;needle text:='return jsonb_build_object(''state'',''waiting'');';
 fresh text:='update private.catalog_video_publication_jobs set validation_epoch_started_at=null where id=j.id and dispatched_at is null;return jsonb_build_object(''state'',''waiting'');';
begin
 select pg_get_functiondef('public.service_catalog_publication_cells_context(uuid,uuid)'::regprocedure)into d;
 if (length(d)-length(replace(d,needle,'')))/length(needle)<>3 or strpos(d,fresh)>0 then raise exception 'PUBLICATION_WAIT_SEAM_CHANGED';end if;
 d:=replace(d,needle,fresh);
 execute d;
end $ctx$;
commit;
