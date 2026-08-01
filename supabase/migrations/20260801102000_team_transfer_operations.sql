-- Caller-safe operation/provenance reads and service-only Drive mutation sagas.
-- Resumable session URIs are deliberately not persisted in any table.

create table private.team_operation_intents (
  operation_id uuid primary key references public.team_operations(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  expected_name text,
  mime_type text,
  expected_size bigint,
  replace_material_id uuid references public.team_materials(id) on delete restrict,
  version_of_material_id uuid references public.team_materials(id) on delete restrict,
  relation text,
  tool_id text,
  tool_contract_version integer,
  expected_source_drive_file_id text,
  expected_source_version text,
  expected_source_checksum text,
  provider_result_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_operation_intents_name_length check (
    expected_name is null or char_length(expected_name) between 1 and 1024
  ),
  constraint team_operation_intents_mime_length check (
    mime_type is null or char_length(mime_type) between 1 and 255
  ),
  constraint team_operation_intents_size_check check (
    expected_size is null or expected_size >= 0
  ),
  constraint team_operation_intents_relation_check check (
    relation is null or relation in ('processed_from', 'version_of')
  ),
  constraint team_operation_intents_tool_version_check check (
    tool_contract_version is null or tool_contract_version >= 1
  ),
  constraint team_operation_intents_version_replace_check check (
    version_of_material_id is null or replace_material_id is null
  ),
  unique (operation_id, team_id)
);

create index team_operation_intents_team_idx
  on private.team_operation_intents (team_id, created_at desc);
create index team_operation_intents_provider_result_idx
  on private.team_operation_intents (team_id, provider_result_id)
  where provider_result_id is not null;

alter table private.team_operation_intents enable row level security;
alter table private.team_operation_intents force row level security;
revoke all on table private.team_operation_intents from public, anon, authenticated;

comment on table private.team_operation_intents is
  'Private exact-result bindings for idempotent Drive operation sagas; never stores resumable URIs.';

create or replace function public.get_operation(p_team uuid, p_operation uuid)
returns table (
  id uuid,
  team_id uuid,
  kind text,
  state text,
  stage text,
  progress integer,
  source_material_id uuid,
  result_material_id uuid,
  error_code text,
  retryable boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select operation.id,
         operation.team_id,
         operation.kind,
         operation.state,
         operation.stage,
         operation.progress::integer,
         operation.source_material_id,
         operation.result_material_id,
         operation.error_code,
         operation.retryable,
         operation.created_at,
         operation.updated_at
  from public.team_operations as operation
  where operation.id = p_operation
    and operation.team_id = p_team
  limit 1;
end;
$$;

revoke all on function public.get_operation(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_operation(uuid, uuid) to authenticated;

create or replace function public.get_material_provenance(p_team uuid, p_material uuid)
returns table (
  link_id uuid,
  relation text,
  source_material_id uuid,
  derivative_material_id uuid,
  source_name_snapshot text,
  source_name text,
  source_lifecycle text,
  derivative_name text,
  derivative_lifecycle text,
  tool_id text,
  tool_contract_version integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.team_materials as material
    where material.id = p_material and material.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return query
  select link.id,
         link.relation,
         link.source_material_id,
         link.derivative_material_id,
         link.source_name_snapshot,
         source.name,
         source.lifecycle,
         derivative.name,
         derivative.lifecycle,
         link.tool_id,
         link.tool_contract_version,
         link.created_at
  from public.team_material_links as link
  join public.team_materials as source
    on source.id = link.source_material_id and source.team_id = link.team_id
  join public.team_materials as derivative
    on derivative.id = link.derivative_material_id and derivative.team_id = link.team_id
  where link.team_id = p_team
    and (link.source_material_id = p_material or link.derivative_material_id = p_material)
  order by link.created_at, link.id;
end;
$$;

revoke all on function public.get_material_provenance(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_material_provenance(uuid, uuid) to authenticated;

create or replace function public.cancel_team_operation(p_team uuid, p_operation uuid)
returns table (
  id uuid,
  team_id uuid,
  kind text,
  state text,
  stage text,
  progress integer,
  source_material_id uuid,
  result_material_id uuid,
  error_code text,
  retryable boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation
    and operation.team_id = p_team
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.actor_id <> auth.uid() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if operation_row.state in ('pending', 'running') then
    update public.team_operations as operation
    set state = 'canceled',
        stage = 'canceled',
        reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
        finished_at = pg_catalog.clock_timestamp(),
        error_code = null,
        retryable = false,
        updated_at = pg_catalog.clock_timestamp()
    where operation.id = p_operation;
    update private.team_transfer_grants as transfer
    set revoked_at = pg_catalog.clock_timestamp()
    where transfer.operation_id = p_operation and transfer.revoked_at is null;
    perform private.record_team_audit(
      p_team, auth.uid(), 'operation.canceled',
      pg_catalog.jsonb_build_object('operation_id', p_operation, 'state', 'canceled'),
      'canceled', null
    );
  end if;
  return query select * from public.get_operation(p_team, p_operation);
end;
$$;

revoke all on function public.cancel_team_operation(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.cancel_team_operation(uuid, uuid) to authenticated;

create or replace function public.service_start_team_operation(
  p_team uuid,
  p_actor uuid,
  p_kind text,
  p_idempotency_key text,
  p_request_nonce text,
  p_source_material uuid,
  p_destination_folder uuid,
  p_reserved_name_key text,
  p_reservation_expires_at timestamptz,
  p_bytes_total bigint
)
returns table (operation_id uuid, state text, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
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
       p_destination_folder is null
       or char_length(p_reserved_name_key) not between 1 and 1024
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
$$;

revoke all on function public.service_start_team_operation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.service_start_team_operation(
  uuid, uuid, text, text, text, uuid, uuid, text, timestamptz, bigint
) to service_role;

create or replace function public.service_set_team_operation_intent(
  p_operation uuid,
  p_actor uuid,
  p_expected_name text,
  p_mime_type text,
  p_expected_size bigint,
  p_replace_material uuid,
  p_version_of_material uuid,
  p_tool text,
  p_tool_contract_version integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
  relation_value text;
  intent_row private.team_operation_intents%rowtype;
begin
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state not in ('pending', 'running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  relation_value := case operation_row.kind
    when 'new_version' then 'version_of'
    when 'process' then 'processed_from'
    else null
  end;
  if p_expected_name is not null and char_length(p_expected_name) not between 1 and 1024
     or p_mime_type is not null and char_length(p_mime_type) not between 1 and 255
     or p_expected_size is not null and p_expected_size < 0
     or p_replace_material is not null and p_version_of_material is not null
     or operation_row.kind = 'new_version' and p_version_of_material is null
     or operation_row.kind = 'process' and (operation_row.source_material_id is null or p_tool is null)
     or p_version_of_material is not null and p_version_of_material <> operation_row.source_material_id
     or p_replace_material is not null and not exists (
       select 1 from public.team_materials as material
       where material.id = p_replace_material and material.team_id = operation_row.team_id
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into private.team_operation_intents as stored (
    operation_id, team_id, expected_name, mime_type, expected_size,
    replace_material_id, version_of_material_id, relation, tool_id, tool_contract_version
  ) values (
    p_operation, operation_row.team_id, p_expected_name, p_mime_type, p_expected_size,
    p_replace_material, p_version_of_material, relation_value, p_tool, p_tool_contract_version
  ) on conflict (operation_id) do update
  set expected_size = case
        when stored.expected_size is null
          and operation_row.kind = 'process' then excluded.expected_size
        else stored.expected_size
      end,
      updated_at = pg_catalog.clock_timestamp();
  select intent.* into intent_row
  from private.team_operation_intents as intent
  where intent.operation_id = p_operation;
  if intent_row.expected_name is distinct from p_expected_name
     or intent_row.mime_type is distinct from p_mime_type
     or intent_row.expected_size is distinct from p_expected_size
     or intent_row.replace_material_id is distinct from p_replace_material
     or intent_row.version_of_material_id is distinct from p_version_of_material
     or intent_row.tool_id is distinct from p_tool
     or intent_row.tool_contract_version is distinct from p_tool_contract_version then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return true;
end;
$$;

revoke all on function public.service_set_team_operation_intent(
  uuid, uuid, text, text, bigint, uuid, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.service_set_team_operation_intent(
  uuid, uuid, text, text, bigint, uuid, uuid, text, integer
) to service_role;

create or replace function public.service_get_team_operation(p_operation uuid, p_actor uuid)
returns table (
  operation_id uuid,
  team_id uuid,
  actor_id uuid,
  kind text,
  state text,
  stage text,
  progress integer,
  source_material_id uuid,
  destination_folder_id uuid,
  result_material_id uuid,
  expected_name text,
  mime_type text,
  expected_size bigint,
  replace_material_id uuid,
  version_of_material_id uuid,
  relation text,
  tool_id text,
  tool_contract_version integer,
  provider_result_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select operation.id,
         operation.team_id,
         operation.actor_id,
         operation.kind,
         operation.state,
         operation.stage,
         operation.progress::integer,
         operation.source_material_id,
         operation.destination_folder_id,
         operation.result_material_id,
         intent.expected_name,
         intent.mime_type,
         intent.expected_size,
         intent.replace_material_id,
         intent.version_of_material_id,
         intent.relation,
         intent.tool_id,
         intent.tool_contract_version,
         intent.provider_result_id
  from public.team_operations as operation
  left join private.team_operation_intents as intent on intent.operation_id = operation.id
  where operation.id = p_operation and operation.actor_id = p_actor
  limit 1;
$$;

revoke all on function public.service_get_team_operation(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_team_operation(uuid, uuid) to service_role;

create or replace function public.service_bind_team_operation_source(
  p_operation uuid,
  p_actor uuid,
  p_drive_file_id text,
  p_drive_version text,
  p_checksum text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
begin
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null or operation_row.source_material_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if operation_row.state not in ('pending','running')
     or p_drive_file_id is null
     or char_length(p_drive_file_id) not between 1 and 1024 then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  update private.team_operation_intents as intent
  set expected_source_drive_file_id = coalesce(intent.expected_source_drive_file_id, p_drive_file_id),
      expected_source_version = coalesce(intent.expected_source_version, p_drive_version),
      expected_source_checksum = coalesce(intent.expected_source_checksum, p_checksum),
      updated_at = pg_catalog.clock_timestamp()
  where intent.operation_id = p_operation
    and intent.team_id = operation_row.team_id
    and (intent.expected_source_drive_file_id is null or intent.expected_source_drive_file_id = p_drive_file_id)
    and (intent.expected_source_version is null or intent.expected_source_version is not distinct from p_drive_version)
    and (intent.expected_source_checksum is null or intent.expected_source_checksum is not distinct from p_checksum);
  if not found then raise exception 'SOURCE_CHANGED' using errcode = '23514'; end if;
  return true;
end;
$$;

revoke all on function public.service_bind_team_operation_source(uuid, uuid, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_bind_team_operation_source(uuid, uuid, text, text, text)
to service_role;

create or replace function public.service_get_team_operation_source_binding(
  p_operation uuid,
  p_actor uuid
)
returns table (drive_file_id text, drive_version text, checksum text)
language sql
stable
security definer
set search_path = ''
as $$
  select intent.expected_source_drive_file_id,
         intent.expected_source_version,
         intent.expected_source_checksum
  from private.team_operation_intents as intent
  join public.team_operations as operation on operation.id = intent.operation_id
  where operation.id = p_operation and operation.actor_id = p_actor
  limit 1;
$$;

revoke all on function public.service_get_team_operation_source_binding(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_team_operation_source_binding(uuid, uuid)
to service_role;

create or replace function public.service_get_material_operation_context(
  p_team uuid,
  p_material uuid,
  p_actor uuid,
  p_permission text,
  p_allow_trashed boolean default false
)
returns table (
  team_id uuid,
  material_id uuid,
  actor_id uuid,
  connection_id uuid,
  credential_id uuid,
  root_folder_id text,
  root_resource_key text,
  drive_id text,
  drive_file_id text,
  resource_key text,
  parent_folder_id text,
  name text,
  kind text,
  lifecycle text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  drive_version text,
  checksum text,
  transcript_ingest_state text,
  transcript_truncated boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select material.team_id,
         material.id,
         p_actor,
         connection.id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id,
         material.drive_file_id,
         material.resource_key,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.lifecycle,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.drive_version,
         material.checksum,
         material.transcript_ingest_state,
         material.transcript_truncated
  from public.team_materials as material
  join public.team_drive_connections as connection
    on connection.id = material.connection_id
   and connection.team_id = material.team_id
  where material.id = p_material
    and material.team_id = p_team
    and connection.state = 'connected'
    and (material.lifecycle = 'active' or (p_allow_trashed and material.lifecycle = 'trashed'))
    and p_permission in ('view','download','upload','edit','delete','process','manage_metadata')
    and private.can(p_team, p_permission, p_actor)
  limit 1;
$$;

revoke all on function public.service_get_material_operation_context(uuid, uuid, uuid, text, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_material_operation_context(uuid, uuid, uuid, text, boolean)
to service_role;

create or replace function public.service_resolve_team_folder(
  p_team uuid,
  p_actor uuid,
  p_drive_folder_id text,
  p_permission text
)
returns table (material_id uuid, drive_file_id text, resource_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select folder.id, folder.drive_file_id, folder.resource_key
  from public.team_materials as folder
  where folder.team_id = p_team
    and folder.drive_file_id = p_drive_folder_id
    and folder.kind = 'folder'
    and folder.lifecycle = 'active'
    and p_permission in ('view','download','upload','edit','delete','process','manage_metadata')
    and private.can(p_team, p_permission, p_actor)
  limit 1;
$$;

revoke all on function public.service_resolve_team_folder(uuid, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_resolve_team_folder(uuid, uuid, text, text)
to service_role;

create or replace function public.service_find_team_name_conflicts(
  p_team uuid,
  p_destination_folder uuid,
  p_actor uuid,
  p_reserved_name_key text
)
returns table (material_id uuid, name text, drive_file_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select material.id, material.name, material.drive_file_id
  from public.team_materials as destination
  join public.team_materials as material
    on material.team_id = destination.team_id
   and material.parent_folder_id = destination.drive_file_id
  where destination.id = p_destination_folder
    and destination.team_id = p_team
    and destination.kind = 'folder'
    and destination.lifecycle = 'active'
    and material.lifecycle = 'active'
    and pg_catalog.lower(
      pg_catalog.regexp_replace(pg_catalog.btrim(material.name), '\s+', ' ', 'g')
    ) = p_reserved_name_key
    and private.can(p_team, 'view', p_actor)
  order by material.id;
$$;

revoke all on function public.service_find_team_name_conflicts(uuid, uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_find_team_name_conflicts(uuid, uuid, uuid, text)
to service_role;

create or replace function public.service_transition_team_operation(
  p_operation uuid,
  p_state text,
  p_stage text,
  p_progress integer,
  p_result_material uuid,
  p_error_code text,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
begin
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state in ('succeeded', 'canceled', 'failed') then
    if operation_row.state = p_state then return true; end if;
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  if p_state not in ('pending','running','succeeded','canceled','failed')
     or p_progress not between operation_row.progress and 100
     or p_stage is not null and char_length(p_stage) not between 1 and 64
     or p_result_material is not null and not exists (
       select 1 from public.team_materials as material
       where material.id = p_result_material and material.team_id = operation_row.team_id
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_operations as operation
  set state = p_state,
      stage = p_stage,
      progress = case when p_state = 'succeeded' then 100 else p_progress end,
      result_material_id = coalesce(p_result_material, operation.result_material_id),
      error_code = case when p_state = 'failed' then p_error_code else null end,
      retryable = case when p_state = 'failed' then coalesce(p_retryable, false) else false end,
      reservation_released_at = case
        when p_state in ('succeeded','canceled','failed')
          then coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp())
        else operation.reservation_released_at
      end,
      finished_at = case
        when p_state in ('succeeded','canceled','failed') then pg_catalog.clock_timestamp()
        else null
      end,
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  if p_state in ('succeeded','canceled','failed') then
    update private.team_transfer_grants as transfer
    set revoked_at = pg_catalog.clock_timestamp()
    where transfer.operation_id = p_operation and transfer.revoked_at is null;
  end if;
  return true;
end;
$$;

revoke all on function public.service_transition_team_operation(
  uuid, text, text, integer, uuid, text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.service_transition_team_operation(
  uuid, text, text, integer, uuid, text, boolean
) to service_role;

create or replace function public.service_release_team_name_reservation(p_operation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.team_operations as operation
  set reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation
    and operation.state in ('pending','running');
  return found;
end;
$$;

revoke all on function public.service_release_team_name_reservation(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_release_team_name_reservation(uuid) to service_role;

create or replace function public.service_finalize_uploaded_material(
  p_operation uuid,
  p_actor uuid,
  p_drive jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
  intent_row private.team_operation_intents%rowtype;
  destination public.team_materials%rowtype;
  source public.team_materials%rowtype;
  result_row public.team_materials%rowtype;
  actual_drive_file_id text;
  actual_name text;
  actual_mime text;
  actual_parent text;
  actual_kind text;
  actual_category text;
  actual_extension text;
  actual_classification_source text;
  actual_size bigint;
  actual_modified_at timestamptz;
  actual_version text;
  actual_checksum text;
  actual_drive_id text;
  actual_resource_key text;
  required_permission text;
begin
  if pg_catalog.jsonb_typeof(p_drive) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_drive) as key(name)
       where key.name not in (
         'driveFileId','driveId','resourceKey','parentFolderId','name','mimeType',
         'fileExtension','kind','category','classificationSource','sizeBytes',
         'modifiedAt','driveVersion','checksum'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state = 'succeeded' and operation_row.result_material_id is not null then
    return pg_catalog.jsonb_build_object(
      'operationId', operation_row.id,
      'state', operation_row.state,
      'materialId', operation_row.result_material_id,
      'reused', true
    );
  end if;
  if operation_row.kind not in ('upload','new_version','process')
     or operation_row.state not in ('pending','running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  required_permission := case when operation_row.kind = 'process' then 'process' else 'upload' end;
  if not private.can(operation_row.team_id, required_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select intent.* into intent_row
  from private.team_operation_intents as intent
  where intent.operation_id = p_operation and intent.team_id = operation_row.team_id;
  if intent_row.operation_id is null then raise exception 'WRONG_STATE' using errcode = '23514'; end if;
  select folder.* into destination
  from public.team_materials as folder
  where folder.id = operation_row.destination_folder_id
    and folder.team_id = operation_row.team_id
    and folder.kind = 'folder'
    and folder.lifecycle = 'active';
  if destination.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.source_material_id is not null then
    select material.* into source
    from public.team_materials as material
    where material.id = operation_row.source_material_id
      and material.team_id = operation_row.team_id;
    if source.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if intent_row.expected_source_drive_file_id is not null and (
      source.drive_file_id is distinct from intent_row.expected_source_drive_file_id
      or source.drive_version is distinct from intent_row.expected_source_version
      or source.checksum is distinct from intent_row.expected_source_checksum
    ) then
      raise exception 'SOURCE_CHANGED' using errcode = '23514';
    end if;
  end if;

  actual_drive_file_id := p_drive ->> 'driveFileId';
  actual_name := p_drive ->> 'name';
  actual_mime := p_drive ->> 'mimeType';
  actual_parent := p_drive ->> 'parentFolderId';
  actual_kind := coalesce(p_drive ->> 'kind', 'file');
  actual_category := p_drive ->> 'category';
  actual_extension := p_drive ->> 'fileExtension';
  actual_classification_source := coalesce(p_drive ->> 'classificationSource', 'fallback');
  actual_size := nullif(p_drive ->> 'sizeBytes', '')::bigint;
  actual_modified_at := nullif(p_drive ->> 'modifiedAt', '')::timestamptz;
  actual_version := p_drive ->> 'driveVersion';
  actual_checksum := p_drive ->> 'checksum';
  actual_drive_id := p_drive ->> 'driveId';
  actual_resource_key := p_drive ->> 'resourceKey';
  if actual_drive_file_id is null or char_length(actual_drive_file_id) not between 1 and 1024
     or actual_name is distinct from intent_row.expected_name
     or actual_mime is distinct from intent_row.mime_type
     or actual_parent is distinct from destination.drive_file_id
     or actual_kind <> 'file'
     or actual_category not in ('video','image','archive','transcript','landing','other')
     or actual_classification_source not in ('mime','extension','inspected_landing','fallback')
     or actual_size is distinct from intent_row.expected_size
     or intent_row.replace_material_id is null and source.id is not null
        and actual_drive_file_id = source.drive_file_id
     or intent_row.replace_material_id is not null and not exists (
       select 1 from public.team_materials as replacement
       where replacement.id = intent_row.replace_material_id
         and replacement.team_id = operation_row.team_id
         and replacement.drive_file_id = actual_drive_file_id
     ) then
    raise exception 'SOURCE_CHANGED' using errcode = '23514';
  end if;

  if intent_row.replace_material_id is not null then
    update public.team_materials as material
    set connection_id = destination.connection_id,
        drive_id = actual_drive_id,
        resource_key = actual_resource_key,
        parent_folder_id = actual_parent,
        name = actual_name,
        mime_type = actual_mime,
        file_extension = actual_extension,
        kind = 'file',
        category = actual_category,
        classification_version = 1,
        classification_source = actual_classification_source,
        size_bytes = actual_size,
        modified_at = actual_modified_at,
        drive_version = actual_version,
        checksum = actual_checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        transcript_text = null,
        transcript_ingest_state = case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
        transcript_truncated = false,
        transcript_indexed_bytes = 0,
        transcript_source_version = null,
        transcript_source_checksum = null,
        preview_state = 'pending',
        preview_error_code = null,
        updated_at = pg_catalog.clock_timestamp()
    where material.id = intent_row.replace_material_id
      and material.team_id = operation_row.team_id
    returning material.* into result_row;
  else
    insert into public.team_materials (
      team_id, connection_id, drive_file_id, drive_id, resource_key,
      parent_folder_id, name, mime_type, file_extension, kind, category,
      classification_version, classification_source, size_bytes, modified_at,
      drive_version, checksum, lifecycle, geo, language, offer, tags,
      transcript_ingest_state, preview_state
    ) values (
      operation_row.team_id, destination.connection_id, actual_drive_file_id, actual_drive_id, actual_resource_key,
      actual_parent, actual_name, actual_mime, actual_extension, 'file', actual_category,
      1, actual_classification_source, actual_size, actual_modified_at,
      actual_version, actual_checksum, 'active', source.geo, source.language, source.offer,
      coalesce(source.tags, '{}'::text[]),
      case when actual_category = 'transcript' then 'pending' else 'not_applicable' end,
      'pending'
    )
    on conflict (team_id, drive_file_id) do update
    set connection_id = excluded.connection_id,
        drive_id = excluded.drive_id,
        resource_key = excluded.resource_key,
        parent_folder_id = excluded.parent_folder_id,
        name = excluded.name,
        mime_type = excluded.mime_type,
        file_extension = excluded.file_extension,
        category = excluded.category,
        classification_version = excluded.classification_version,
        classification_source = excluded.classification_source,
        size_bytes = excluded.size_bytes,
        modified_at = excluded.modified_at,
        drive_version = excluded.drive_version,
        checksum = excluded.checksum,
        lifecycle = 'active',
        trashed_at = null,
        missing_at = null,
        updated_at = pg_catalog.clock_timestamp()
    returning public.team_materials.* into result_row;
  end if;

  if intent_row.relation is not null then
    if source.id is null or source.id = result_row.id then
      raise exception 'MATERIAL_LINK_CYCLE' using errcode = '23514';
    end if;
    insert into public.team_material_links (
      team_id, source_material_id, derivative_material_id, relation,
      source_name_snapshot, tool_id, tool_contract_version, created_by
    ) values (
      operation_row.team_id, source.id, result_row.id, intent_row.relation,
      source.name, intent_row.tool_id, intent_row.tool_contract_version, p_actor
    ) on conflict (team_id, source_material_id, derivative_material_id, relation) do nothing;
  end if;

  if operation_row.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = pg_catalog.clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations as operation
  set state = 'succeeded',
      stage = 'completed',
      progress = 100,
      result_material_id = result_row.id,
      bytes_completed = case
        when operation.kind = 'process' then coalesce(operation.bytes_total, 0)
        else coalesce(intent_row.expected_size, 0)
      end,
      error_code = null,
      retryable = false,
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  update private.team_operation_intents
  set provider_result_id = actual_drive_file_id, updated_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation;
  update private.team_transfer_grants
  set revoked_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation and revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (operation_row.team_id, result_row.id, 'upserted');
  perform private.record_team_audit(
    operation_row.team_id, p_actor,
    case operation_row.kind
      when 'new_version' then 'material.version_created'
      when 'process' then 'material.processed'
      else 'material.uploaded'
    end,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'material_id', result_row.id,
      'operation_id', p_operation,
      'relation', intent_row.relation
    )),
    'succeeded', null
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation,
    'state', 'succeeded',
    'materialId', result_row.id,
    'reused', false
  );
end;
$$;

revoke all on function public.service_finalize_uploaded_material(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_finalize_uploaded_material(uuid, uuid, jsonb)
to service_role;

create or replace function public.service_commit_team_text_edit(
  p_operation uuid,
  p_actor uuid,
  p_expected_version text,
  p_expected_checksum text,
  p_new_version text,
  p_new_checksum text,
  p_text text,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
  material_row public.team_materials%rowtype;
begin
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state = 'succeeded' then
    return pg_catalog.jsonb_build_object(
      'operationId', p_operation, 'state', 'succeeded',
      'materialId', operation_row.result_material_id, 'reused', true
    );
  end if;
  select material.* into material_row
  from public.team_materials as material
  where material.id = operation_row.source_material_id
    and material.team_id = operation_row.team_id
  for update;
  if operation_row.kind <> 'content_edit' or operation_row.state not in ('pending','running')
     or material_row.id is null then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  if not private.can(operation_row.team_id, 'view', p_actor)
     or not private.can(operation_row.team_id, 'edit', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if material_row.kind <> 'file'
     or material_row.lifecycle <> 'active'
     or pg_catalog.lower(coalesce(material_row.file_extension, '')) <> 'txt'
     or material_row.transcript_ingest_state <> 'full'
     or material_row.transcript_truncated
     or material_row.size_bytes > 1048576
     or pg_catalog.octet_length(p_text) > 1048576
     or p_size_bytes <> pg_catalog.octet_length(p_text) then
    raise exception 'UNSUPPORTED_MEDIA' using errcode = '22023';
  end if;
  if material_row.drive_version is distinct from p_expected_version
     or material_row.checksum is distinct from p_expected_checksum
     or p_new_version is null
     or p_new_version = p_expected_version then
    raise exception 'SOURCE_CHANGED' using errcode = '23514';
  end if;
  update public.team_materials as material
  set size_bytes = p_size_bytes,
      drive_version = p_new_version,
      checksum = p_new_checksum,
      modified_at = pg_catalog.clock_timestamp(),
      transcript_text = p_text,
      transcript_ingest_state = 'full',
      transcript_truncated = false,
      transcript_indexed_bytes = p_size_bytes::integer,
      transcript_source_version = p_new_version,
      transcript_source_checksum = p_new_checksum,
      transcript_ingested_at = pg_catalog.clock_timestamp(),
      transcript_error_code = null,
      preview_state = 'ready',
      preview_error_code = null,
      updated_at = pg_catalog.clock_timestamp()
  where material.id = material_row.id;
  if operation_row.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = pg_catalog.clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations as operation
  set state = 'succeeded', stage = 'completed', progress = 100,
      result_material_id = material_row.id, bytes_completed = p_size_bytes,
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  update private.team_transfer_grants set revoked_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation and revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (operation_row.team_id, material_row.id, 'upserted');
  perform private.record_team_audit(
    operation_row.team_id, p_actor, 'material.content_edited',
    pg_catalog.jsonb_build_object('material_id', material_row.id, 'operation_id', p_operation),
    'succeeded', null
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation, 'state', 'succeeded',
    'materialId', material_row.id, 'reused', false
  );
end;
$$;

revoke all on function public.service_commit_team_text_edit(
  uuid, uuid, text, text, text, text, text, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.service_commit_team_text_edit(
  uuid, uuid, text, text, text, text, text, bigint
) to service_role;

create or replace function public.service_commit_team_material_mutation(
  p_operation uuid,
  p_actor uuid,
  p_drive jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operation_row public.team_operations%rowtype;
  intent_row private.team_operation_intents%rowtype;
  material_row public.team_materials%rowtype;
  destination public.team_materials%rowtype;
  actual_drive_file_id text;
  actual_name text;
  actual_parent text;
  actual_version text;
  actual_checksum text;
  actual_size bigint;
  actual_trashed boolean;
  required_permission text;
begin
  if pg_catalog.jsonb_typeof(p_drive) <> 'object'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_drive) as key(name)
       where key.name not in (
         'driveFileId','name','parentFolderId','driveVersion','checksum','sizeBytes','trashed'
       )
     ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select operation.* into operation_row
  from public.team_operations as operation
  where operation.id = p_operation and operation.actor_id = p_actor
  for update;
  if operation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if operation_row.state = 'succeeded' then
    return pg_catalog.jsonb_build_object(
      'operationId', p_operation, 'state', 'succeeded',
      'materialId', operation_row.result_material_id, 'reused', true
    );
  end if;
  if operation_row.kind not in ('rename','move','trash','restore')
     or operation_row.state not in ('pending','running') then
    raise exception 'WRONG_STATE' using errcode = '23514';
  end if;
  required_permission := case when operation_row.kind in ('trash','restore') then 'delete' else 'edit' end;
  if not private.can(operation_row.team_id, required_permission, p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select material.* into material_row
  from public.team_materials as material
  where material.id = operation_row.source_material_id
    and material.team_id = operation_row.team_id
  for update;
  if material_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select intent.* into intent_row from private.team_operation_intents as intent
  where intent.operation_id = p_operation;
  if operation_row.destination_folder_id is not null then
    select folder.* into destination from public.team_materials as folder
    where folder.id = operation_row.destination_folder_id
      and folder.team_id = operation_row.team_id
      and folder.kind = 'folder' and folder.lifecycle = 'active';
  end if;
  actual_drive_file_id := p_drive ->> 'driveFileId';
  actual_name := p_drive ->> 'name';
  actual_parent := p_drive ->> 'parentFolderId';
  actual_version := p_drive ->> 'driveVersion';
  actual_checksum := p_drive ->> 'checksum';
  actual_size := nullif(p_drive ->> 'sizeBytes', '')::bigint;
  actual_trashed := coalesce((p_drive ->> 'trashed')::boolean, false);
  if actual_drive_file_id is distinct from material_row.drive_file_id
     or operation_row.kind = 'rename' and actual_name is distinct from intent_row.expected_name
     or operation_row.kind = 'move' and (
       destination.id is null or actual_parent is distinct from destination.drive_file_id
     )
     or operation_row.kind = 'trash' and not actual_trashed
     or operation_row.kind = 'restore' and actual_trashed then
    raise exception 'INVALID_RESPONSE' using errcode = '22023';
  end if;
  update public.team_materials as material
  set name = case when operation_row.kind = 'rename' then actual_name else material.name end,
      parent_folder_id = case when operation_row.kind in ('move','restore') then actual_parent else material.parent_folder_id end,
      lifecycle = case
        when operation_row.kind = 'trash' then 'trashed'
        when operation_row.kind = 'restore' then 'active'
        else material.lifecycle
      end,
      trashed_at = case
        when operation_row.kind = 'trash' then pg_catalog.clock_timestamp()
        when operation_row.kind = 'restore' then null
        else material.trashed_at
      end,
      missing_at = case when operation_row.kind = 'restore' then null else material.missing_at end,
      drive_version = actual_version,
      checksum = actual_checksum,
      size_bytes = coalesce(actual_size, material.size_bytes),
      transcript_text = case
        when material.category = 'transcript'
          and actual_checksum is distinct from material.checksum then null
        else material.transcript_text
      end,
      transcript_ingest_state = case
        when material.category = 'transcript'
          and actual_checksum is distinct from material.checksum then 'pending'
        else material.transcript_ingest_state
      end,
      transcript_truncated = case
        when material.category = 'transcript'
          and actual_checksum is distinct from material.checksum then false
        else material.transcript_truncated
      end,
      transcript_indexed_bytes = case
        when material.category = 'transcript'
          and actual_checksum is distinct from material.checksum then 0
        else material.transcript_indexed_bytes
      end,
      transcript_source_version = case
        when material.transcript_ingest_state in ('full','truncated')
          and actual_checksum is not distinct from material.checksum then actual_version
        else null
      end,
      transcript_source_checksum = case
        when material.transcript_ingest_state in ('full','truncated')
          and actual_checksum is not distinct from material.checksum then actual_checksum
        else null
      end,
      modified_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where material.id = material_row.id;
  if operation_row.state = 'pending' then
    update public.team_operations set state = 'running', stage = 'finalizing', updated_at = pg_catalog.clock_timestamp()
    where id = p_operation;
  end if;
  update public.team_operations as operation
  set state = 'succeeded', stage = 'completed', progress = 100,
      result_material_id = material_row.id,
      reservation_released_at = coalesce(operation.reservation_released_at, pg_catalog.clock_timestamp()),
      finished_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
  where operation.id = p_operation;
  update private.team_transfer_grants set revoked_at = pg_catalog.clock_timestamp()
  where operation_id = p_operation and revoked_at is null;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (
    operation_row.team_id,
    material_row.id,
    case when operation_row.kind = 'trash' then 'tombstoned'
         when operation_row.kind = 'restore' then 'restored'
         else 'upserted' end
  );
  perform private.record_team_audit(
    operation_row.team_id, p_actor, 'material.' || operation_row.kind,
    pg_catalog.jsonb_build_object('material_id', material_row.id, 'operation_id', p_operation),
    'succeeded', null
  );
  return pg_catalog.jsonb_build_object(
    'operationId', p_operation, 'state', 'succeeded',
    'materialId', material_row.id, 'reused', false
  );
end;
$$;

revoke all on function public.service_commit_team_material_mutation(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_commit_team_material_mutation(uuid, uuid, jsonb)
to service_role;
