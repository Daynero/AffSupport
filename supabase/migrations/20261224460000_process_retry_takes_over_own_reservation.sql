-- Production 2026-11-26 (a transcription in the explorer): the agent transcribed the video, then
-- lost the network for a minute on its way to Drive. The run failed on the computer, and the
-- page's "tell the space the run is over" (cancel_team_operation) was sent into the same dead
-- network and dropped. The operation stayed `running`, holding the name «MA 19.txt» for the
-- thirty minutes of its reservation, and every press of «Транскрибувати» in that half hour was
-- refused with «Файл із такою назвою тут уже є» — a file that did not exist, kept by a run that
-- was not happening.
--
-- A fresh request of the same person for the same file, into the same folder under the same
-- name, now takes the place of that person's unfinished one: the old operation is cancelled the
-- way cancel_team_operation cancels it (the person could always have done that themselves), its
-- grants are revoked so a late agent cannot finish it, and the name is free for the new run.
--
-- Only what nothing else depends on is taken over:
--  * a manual run — its idempotency key is a bare UUID, as the explorer queue and the process
--    dialog send it. Library jobs (`library.process.*`), catalog variants (`catalog-variant:*`)
--    and every other keyed flow keep the conflict, because their retries have their own rules;
--  * one that has not started writing to Drive (no ownership row past `prepared`). A run whose
--    upload started may still produce the file, so it keeps the name until it settles or its
--    reservation lapses, as before;
--  * of the same actor, source material, destination folder and reserved name.
--
-- No table or column.
begin;

create or replace function public.service_release_own_process_reservation(
  p_team uuid,
  p_actor uuid,
  p_source uuid,
  p_destination uuid,
  p_name_key text
)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  held public.team_operations%rowtype;
begin
  if p_team is null or p_actor is null or p_source is null or p_name_key is null then
    return null;
  end if;
  select operation.* into held
  from public.team_operations as operation
  where operation.team_id = p_team
    and coalesce(operation.destination_folder_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(p_destination, '00000000-0000-0000-0000-000000000000'::uuid)
    and operation.reserved_name_key = p_name_key
    and operation.reservation_released_at is null
  for update;
  if held.id is null
     or held.kind <> 'process'
     or held.actor_id <> p_actor
     or held.source_material_id is distinct from p_source
     or held.state not in ('pending', 'running')
     or held.result_material_id is not null
     or held.idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or exists (
       select 1 from private.process_upload_ownership as upload
       where upload.operation_id = held.id and upload.upload_state <> 'prepared'
     )
  then
    return null;
  end if;

  update public.team_operations as operation
  set state = 'canceled',
      stage = 'canceled',
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(),
      error_code = null,
      retryable = false,
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = held.id;
  update private.team_transfer_grants as transfer
  set revoked_at = pg_catalog.clock_timestamp()
  where transfer.operation_id = held.id and transfer.revoked_at is null;
  perform private.record_team_audit(
    p_team, p_actor, 'operation.canceled',
    pg_catalog.jsonb_build_object('operation_id', held.id, 'state', 'canceled', 'reason', 'superseded_by_retry'),
    'canceled', null
  );
  return held.id;
end;
$function$;

revoke all on function public.service_release_own_process_reservation(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.service_release_own_process_reservation(uuid, uuid, uuid, uuid, text)
  to service_role;

commit;
