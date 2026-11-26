-- Production 2026-11-26 22:21 UTC: one catalog's publication job asked for its cells every 30
-- seconds and was refused with SOURCE_CHANGED every time — 55 times in 38 minutes, each an HTTP
-- 500 — and would have gone on for a day.
--
-- The person had turned «copy the video to R2» off for a catalog whose re-stitched videos they
-- had deleted from Drive the day before. The R2 reconciliation queued the usual job to write the
-- Drive links back; its videos are gone, so service_catalog_publication_cells_context refuses,
-- rightly and for good.
--
-- That function already means to stop after an hour: it stamps validation_epoch_started_at on
-- the first try and blocks the job once the stamp is an hour old. But it stamps and then raises
-- in the same call, so the stamp is rolled back with the refusal and the hour never begins. The
-- only thing left to stop the job was the daily sweep of jobs a day old
-- (private.settle_catalog_stuck_shapes).
--
-- The worker reports every refused preparation through this function, in its own transaction.
-- So it is here that the hour begins, and here that a refusal which cannot pass by waiting ends:
--
--  * the first reported refusal of a job that is due starts its hour, if nothing had;
--  * SOURCE_CHANGED, PERMISSION_DENIED and SHARE_NOT_ALLOWED — the videos, the access or the
--    sharing itself say no — block the job ten minutes after that, with their own code kept, as
--    `job_blocked`: «Запис посилань у таблицю зупинено. Опублікуйте ще раз.» The window already
--    offers the retry, which gives the job a fresh ten minutes;
--  * a Drive that is slow or busy keeps its hour, which now ends: the cells function blocks it
--    as `target_unavailable`, as it was written to.
--
-- A job that is not due yet, or that a writer has already touched, is left exactly as before.
-- No table or column; nothing is healed here — the one job waiting on production starts its
-- ten minutes with the first refusal after this is applied.
begin;
create or replace function public.service_release_catalog_publication_preparation(p_job uuid, p_worker uuid, p_error_code text default null::text)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare released private.catalog_video_publication_jobs%rowtype;due boolean;
begin
 if p_error_code is not null and p_error_code not in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE')then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 update private.catalog_video_publication_jobs set worker_id=case when writer_fence is null and dispatched_at is null then null else worker_id end,lease_until=case when writer_fence is null and dispatched_at is null then null else lease_until end,next_attempt_at=clock_timestamp()+case when p_error_code is null then interval '0 seconds'else interval '30 seconds'end,preparation_error_code=p_error_code,preparation_error_at=case when p_error_code is not null then clock_timestamp()else null end where id=p_job and worker_id=p_worker returning * into released;
 if released.id is null then return false;end if;
 if p_error_code is null or released.dispatched_at is not null or released.writer_fence is not null
  or released.state not in('waiting','preparing','retry_wait') then return true;end if;
 select (policy.mode='immediate' or (policy.mode='scheduled' and policy.due_at<=clock_timestamp())) into due
  from private.catalog_video_publication_policies policy
  where policy.catalog_material_id=released.catalog_material_id and policy.revision=released.revision;
 if due is not true then return true;end if;
 if released.validation_epoch_started_at is null then
  -- The stamp the cells function set and lost when it raised.
  update private.catalog_video_publication_jobs set validation_epoch_started_at=clock_timestamp() where id=released.id;
 elsif p_error_code in('SOURCE_CHANGED','PERMISSION_DENIED','SHARE_NOT_ALLOWED')
  and released.validation_epoch_started_at<clock_timestamp()-interval '10 minutes' then
  update private.catalog_video_publication_jobs set state='blocked',blocked_reason='job_blocked',worker_id=null,lease_until=null where id=released.id;
  -- Open pages read the catalog again and show the stopped write.
  insert into public.team_catalog_events(team_id,material_id,event_kind) values(released.team_id,released.catalog_material_id,'upserted');
 end if;
 return true;
end $function$;
commit;
