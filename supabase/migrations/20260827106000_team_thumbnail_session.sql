-- 011 (T043): a team-bound thumbnail session, and the membership probe the
-- session mint uses.
--
-- The session is a transfer grant with purpose `thumbnail_session`: hashed at
-- rest, expiring, bounded in uses, checked for `view` on every read. It names
-- no material — the relay reads the material from the query and re-checks the
-- catalog per request — so a grid of two hundred rows costs one mint.
-- Forward-only. Reverse steps are in ROLLBACK.md.

alter table private.team_transfer_grants
  drop constraint team_transfer_grants_purpose_check;
alter table private.team_transfer_grants
  add constraint team_transfer_grants_purpose_check check (
    purpose in (
      'preview_range', 'download_range', 'process_input', 'process_output', 'finalize',
      'thumbnail_session'
    )
  );

create or replace function private.issue_team_transfer_grant(
  p_token_hash bytea,
  p_operation uuid,
  p_team uuid,
  p_actor uuid,
  p_purpose text,
  p_material uuid,
  p_destination uuid,
  p_tool text,
  p_max_range_bytes integer,
  p_expires_at timestamptz,
  p_max_uses integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_id uuid;
begin
  if octet_length(p_token_hash) <> 32
     or p_purpose not in (
       'preview_range', 'download_range', 'process_input', 'process_output', 'finalize',
       'thumbnail_session'
     )
     or (p_purpose = 'thumbnail_session') <> (p_material is null)
     or p_max_range_bytes not between 1 and 33554432
     or p_max_uses not between 1 and 10000
     or p_expires_at <= clock_timestamp() then
    raise exception 'INVALID_TRANSFER_GRANT' using errcode = '22023';
  end if;
  if p_operation is not null and not exists (
    select 1
    from public.team_operations as operation
    where operation.id = p_operation
      and operation.team_id = p_team
      and operation.actor_id = p_actor
  ) then
    raise exception 'INVALID_TRANSFER_OPERATION' using errcode = '22023';
  end if;
  insert into private.team_transfer_grants (
    token_hash, operation_id, team_id, actor_id, purpose, material_id,
    destination_folder_id, tool_id, max_range_bytes, expires_at, max_uses
  ) values (
    p_token_hash, p_operation, p_team, p_actor, p_purpose, p_material,
    p_destination, p_tool, p_max_range_bytes, p_expires_at, p_max_uses
  ) returning id into grant_id;
  return grant_id;
end;
$$;

create or replace function private.consume_team_transfer_grant(
  p_token_hash bytea,
  p_purpose text
)
returns table (
  grant_id uuid,
  operation_id uuid,
  team_id uuid,
  actor_id uuid,
  material_id uuid,
  destination_folder_id uuid,
  tool_id text,
  max_range_bytes integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_row private.team_transfer_grants%rowtype;
  permission text;
begin
  select transfer.* into grant_row
  from private.team_transfer_grants as transfer
  where transfer.token_hash = p_token_hash
  for update;

  if grant_row.id is null
     or grant_row.purpose <> p_purpose
     or grant_row.revoked_at is not null
     or grant_row.expires_at <= clock_timestamp()
     or grant_row.uses >= grant_row.max_uses then
    return;
  end if;

  permission := case grant_row.purpose
    when 'preview_range' then 'view'
    when 'download_range' then 'download'
    when 'process_input' then 'process'
    when 'process_output' then 'upload'
    when 'finalize' then 'upload'
    when 'thumbnail_session' then 'view'
  end;
  if not private.can(grant_row.team_id, permission, grant_row.actor_id) then
    return;
  end if;

  update private.team_transfer_grants
  set uses = uses + 1
  where id = grant_row.id;

  return query select grant_row.id,
                      grant_row.operation_id,
                      grant_row.team_id,
                      grant_row.actor_id,
                      grant_row.material_id,
                      grant_row.destination_folder_id,
                      grant_row.tool_id,
                      grant_row.max_range_bytes;
end;
$$;

-- The cheapest honest answer to "may this caller read this space?", for the
-- session mint. Raises rather than returning false so the code is on the wire.
create or replace function public.assert_team_member(p_team uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke all on function public.assert_team_member(uuid) from public, anon, authenticated, service_role;
grant execute on function public.assert_team_member(uuid) to authenticated;
