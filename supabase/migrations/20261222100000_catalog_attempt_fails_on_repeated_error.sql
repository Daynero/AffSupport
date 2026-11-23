-- Production 2026-11-20 (DreamTeam, TR 84_v1): a catalog update that failed, was run again and
-- failed the same way never ended. The first attempt closed as 'failed' after its third try;
-- the next two stayed 'running' for good — a spinner on the catalog row, a retry every fifteen
-- minutes, a re-stitch round cut for each — until the user cancelled one by hand.
--
-- private.track_catalog_update_result() closes the running attempt when the catalog's
-- last_update_error becomes *another* value. service_retry_catalog_update records the error
-- from the third try on, and the first time that takes the column from null to the code. On a
-- later attempt the column already holds that code, the value is "not distinct", and nothing
-- closes the attempt. A failure that repeats is the commonest kind there is.
--
-- Every writer of last_update_error stamps last_update_error_at in the same statement
-- (service_retry_catalog_update, service_park_catalog_update_claim,
-- private.close_unreachable_catalog_rounds), so a new stamp with an unchanged code is what
-- "the same error was recorded again" looks like.
--
-- That case closes one attempt only: the running attempt of the round the catalog is in now.
-- The trigger is deferred, so it reads the round as the statement's transaction leaves it —
-- a retry keeps the round, while park and close_unreachable clear it after closing their own
-- attempt, and then there is nothing for this branch to do. An older attempt left 'unknown'
-- belongs to reconciliation and is never touched here. A code that changes keeps exactly the
-- behaviour it had (the first branch, unchanged).
--
-- The body below is the live definition (20261207177000) with that one branch added. The
-- trigger itself (after update of update_count, last_update_error) fires on these statements
-- already and is left as it is.
begin;

create or replace function private.track_catalog_update_result()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_link text;
  wants_video boolean;
begin
  if new.update_count > old.update_count and exists(select 1 from private.catalog_variant_round_snapshots r where r.catalog_material_id=new.material_id and r.source_kind='updater' and r.regular_released and exists(select 1 from public.team_catalog_update_attempts a where a.attempt_id=r.attempt_id and a.result in('running','unknown'))) then
    return new;
  end if;
  if new.update_count > old.update_count then
    select record.current_video_link,
           coalesce((select (attempt.profile_snapshot ->> 'restitch')::boolean
                     from public.team_catalog_update_attempts as attempt
                     where attempt.catalog_material_id = new.material_id
                       and attempt.result in ('running', 'unknown', 'cancelled', 'failed')
                     order by attempt.started_at desc limit 1), profile.restitch)
      into current_link, wants_video
    from public.team_product_catalogs as record
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = record.material_id
    where record.material_id = new.material_id;
    update public.team_catalog_update_attempts as attempt
       set result = case when wants_video and current_link is not distinct from old.current_video_link
                         then 'partial' else 'success' end,
           ended_at = clock_timestamp(), delivery_verified_at = clock_timestamp(),
           failure_code = null,
           actual_changes = coalesce(attempt.actual_changes, '{}'::jsonb) ||
             jsonb_build_object('videoReplaced', wants_video and
               current_link is distinct from old.current_video_link)
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id
         and recent.result in ('running', 'unknown', 'cancelled', 'failed')
       order by recent.started_at desc limit 1
     );
  elsif new.last_update_error is distinct from old.last_update_error
        and new.last_update_error is not null then
    update public.team_catalog_update_attempts as attempt
       set result = 'failed', failure_code = new.last_update_error,
           ended_at = clock_timestamp()
     where attempt.attempt_id = (
       select recent.attempt_id from public.team_catalog_update_attempts as recent
       where recent.catalog_material_id = new.material_id and recent.result in ('running', 'unknown')
       order by recent.started_at desc limit 1
     );
  elsif new.last_update_error is not null
        and new.last_update_error_at is distinct from old.last_update_error_at then
    -- The same error, recorded again (20261222100000): the current round's attempt ends.
    update public.team_catalog_update_attempts as attempt
       set result = 'failed', failure_code = new.last_update_error,
           ended_at = clock_timestamp()
      from public.team_catalog_updater_items as item
     where item.catalog_material_id = new.material_id
       and attempt.catalog_material_id = new.material_id
       and attempt.round_due_at = item.round_due_at
       and attempt.result = 'running';
  end if;
  return null;
end;
$function$;

commit;
