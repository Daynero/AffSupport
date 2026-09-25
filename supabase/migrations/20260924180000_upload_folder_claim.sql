-- Reserve one folder creation per actor/team/request key before calling Drive.
-- This reuses material-operation authority; it creates no progress group or item table.
alter table public.team_operations drop constraint team_operations_kind_check;
alter table public.team_operations add constraint team_operations_kind_check check (
  kind in (
    'upload', 'download', 'rename', 'move', 'trash', 'restore',
    'content_edit', 'new_version', 'process', 'folder_create'
  )
);

create function public.service_claim_upload_folder(
  p_team uuid, p_actor uuid, p_key text, p_parent uuid, p_name text
)
returns table (operation_id uuid, claimed boolean, state text, result_material_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  bound_nonce text;
  created_id uuid;
  existing public.team_operations%rowtype;
begin
  if p_actor is null or p_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     or char_length(p_name) not between 1 and 200
     or not private.can(p_team, 'upload', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_parent is not null and not exists (
    select 1 from public.team_materials as folder
    where folder.id = p_parent and folder.team_id = p_team
      and folder.kind = 'folder' and folder.lifecycle = 'active'
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  bound_nonce := 'folder:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(coalesce(p_parent::text, 'root') || ':' || p_name, 'UTF8'), 'sha256'
  ), 'hex');
  insert into public.team_operations (
    team_id, actor_id, kind, state, idempotency_key, request_nonce, destination_folder_id
  ) values (p_team, p_actor, 'folder_create', 'running', p_key, bound_nonce, p_parent)
  on conflict (team_id, actor_id, kind, idempotency_key) do nothing
  returning id into created_id;
  if created_id is not null then
    return query select created_id, true, 'running'::text, null::uuid;
    return;
  end if;
  select operation.* into existing from public.team_operations as operation
  where operation.team_id = p_team and operation.actor_id = p_actor
    and operation.kind = 'folder_create' and operation.idempotency_key = p_key
  for update;
  if existing.id is null then raise exception 'WRONG_STATE' using errcode = '23514'; end if;
  if existing.request_nonce <> bound_nonce
     or existing.destination_folder_id is distinct from p_parent then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return query select existing.id, false, existing.state, existing.result_material_id;
end;
$$;

revoke all on function public.service_claim_upload_folder(uuid,uuid,text,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_claim_upload_folder(uuid,uuid,text,uuid,text)
  to service_role;
