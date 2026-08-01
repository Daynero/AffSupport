-- Security-definer foundation. Every feature function pins an empty search
-- path, schema-qualifies database objects, and receives an explicit ACL.

grant usage on schema private to authenticated, service_role;

create or replace function private.team_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

revoke all on function private.team_set_updated_at() from public, anon, authenticated;

create trigger teams_set_updated_at
before update on public.teams
for each row execute function private.team_set_updated_at();
create trigger team_members_set_updated_at
before update on public.team_members
for each row execute function private.team_set_updated_at();
create trigger team_invitations_set_updated_at
before update on public.team_invitations
for each row execute function private.team_set_updated_at();
create trigger google_drive_credentials_set_updated_at
before update on private.google_drive_credentials
for each row execute function private.team_set_updated_at();
create trigger team_drive_connections_set_updated_at
before update on public.team_drive_connections
for each row execute function private.team_set_updated_at();
create trigger team_materials_set_updated_at
before update on public.team_materials
for each row execute function private.team_set_updated_at();
create trigger team_operations_set_updated_at
before update on public.team_operations
for each row execute function private.team_set_updated_at();
create trigger catalog_sync_jobs_set_updated_at
before update on private.catalog_sync_jobs
for each row execute function private.team_set_updated_at();

create or replace function private.team_validate_permission_overrides()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(new.permission_overrides) <> 'object'
     or exists (
       select 1
       from jsonb_each(new.permission_overrides) as entry(key, value)
       where jsonb_typeof(entry.value) <> 'boolean'
          or not exists (
            select 1
            from public.team_permissions as permission
            where permission.permission = entry.key
          )
     ) then
    raise exception 'INVALID_PERMISSION_OVERRIDES' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.team_validate_permission_overrides()
from public, anon, authenticated;

create trigger team_members_validate_permission_overrides
before insert or update of permission_overrides on public.team_members
for each row execute function private.team_validate_permission_overrides();

create or replace function private.team_profile_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = p_user
        and profile.account_status = 'active'
    );
$$;

revoke all on function private.team_profile_active(uuid) from public, anon, authenticated;

