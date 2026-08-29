-- Reserving a name in the space root.
--
-- `service_start_team_operation` refused any reservation without a destination
-- material, and the space root is not a material — so uploading, or renaming a
-- file that sits in the root, was rejected as invalid input after every other
-- check had passed. A reservation without a material destination is legitimate
-- now that the root can be a destination at all.
--
-- Uniqueness is kept by folding the root into a single key in the index below:
-- left as a plain nullable column, Postgres would treat every root reservation
-- as distinct from every other, and two people uploading the same name into the
-- root at the same moment would both be told they had it.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

CREATE OR REPLACE FUNCTION public.service_start_team_operation(p_team uuid, p_actor uuid, p_kind text, p_idempotency_key text, p_request_nonce text, p_source_material uuid, p_destination_folder uuid, p_reserved_name_key text, p_reservation_expires_at timestamp with time zone, p_bytes_total bigint)
 RETURNS TABLE(operation_id uuid, state text, reused boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  required_permission text;
  existing public.team_operations%rowtype;
  created_id uuid;
begin
  required_permission := case p_kind
    when 'upload' then 'upload'
    when 'new_version' then 'upload'
    when 'download' then 'download'
    when 'rename' then 'edit'
    when 'move' then 'edit'
    when 'content_edit' then 'edit'
    when 'trash' then 'delete'
    when 'restore' then 'delete'
    when 'process' then 'process'
    else null
  end;
  if required_permission is null
     or p_actor is null
     or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     or p_request_nonce !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     or p_bytes_total < 0
     or not private.can(p_team, required_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_source_material is not null and not exists (
    select 1 from public.team_materials as material
    where material.id = p_source_material
      and material.team_id = p_team
      and material.lifecycle <> 'missing'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_destination_folder is not null and not exists (
    select 1 from public.team_materials as folder
    where folder.id = p_destination_folder
      and folder.team_id = p_team
      and folder.kind = 'folder'
      and folder.lifecycle = 'active'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if (p_reserved_name_key is null) <> (p_reservation_expires_at is null)
     or (p_reserved_name_key is not null and (
       char_length(p_reserved_name_key) not between 1 and 1024
       or p_reservation_expires_at <= pg_catalog.clock_timestamp()
     )) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  update public.team_operations as operation
  set reservation_released_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where operation.reserved_name_key is not null
    and operation.reservation_released_at is null
    and operation.reservation_expires_at <= pg_catalog.clock_timestamp()
    and operation.state in ('pending', 'running');

  select operation.* into existing
  from public.team_operations as operation
  where operation.team_id = p_team
    and operation.actor_id = p_actor
    and operation.kind = p_kind
    and operation.idempotency_key = p_idempotency_key
  for update;
  if existing.id is not null then
    if existing.request_nonce <> p_request_nonce
       or existing.source_material_id is distinct from p_source_material
       or existing.destination_folder_id is distinct from p_destination_folder
       or existing.reserved_name_key is distinct from p_reserved_name_key
       or existing.bytes_total is distinct from p_bytes_total then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    return query select existing.id, existing.state, true;
    return;
  end if;

  begin
    insert into public.team_operations (
      team_id, actor_id, kind, idempotency_key, request_nonce,
      source_material_id, destination_folder_id, reserved_name_key,
      reservation_expires_at, bytes_total
    ) values (
      p_team, p_actor, p_kind, p_idempotency_key, p_request_nonce,
      p_source_material, p_destination_folder, p_reserved_name_key,
      p_reservation_expires_at, p_bytes_total
    ) returning id into created_id;
  exception when unique_violation then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end;
  return query select created_id, 'pending'::text, false;
end;
$function$;

revoke all on function public.service_start_team_operation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.service_start_team_operation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, bigint
) to service_role;

-- The table said the same thing the function did: a reservation needs a
-- destination material. The space root has none, so the row was refused after
-- every check above it had passed.
alter table public.team_operations
  drop constraint if exists team_operations_reservation_check;
alter table public.team_operations
  add constraint team_operations_reservation_check check (
    (reserved_name_key is null and reservation_expires_at is null)
    or (reserved_name_key is not null and reservation_expires_at is not null)
  );

drop index if exists public.team_operations_name_reservation_idx;
create unique index team_operations_name_reservation_idx
  on public.team_operations (
    team_id,
    coalesce(destination_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
    reserved_name_key
  )
  where reserved_name_key is not null and reservation_released_at is null;
