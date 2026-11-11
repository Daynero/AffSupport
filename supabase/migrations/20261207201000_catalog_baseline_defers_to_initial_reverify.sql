-- "Перевірити чинні посилання" (the baseline check) proves that every video
-- cell holds the catalog's ORIGINAL video. A catalog whose create-time
-- verification never finished carries an open initial publication check; for a
-- restitched catalog its cells hold the generated variant files, so the
-- baseline could only ever fail, and for any such catalog the check's own
-- reconciliation row made begin refuse with PROCESS_RESULT_UNCERTAIN. The
-- person saw "Не вдалося підтвердити результат" and nothing changed.
--
-- The server already re-verifies these catalogs itself (20261207196000, the
-- same verification the creation runs, against the right target). Asking for a
-- baseline now hands the catalog to that re-verification: it becomes due at
-- once (an exhausted one gets one more attempt) and the caller is told so,
-- without starting a baseline that cannot succeed. Nothing else changes.
begin;
do $begin_check$
declare d text;
begin
 select pg_get_functiondef('public.service_begin_catalog_baseline_check(uuid,uuid,uuid,uuid,bigint)'::regprocedure) into d;
 if strpos(d,$find$ select * into j from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and revision=p.revision for update;$find$)=0 then raise exception 'BASELINE_INITIAL_REVERIFY_PATCH_MISSING';end if;
 d:=replace(d,$find$ select * into j from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and revision=p.revision for update;$find$,$replace$ if exists(select 1 from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.team_id=p_team and ic.state='reading') then
  insert into private.catalog_initial_publication_reverify(intent_id,team_id,retry_after)
  select ic.intent_id,ic.team_id,'-infinity' from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.team_id=p_team and ic.state='reading'
  on conflict(intent_id) do update set retry_after='-infinity',exhausted_at=null,attempts=least(private.catalog_initial_publication_reverify.attempts,11),updated_at=clock_timestamp();
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp() where id in(select ic.intent_id from private.catalog_initial_publication_checks ic where ic.catalog_material_id=p_catalog and ic.team_id=p_team and ic.state='reading');
  return jsonb_build_object('state','initial_reverify');
 end if;
 select * into j from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and revision=p.revision for update;$replace$);
 execute d;
end $begin_check$;
commit;