create or replace function private.team_role(p_team uuid, p_user uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.team_profile_active(p_user) then null
    when team.owner_id = p_user then 'owner'
    else member.base_role
  end
  from public.teams as team
  join public.team_members as member
    on member.team_id = team.id
   and member.user_id = p_user
   and member.status = 'active'
  where team.id = p_team
    and team.status = 'active';
$$;

revoke all on function private.team_role(uuid, uuid) from public, anon, authenticated;

create or replace function private.effective_permissions(
  p_team uuid,
  p_user uuid default auth.uid()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  resolved_role text;
  resolved jsonb;
  overrides jsonb;
begin
  resolved_role := private.team_role(p_team, p_user);
  if resolved_role is null then
    select coalesce(jsonb_object_agg(permission.permission, false), '{}'::jsonb)
      into resolved
    from public.team_permissions as permission;
    return resolved;
  end if;

  select coalesce(jsonb_object_agg(role_permission.permission, role_permission.allowed), '{}'::jsonb)
    into resolved
  from public.role_permissions as role_permission
  where role_permission.role = resolved_role;

  if resolved_role = 'owner' then
    return resolved;
  end if;

  select member.permission_overrides
    into overrides
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = p_user
    and member.status = 'active';

  return resolved || coalesce(overrides, '{}'::jsonb);
end;
$$;

revoke all on function private.effective_permissions(uuid, uuid)
from public, anon, authenticated;

create or replace function private.can(
  p_team uuid,
  p_flag text,
  p_user uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_user is null then false
    when auth.uid() is not null and p_user is distinct from auth.uid() then false
    when not exists (
      select 1
      from public.team_permissions as permission
      where permission.permission = p_flag
    ) then false
    else coalesce((private.effective_permissions(p_team, p_user) ->> p_flag)::boolean, false)
  end;
$$;

revoke all on function private.can(uuid, text, uuid) from public, anon;
grant execute on function private.can(uuid, text, uuid) to authenticated, service_role;

create or replace function private.team_assert_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_team uuid;
  canonical_owner uuid;
  active_owner_rows integer;
begin
  affected_team := coalesce(
    nullif(to_jsonb(new) ->> 'team_id', '')::uuid,
    nullif(to_jsonb(old) ->> 'team_id', '')::uuid,
    nullif(to_jsonb(new) ->> 'id', '')::uuid,
    nullif(to_jsonb(old) ->> 'id', '')::uuid
  );

  select team.owner_id
    into canonical_owner
  from public.teams as team
  where team.id = affected_team;

  if canonical_owner is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select count(*)::integer
    into active_owner_rows
  from public.team_members as member
  where member.team_id = affected_team
    and member.user_id = canonical_owner
    and member.status = 'active';

  if active_owner_rows <> 1 then
    raise exception 'TEAM_OWNER_INVARIANT' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.team_assert_owner_membership()
from public, anon, authenticated;

create constraint trigger teams_owner_membership_invariant
after insert or update of owner_id on public.teams
deferrable initially deferred
for each row execute function private.team_assert_owner_membership();

create constraint trigger team_members_owner_membership_invariant
after insert or update or delete on public.team_members
deferrable initially deferred
for each row execute function private.team_assert_owner_membership();

create or replace function private.team_validate_material_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    with recursive descendants(material_id) as (
      select link.derivative_material_id
      from public.team_material_links as link
      where link.team_id = new.team_id
        and link.source_material_id = new.derivative_material_id
      union
      select link.derivative_material_id
      from public.team_material_links as link
      join descendants on descendants.material_id = link.source_material_id
      where link.team_id = new.team_id
    )
    select 1
    from descendants
    where descendants.material_id = new.source_material_id
  ) then
    raise exception 'MATERIAL_LINK_CYCLE' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.team_validate_material_link()
from public, anon, authenticated;

create trigger team_material_links_reject_cycles
before insert or update on public.team_material_links
for each row execute function private.team_validate_material_link();

create or replace function private.team_validate_operation_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.state in ('succeeded', 'canceled', 'failed') and new is distinct from old then
    raise exception 'TERMINAL_OPERATION_IMMUTABLE' using errcode = '23514';
  end if;
  if old.state = 'pending' and new.state not in ('pending', 'running', 'canceled', 'failed') then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = '23514';
  end if;
  if old.state = 'running' and new.state not in ('running', 'succeeded', 'canceled', 'failed') then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.team_validate_operation_transition()
from public, anon, authenticated;

create trigger team_operations_validate_transition
before update on public.team_operations
for each row execute function private.team_validate_operation_transition();

create or replace function private.record_team_audit(
  p_team uuid,
  p_actor uuid,
  p_action text,
  p_target jsonb,
  p_result text,
  p_error_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id uuid;
  actor_label text;
begin
  if p_actor is null
     or p_action is null
     or char_length(p_action) not between 1 and 96
     or p_result not in ('succeeded', 'denied', 'failed', 'canceled')
     or jsonb_typeof(coalesce(p_target, '{}'::jsonb)) <> 'object'
     or exists (
       select 1
       from jsonb_object_keys(coalesce(p_target, '{}'::jsonb)) as target_key(key)
       where target_key.key not in (
         'member_id', 'invitation_id', 'connection_id', 'material_id',
         'operation_id', 'relation', 'role', 'state', 'warning_code'
       )
     ) then
    raise exception 'INVALID_AUDIT_EVENT' using errcode = '22023';
  end if;

  select left(profile.display_name, 120)
    into actor_label
  from public.profiles as profile
  where profile.id = p_actor;

  insert into public.team_audit_events (
    team_id,
    actor_id,
    actor_label_snapshot,
    action,
    target,
    result,
    error_code
  ) values (
    p_team,
    p_actor,
    actor_label,
    p_action,
    coalesce(p_target, '{}'::jsonb),
    p_result,
    p_error_code
  )
  returning id into audit_id;
  return audit_id;
end;
$$;

revoke all on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
from public, anon, authenticated;
grant execute on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
to service_role;

create or replace function private.store_google_drive_credential(
  p_connected_by uuid,
  p_google_permission_id text,
  p_google_account_email text,
  p_scope text,
  p_refresh_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  credential_id uuid;
  secret_id uuid;
begin
  if p_refresh_token is null or char_length(p_refresh_token) < 16 then
    raise exception 'INVALID_CREDENTIAL' using errcode = '22023';
  end if;
  select vault.create_secret(
    p_refresh_token,
    'wishly-drive-' || gen_random_uuid()::text,
    'Wishly Google Drive refresh token'
  ) into secret_id;

  insert into private.google_drive_credentials (
    connected_by,
    google_permission_id,
    google_account_email,
    vault_secret_id,
    scope
  ) values (
    p_connected_by,
    p_google_permission_id,
    p_google_account_email,
    secret_id,
    p_scope
  )
  on conflict (connected_by, google_permission_id) do update
  set google_account_email = excluded.google_account_email,
      scope = excluded.scope,
      updated_at = clock_timestamp()
  returning id into credential_id;
  return credential_id;
exception
  when others then
    if secret_id is not null then
      delete from vault.secrets where id = secret_id;
    end if;
    raise;
end;
$$;

revoke all on function private.store_google_drive_credential(uuid, text, text, text, text)
from public, anon, authenticated;
grant execute on function private.store_google_drive_credential(uuid, text, text, text, text)
to service_role;

create or replace function private.read_google_drive_credential(p_credential uuid)
returns table (
  credential_id uuid,
  connected_by uuid,
  google_permission_id text,
  google_account_email text,
  scope text,
  refresh_token text
)
language sql
security definer
set search_path = ''
as $$
  update private.google_drive_credentials
  set last_used_at = clock_timestamp()
  where id = p_credential;

  select credential.id,
         credential.connected_by,
         credential.google_permission_id,
         credential.google_account_email,
         credential.scope,
         secret.decrypted_secret
  from private.google_drive_credentials as credential
  join vault.decrypted_secrets as secret on secret.id = credential.vault_secret_id
  where credential.id = p_credential;
$$;

revoke all on function private.read_google_drive_credential(uuid)
from public, anon, authenticated;
grant execute on function private.read_google_drive_credential(uuid) to service_role;

create or replace function private.update_google_drive_refresh_token(
  p_credential uuid,
  p_refresh_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if p_refresh_token is null or char_length(p_refresh_token) < 16 then
    raise exception 'INVALID_CREDENTIAL' using errcode = '22023';
  end if;
  select credential.vault_secret_id into secret_id
  from private.google_drive_credentials as credential
  where credential.id = p_credential
  for update;
  if secret_id is null then return false; end if;
  perform vault.update_secret(secret_id, p_refresh_token);
  update private.google_drive_credentials
  set updated_at = clock_timestamp()
  where id = p_credential;
  return true;
end;
$$;

revoke all on function private.update_google_drive_refresh_token(uuid, text)
from public, anon, authenticated;
grant execute on function private.update_google_drive_refresh_token(uuid, text) to service_role;

create or replace function private.delete_google_drive_credential(p_credential uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_id uuid;
begin
  if exists (
    select 1
    from public.team_drive_connections as connection
    where connection.credential_id = p_credential
      and connection.state <> 'detached'
  ) then
    return false;
  end if;
  delete from private.google_drive_credentials
  where id = p_credential
  returning vault_secret_id into secret_id;
  if secret_id is null then return false; end if;
  delete from vault.secrets where id = secret_id;
  return true;
end;
$$;

revoke all on function private.delete_google_drive_credential(uuid)
from public, anon, authenticated;
grant execute on function private.delete_google_drive_credential(uuid) to service_role;

create or replace function private.create_drive_oauth_transaction(
  p_team uuid,
  p_actor uuid,
  p_state_hash bytea,
  p_pkce_verifier text,
  p_request_origin text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  verifier_secret_id uuid;
begin
  if octet_length(p_state_hash) <> 32
     or p_expires_at <= clock_timestamp()
     or char_length(p_pkce_verifier) < 43 then
    raise exception 'INVALID_OAUTH_TRANSACTION' using errcode = '22023';
  end if;
  select vault.create_secret(
    p_pkce_verifier,
    'wishly-pkce-' || gen_random_uuid()::text,
    'Wishly one-time Google OAuth PKCE verifier'
  ) into verifier_secret_id;
  insert into private.drive_oauth_transactions (
    state_hash,
    team_id,
    actor_id,
    pkce_verifier_secret_id,
    request_origin,
    expires_at
  ) values (
    p_state_hash,
    p_team,
    p_actor,
    verifier_secret_id,
    p_request_origin,
    p_expires_at
  );
  return true;
exception
  when others then
    if verifier_secret_id is not null then
      delete from vault.secrets where id = verifier_secret_id;
    end if;
    raise;
end;
$$;

revoke all on function private.create_drive_oauth_transaction(
  uuid, uuid, bytea, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function private.create_drive_oauth_transaction(
  uuid, uuid, bytea, text, text, timestamptz
) to service_role;

create or replace function private.consume_drive_oauth_transaction(p_state_hash bytea)
returns table (
  team_id uuid,
  actor_id uuid,
  pkce_verifier text,
  request_origin text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  transaction_row private.drive_oauth_transactions%rowtype;
begin
  select oauth.* into transaction_row
  from private.drive_oauth_transactions as oauth
  where oauth.state_hash = p_state_hash
  for update;
  if transaction_row.state_hash is null
     or transaction_row.consumed_at is not null
     or transaction_row.expires_at <= clock_timestamp() then
    return;
  end if;
  update private.drive_oauth_transactions
  set consumed_at = clock_timestamp()
  where state_hash = p_state_hash;
  return query
  select transaction_row.team_id,
         transaction_row.actor_id,
         secret.decrypted_secret,
         transaction_row.request_origin
  from vault.decrypted_secrets as secret
  where secret.id = transaction_row.pkce_verifier_secret_id;
  delete from vault.secrets where id = transaction_row.pkce_verifier_secret_id;
end;
$$;

revoke all on function private.consume_drive_oauth_transaction(bytea)
from public, anon, authenticated;
grant execute on function private.consume_drive_oauth_transaction(bytea) to service_role;

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
       'preview_range', 'download_range', 'process_input', 'process_output', 'finalize'
     )
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

revoke all on function private.issue_team_transfer_grant(
  bytea, uuid, uuid, uuid, text, uuid, uuid, text, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function private.issue_team_transfer_grant(
  bytea, uuid, uuid, uuid, text, uuid, uuid, text, integer, timestamptz, integer
) to service_role;

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

revoke all on function private.consume_team_transfer_grant(bytea, text)
from public, anon, authenticated;
grant execute on function private.consume_team_transfer_grant(bytea, text) to service_role;

create or replace function private.revoke_team_transfer_grants(
  p_team uuid,
  p_actor uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update private.team_transfer_grants
  set revoked_at = clock_timestamp()
  where team_id = p_team
    and revoked_at is null
    and (p_actor is null or actor_id = p_actor);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function private.revoke_team_transfer_grants(uuid, uuid)
from public, anon, authenticated;
grant execute on function private.revoke_team_transfer_grants(uuid, uuid) to service_role;

create or replace function private.enqueue_catalog_sync(
  p_connection uuid,
  p_phase text,
  p_cursor jsonb default '{}'::jsonb,
  p_folder_queue jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id uuid;
begin
  insert into private.catalog_sync_jobs (connection_id, phase, cursor, folder_queue)
  values (p_connection, p_phase, coalesce(p_cursor, '{}'::jsonb), coalesce(p_folder_queue, '[]'::jsonb))
  returning id into job_id;
  return job_id;
end;
$$;

revoke all on function private.enqueue_catalog_sync(uuid, text, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function private.enqueue_catalog_sync(uuid, text, jsonb, jsonb) to service_role;

create or replace function private.claim_catalog_sync_jobs(
  p_worker text,
  p_limit integer default 5,
  p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select job.id
    from private.catalog_sync_jobs as job
    where (
        job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= clock_timestamp())
      )
      and job.next_attempt_at <= clock_timestamp()
    order by job.next_attempt_at, job.created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 20)
  )
  update private.catalog_sync_jobs as job
  set state = 'leased',
      lease_owner = p_worker,
      lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      attempts = job.attempts + 1,
      updated_at = clock_timestamp()
  from candidates
  where job.id = candidates.id
  returning job.*;
$$;

revoke all on function private.claim_catalog_sync_jobs(text, integer, integer)
from public, anon, authenticated;
grant execute on function private.claim_catalog_sync_jobs(text, integer, integer) to service_role;

create or replace function private.checkpoint_catalog_sync_job(
  p_job uuid,
  p_worker text,
  p_cursor jsonb,
  p_folder_queue jsonb,
  p_state text,
  p_error_code text default null,
  p_next_attempt_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.catalog_sync_jobs
  set cursor = coalesce(p_cursor, '{}'::jsonb),
      folder_queue = coalesce(p_folder_queue, '[]'::jsonb),
      state = p_state,
      last_error_code = p_error_code,
      next_attempt_at = coalesce(p_next_attempt_at, clock_timestamp()),
      lease_owner = case when p_state = 'leased' then p_worker else null end,
      lease_expires_at = case when p_state = 'leased' then lease_expires_at else null end,
      completed_at = case when p_state = 'succeeded' then clock_timestamp() else null end
  where id = p_job
    and lease_owner = p_worker
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function private.checkpoint_catalog_sync_job(
  uuid, text, jsonb, jsonb, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function private.checkpoint_catalog_sync_job(
  uuid, text, jsonb, jsonb, text, text, timestamptz
) to service_role;

create or replace function private.commit_team_transcript(
  p_material uuid,
  p_expected_version text,
  p_expected_checksum text,
  p_state text,
  p_text text,
  p_indexed_bytes integer,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  material_team uuid;
begin
  if p_state not in ('full', 'truncated', 'invalid_encoding', 'unavailable')
     or p_indexed_bytes not between 0 and 1048576
     or (p_text is not null and octet_length(p_text) > 1048576) then
    raise exception 'INVALID_TRANSCRIPT_STATE' using errcode = '22023';
  end if;
  update public.team_materials
  set transcript_text = case when p_state in ('full', 'truncated') then p_text else null end,
      transcript_ingest_state = p_state,
      transcript_truncated = p_state = 'truncated',
      transcript_indexed_bytes = p_indexed_bytes,
      transcript_source_version = p_expected_version,
      transcript_source_checksum = p_expected_checksum,
      transcript_ingested_at = clock_timestamp(),
      transcript_error_code = p_error_code
  where id = p_material
    and lifecycle = 'active'
    and drive_version is not distinct from p_expected_version
    and checksum is not distinct from p_expected_checksum
  returning team_id into material_team;
  if material_team is null then return false; end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (material_team, p_material, 'upserted');
  return true;
end;
$$;

revoke all on function private.commit_team_transcript(
  uuid, text, text, text, text, integer, text
) from public, anon, authenticated;
grant execute on function private.commit_team_transcript(
  uuid, text, text, text, text, integer, text
) to service_role;

create or replace function private.tombstone_team_material(
  p_material uuid,
  p_lifecycle text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  material_team uuid;
begin
  if p_lifecycle not in ('trashed', 'missing') then
    raise exception 'INVALID_MATERIAL_LIFECYCLE' using errcode = '22023';
  end if;
  update public.team_materials
  set lifecycle = p_lifecycle,
      trashed_at = case when p_lifecycle = 'trashed' then clock_timestamp() else null end,
      missing_at = case when p_lifecycle = 'missing' then clock_timestamp() else null end,
      transcript_text = null,
      transcript_ingest_state = 'unavailable',
      transcript_truncated = false,
      transcript_indexed_bytes = 0,
      transcript_error_code = p_error_code
  where id = p_material
  returning team_id into material_team;
  if material_team is null then return false; end if;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (material_team, p_material, 'tombstoned');
  return true;
end;
$$;

revoke all on function private.tombstone_team_material(uuid, text, text)
from public, anon, authenticated;
grant execute on function private.tombstone_team_material(uuid, text, text) to service_role;

-- PostgREST exposes only the public schema. These narrow service-role wrappers
-- are the sole Edge-callable path into the private definer helpers; private
-- tables and functions remain absent from the Data API schema surface.
create or replace function public.read_google_drive_credential(p_credential uuid)
returns table (
  credential_id uuid,
  connected_by uuid,
  google_permission_id text,
  google_account_email text,
  scope text,
  refresh_token text
)
language sql
security definer
set search_path = ''
as $$
  select * from private.read_google_drive_credential(p_credential);
$$;

revoke all on function public.read_google_drive_credential(uuid)
from public, anon, authenticated;
grant execute on function public.read_google_drive_credential(uuid) to service_role;

create or replace function public.issue_team_transfer_grant(
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
language sql
security definer
set search_path = ''
as $$
  select private.issue_team_transfer_grant(
    p_token_hash, p_operation, p_team, p_actor, p_purpose, p_material,
    p_destination, p_tool, p_max_range_bytes, p_expires_at, p_max_uses
  );
$$;

revoke all on function public.issue_team_transfer_grant(
  bytea, uuid, uuid, uuid, text, uuid, uuid, text, integer, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.issue_team_transfer_grant(
  bytea, uuid, uuid, uuid, text, uuid, uuid, text, integer, timestamptz, integer
) to service_role;

create or replace function public.consume_team_transfer_grant(
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
language sql
security definer
set search_path = ''
as $$
  select * from private.consume_team_transfer_grant(p_token_hash, p_purpose);
$$;

revoke all on function public.consume_team_transfer_grant(bytea, text)
from public, anon, authenticated;
grant execute on function public.consume_team_transfer_grant(bytea, text) to service_role;

create or replace function public.record_team_audit(
  p_team uuid,
  p_actor uuid,
  p_action text,
  p_target jsonb,
  p_result text,
  p_error_code text default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.record_team_audit(
    p_team, p_actor, p_action, p_target, p_result, p_error_code
  );
$$;

revoke all on function public.record_team_audit(uuid, uuid, text, jsonb, text, text)
from public, anon, authenticated;
grant execute on function public.record_team_audit(uuid, uuid, text, jsonb, text, text)
to service_role;

create policy teams_select_member
on public.teams for select to authenticated
using (private.can(id, 'view', auth.uid()));

create policy team_members_select_team
on public.team_members for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_invitations_select_manager
on public.team_invitations for select to authenticated
using (private.can(team_id, 'manage_members', auth.uid()));

create policy team_drive_connections_select_team
on public.team_drive_connections for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_materials_select_team
on public.team_materials for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_material_links_select_team
on public.team_material_links for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_operations_select_team
on public.team_operations for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

create policy team_audit_events_select_manager
on public.team_audit_events for select to authenticated
using (private.can(team_id, 'manage_members', auth.uid()));

create policy team_catalog_events_select_team
on public.team_catalog_events for select to authenticated
using (private.can(team_id, 'view', auth.uid()));

grant select (
  id, team_id, kind, state, stage, progress, result_material_id,
  error_code, retryable, updated_at
) on table public.team_operations to authenticated;
grant select (id, team_id, material_id, event_kind, occurred_at)
on table public.team_catalog_events to authenticated;

alter publication supabase_realtime add table public.team_operations (
  id, team_id, kind, state, stage, progress, result_material_id,
  error_code, retryable, updated_at
);
alter publication supabase_realtime add table public.team_catalog_events (
  id, team_id, material_id, event_kind, occurred_at
);

comment on function private.can(uuid, text, uuid) is
  'Fail-closed effective Wishly team permission check; cached catalog data is never authority.';
