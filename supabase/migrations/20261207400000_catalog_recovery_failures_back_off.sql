-- Production 2026-11-12: three catalog creations (two failing with WRONG_STATE, one with
-- RESTITCH_NO_SCREENS) were retried by the recovery pass every minute since the day before,
-- more than 1200 times each. A failed resume leaves the intent with next_attempt_at thirty
-- seconds ahead, and the deferral the pass asks for right after the failure only moved an
-- intent that was already due, so it answered 'unchanged' and the next minute tried again.
--
-- The deferral now always pushes a failed intent at least five minutes out, and an intent that
-- has been failing for more than a day is parked: the automatic pass no longer takes it. The
-- person can still resume it from the browser, which begins the same intent again.

do $defer$
declare d text;
begin
 select pg_get_functiondef('public.service_defer_initial_catalog_recovery(uuid,uuid,text,text)'::regprocedure) into d;
 if strpos(d,$find$    and i.next_attempt_at<=clock_timestamp() then
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where id=i.id;
  return 'deferred';$find$)=0
 then raise exception 'RECOVERY_BACK_OFF_PATCH_MISSING';end if;
 d:=replace(d,$find$    and i.next_attempt_at<=clock_timestamp() then
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where id=i.id;
  return 'deferred';$find$,
  $replace$    then
  if i.created_at<clock_timestamp()-interval '24 hours' then
   update private.catalog_generation_intents set next_attempt_at='infinity',updated_at=clock_timestamp() where id=i.id;
   return 'parked';
  end if;
  update private.catalog_generation_intents set next_attempt_at=greatest(i.next_attempt_at,clock_timestamp()+interval '5 minutes'),updated_at=clock_timestamp() where id=i.id;
  return 'deferred';$replace$);
 execute d;
end $defer$;
