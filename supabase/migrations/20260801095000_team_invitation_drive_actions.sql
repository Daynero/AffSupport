-- US1 caller-checked team/invitation actions and service-only Google Drive
-- connection lifecycle. All client-visible data is returned through closed-shape
-- functions; credential and OAuth state remain service-only.

create or replace function private.team_confirmed_email(p_user uuid)
returns extensions.citext
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(users.email))::extensions.citext
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.id = p_user
    and users.email_confirmed_at is not null
    and users.email is not null
    and profile.account_status = 'active';
$$;

revoke all on function private.team_confirmed_email(uuid)
from public, anon, authenticated, service_role;

create or replace function private.team_expire_invitations(p_team uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.team_invitations as invitation
  set state = 'expired',
      responded_at = clock_timestamp()
  where invitation.state = 'pending'
    and invitation.expires_at <= clock_timestamp()
    and (p_team is null or invitation.team_id = p_team);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function private.team_expire_invitations(uuid)
from public, anon, authenticated, service_role;

create or replace function public.create_team(p_name text)
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
  created_id uuid;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if normalized_name is null or char_length(normalized_name) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  if exists (
    select 1
    from public.team_members as member
    join public.teams as team on team.id = member.team_id
    where member.user_id = actor
      and member.status = 'active'
      and team.status = 'active'
      and lower(btrim(team.name)) = lower(normalized_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.teams (name, owner_id)
  values (normalized_name, actor)
  returning teams.id into created_id;

  insert into public.team_members (team_id, user_id, base_role)
  values (created_id, actor, 'admin');

  perform private.record_team_audit(
    created_id, actor, 'team.created', '{}'::jsonb, 'succeeded', null
  );

  return query
  select created_id,
         normalized_name,
         'owner'::text,
         private.effective_permissions(created_id, actor),
         'none'::text;
end;
$$;

revoke all on function public.create_team(text)
from public, anon, authenticated, service_role;
grant execute on function public.create_team(text) to authenticated;

create or replace function public.list_my_teams()
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select team.id,
         team.name,
         case when team.owner_id = auth.uid() then 'owner' else member.base_role end,
         private.effective_permissions(team.id, auth.uid()),
         coalesce(connection.state, 'none')
  from public.team_members as member
  join public.teams as team
    on team.id = member.team_id
   and team.status = 'active'
  left join lateral (
    select drive.state
    from public.team_drive_connections as drive
    where drive.team_id = team.id
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) as connection on true
  where auth.uid() is not null
    and private.team_profile_active(auth.uid())
    and member.user_id = auth.uid()
    and member.status = 'active'
  order by team.created_at, team.id;
$$;

revoke all on function public.list_my_teams()
from public, anon, authenticated, service_role;
grant execute on function public.list_my_teams() to authenticated;

create or replace function public.lookup_invitable_account(p_team uuid, p_email text)
returns table (
  user_id uuid,
  confirmed_email text,
  display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select users.id,
         lower(btrim(users.email)),
         profile.display_name
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where private.can(p_team, 'manage_members', auth.uid())
    and users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = lower(btrim(p_email))
  limit 1;
$$;

revoke all on function public.lookup_invitable_account(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.lookup_invitable_account(uuid, text) to authenticated;

create or replace function public.create_invitation(
  p_team uuid,
  p_email text,
  p_initial_role text,
  p_token_hash bytea
)
returns table (
  id uuid,
  team_name text,
  inviter_name text,
  target_email text,
  target_user_id uuid,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  canonical_email extensions.citext := lower(btrim(p_email))::extensions.citext;
  target_id uuid;
  invitation_id uuid;
  expiry timestamptz := clock_timestamp() + interval '14 days';
  resolved_team_name text;
  resolved_inviter_name text;
begin
  if not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if canonical_email is null
     or canonical_email::text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(canonical_email::text) > 320
     or p_initial_role not in ('admin', 'editor', 'viewer')
     or octet_length(p_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1 from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.team_expire_invitations(p_team);

  select users.id into target_id
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = canonical_email::text
  limit 1;

  if target_id is not null and exists (
    select 1 from public.team_members as member
    where member.team_id = p_team
      and member.user_id = target_id
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.team_invitations as invitation
    where invitation.team_id = p_team
      and invitation.target_email = canonical_email
      and invitation.state = 'pending'
  ) then
    raise exception 'ALREADY_INVITED' using errcode = '23505';
  end if;
  if (
    select count(*) from public.team_members as member
    where member.team_id = p_team and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;

  insert into public.team_invitations (
    team_id, target_email, target_user_id, initial_role, inviter_id,
    accept_token_hash, expires_at
  ) values (
    p_team, canonical_email, target_id, p_initial_role, actor,
    p_token_hash, expiry
  ) returning team_invitations.id into invitation_id;

  select team.name into resolved_team_name
  from public.teams as team where team.id = p_team;
  select coalesce(profile.display_name, 'Wishly member') into resolved_inviter_name
  from public.profiles as profile where profile.id = actor;

  perform private.record_team_audit(
    p_team,
    actor,
    'invitation.created',
    jsonb_build_object('invitation_id', invitation_id, 'role', p_initial_role),
    'succeeded',
    null
  );

  return query
  select invitation_id,
         resolved_team_name,
         resolved_inviter_name,
         canonical_email::text,
         target_id,
         p_initial_role,
         'pending'::text,
         'pending'::text,
         null::text,
         expiry;
end;
$$;

revoke all on function public.create_invitation(uuid, text, text, bytea)
from public, anon, authenticated, service_role;
grant execute on function public.create_invitation(uuid, text, text, bytea) to authenticated;

create or replace function public.list_my_invitations()
returns table (
  id uuid,
  team_id uuid,
  team_name text,
  inviter_name text,
  target_email text,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_email extensions.citext;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  actor_email := private.team_confirmed_email(actor);
  perform private.team_expire_invitations(null);

  return query
  select invitation.id,
         invitation.team_id,
         team.name,
         coalesce(inviter.display_name, 'Wishly member'),
         invitation.target_email::text,
         invitation.initial_role,
         invitation.state,
         invitation.delivery_state,
         invitation.delivery_error_code,
         invitation.expires_at,
         invitation.created_at
  from public.team_invitations as invitation
  join public.teams as team on team.id = invitation.team_id and team.status = 'active'
  left join public.profiles as inviter on inviter.id = invitation.inviter_id
  where invitation.state in ('pending', 'expired')
    and (
      invitation.target_user_id = actor
      or (actor_email is not null and invitation.target_email = actor_email)
    )
  order by invitation.created_at desc, invitation.id;
end;
$$;

revoke all on function public.list_my_invitations()
from public, anon, authenticated, service_role;
grant execute on function public.list_my_invitations() to authenticated;

create or replace function public.list_team_invitations(p_team uuid)
returns table (
  id uuid,
  target_email text,
  target_user_id uuid,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz,
  created_at timestamptz,
  last_sent_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'manage_members', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform private.team_expire_invitations(p_team);
  return query
  select invitation.id,
         invitation.target_email::text,
         invitation.target_user_id,
         invitation.initial_role,
         invitation.state,
         invitation.delivery_state,
         invitation.delivery_error_code,
         invitation.expires_at,
         invitation.created_at,
         invitation.last_sent_at
  from public.team_invitations as invitation
  where invitation.team_id = p_team
  order by invitation.created_at desc, invitation.id
  limit 200;
end;
$$;

revoke all on function public.list_team_invitations(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_invitations(uuid) to authenticated;

create or replace function private.team_invitation_identity_matches(
  p_invitation public.team_invitations,
  p_actor uuid,
  p_plain_token text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.team_profile_active(p_actor)
    and (
      p_invitation.target_user_id = p_actor
      or p_invitation.target_email = private.team_confirmed_email(p_actor)
    )
    and (
      p_plain_token is null
      or p_invitation.accept_token_hash = extensions.digest(
        convert_to(p_plain_token, 'UTF8'), 'sha256'
      )
    );
$$;

revoke all on function private.team_invitation_identity_matches(
  public.team_invitations, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.accept_invitation(
  p_invitation uuid,
  p_plain_token text default null
)
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_row public.team_invitations%rowtype;
  resolved_name text;
  connection_state text;
begin
  select invitation.* into invitation_row
  from public.team_invitations as invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_invitation_identity_matches(invitation_row, actor, p_plain_token) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' or invitation_row.expires_at <= clock_timestamp() then
    if invitation_row.state = 'pending' then
      update public.team_invitations set state = 'expired', responded_at = clock_timestamp()
      where team_invitations.id = invitation_row.id;
    end if;
    raise exception 'EXPIRED' using errcode = '22023';
  end if;

  perform 1 from public.teams as team
  where team.id = invitation_row.team_id and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.team_members as member
    where member.team_id = invitation_row.team_id
      and member.user_id = actor
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  if (
    select count(*) from public.team_members as member
    where member.team_id = invitation_row.team_id and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (invitation_row.team_id, actor, invitation_row.initial_role);
  update public.team_invitations
  set state = 'accepted', responded_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  perform private.record_team_audit(
    invitation_row.team_id,
    actor,
    'invitation.accepted',
    jsonb_build_object('invitation_id', invitation_row.id, 'role', invitation_row.initial_role),
    'succeeded',
    null
  );

  select team.name into resolved_name
  from public.teams as team where team.id = invitation_row.team_id;
  select coalesce(connection.state, 'none') into connection_state
  from (select 1) as singleton
  left join lateral (
    select drive.state
    from public.team_drive_connections as drive
    where drive.team_id = invitation_row.team_id and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) as connection on true;
  return query
  select invitation_row.team_id,
         resolved_name,
         invitation_row.initial_role,
         private.effective_permissions(invitation_row.team_id, actor),
         connection_state;
end;
$$;

revoke all on function public.accept_invitation(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.accept_invitation(uuid, text) to authenticated;

create or replace function public.decline_invitation(
  p_invitation uuid,
  p_plain_token text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_row public.team_invitations%rowtype;
begin
  select invitation.* into invitation_row
  from public.team_invitations as invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_invitation_identity_matches(invitation_row, actor, p_plain_token) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' or invitation_row.expires_at <= clock_timestamp() then
    raise exception 'EXPIRED' using errcode = '22023';
  end if;
  update public.team_invitations
  set state = 'declined', responded_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  perform private.record_team_audit(
    invitation_row.team_id,
    actor,
    'invitation.declined',
    jsonb_build_object('invitation_id', invitation_row.id),
    'succeeded',
    null
  );
  return true;
end;
$$;

revoke all on function public.decline_invitation(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.decline_invitation(uuid, text) to authenticated;

create or replace function public.revoke_invitation(p_invitation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_team uuid;
begin
  select invitation.team_id into invitation_team
  from public.team_invitations as invitation
  where invitation.id = p_invitation
  for update;
  if invitation_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can(invitation_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_invitations
  set state = 'revoked',
      responded_at = clock_timestamp(),
      accept_token_hash = extensions.digest(gen_random_uuid()::text, 'sha256')
  where team_invitations.id = p_invitation
    and state = 'pending';
  if not found then raise exception 'WRONG_STATE' using errcode = '22023'; end if;
  perform private.record_team_audit(
    invitation_team, actor, 'invitation.revoked',
    jsonb_build_object('invitation_id', p_invitation), 'succeeded', null
  );
  return true;
end;
$$;

revoke all on function public.revoke_invitation(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.revoke_invitation(uuid) to authenticated;

create or replace function public.resend_invitation(
  p_invitation uuid,
  p_token_hash bytea
)
returns table (
  id uuid,
  team_name text,
  inviter_name text,
  target_email text,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_row public.team_invitations%rowtype;
  resolved_team_name text;
  resolved_inviter_name text;
  expiry timestamptz := clock_timestamp() + interval '14 days';
begin
  if octet_length(p_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select invitation.* into invitation_row
  from public.team_invitations as invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can(invitation_row.team_id, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' then
    raise exception 'WRONG_STATE' using errcode = '22023';
  end if;

  update public.team_invitations
  set accept_token_hash = p_token_hash,
      expires_at = expiry,
      delivery_state = 'pending',
      delivery_error_code = null,
      last_sent_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  select team.name into resolved_team_name
  from public.teams as team where team.id = invitation_row.team_id;
  select coalesce(profile.display_name, 'Wishly member') into resolved_inviter_name
  from public.profiles as profile where profile.id = actor;
  perform private.record_team_audit(
    invitation_row.team_id, actor, 'invitation.resent',
    jsonb_build_object('invitation_id', invitation_row.id), 'succeeded', null
  );
  return query
  select invitation_row.id,
         resolved_team_name,
         resolved_inviter_name,
         invitation_row.target_email::text,
         invitation_row.initial_role,
         'pending'::text,
         'pending'::text,
         null::text,
         expiry;
end;
$$;

revoke all on function public.resend_invitation(uuid, bytea)
from public, anon, authenticated, service_role;
grant execute on function public.resend_invitation(uuid, bytea) to authenticated;

create or replace function public.set_invitation_delivery_state(
  p_invitation uuid,
  p_delivery_state text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_delivery_state not in ('sent', 'failed')
     or (p_delivery_state = 'sent' and p_error_code is not null)
     or (p_error_code is not null and p_error_code <> 'DELIVERY_UNAVAILABLE') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_invitations
  set delivery_state = p_delivery_state,
      delivery_error_code = p_error_code,
      last_sent_at = clock_timestamp()
  where id = p_invitation and state = 'pending';
  return found;
end;
$$;

revoke all on function public.set_invitation_delivery_state(uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.set_invitation_delivery_state(uuid, text, text) to service_role;

create or replace function public.expire_team_invitations()
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.team_expire_invitations(null);
$$;

revoke all on function public.expire_team_invitations()
from public, anon, authenticated, service_role;
grant execute on function public.expire_team_invitations() to service_role;

-- Short-lived reference from an owner/team OAuth flow to a private credential.
-- It lets the server-side folder browser operate before a root connection exists.
alter table private.drive_oauth_transactions
add column credential_id uuid references private.google_drive_credentials(id) on delete set null;

create table private.drive_credential_references (
  team_id uuid primary key references public.teams(id) on delete cascade,
  actor_id uuid not null,
  credential_id uuid not null references private.google_drive_credentials(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint drive_credential_references_expiry_check check (expires_at > created_at)
);

create index drive_credential_references_credential_idx
on private.drive_credential_references (credential_id, expires_at);

alter table private.drive_credential_references enable row level security;
alter table private.drive_credential_references force row level security;
revoke all on table private.drive_credential_references
from public, anon, authenticated, service_role;

-- OAuth state and credential wrappers exposed only to Edge service_role.
create or replace function public.service_create_drive_oauth_transaction(
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
  created boolean;
  reusable_credential uuid;
begin
  if private.team_role(p_team, p_actor) <> 'owner'
     or p_expires_at > clock_timestamp() + interval '10 minutes'
     or p_request_origin is null
     or char_length(p_request_origin) > 2048 then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  created := private.create_drive_oauth_transaction(
    p_team, p_actor, p_state_hash, p_pkce_verifier, p_request_origin, p_expires_at
  );
  select coalesce(connection.credential_id, reference.credential_id)
    into reusable_credential
  from (select 1) as singleton
  left join lateral (
    select drive.credential_id
    from public.team_drive_connections as drive
    where drive.team_id = p_team and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) as connection on true
  left join lateral (
    select credential_reference.credential_id
    from private.drive_credential_references as credential_reference
    where credential_reference.team_id = p_team
      and credential_reference.actor_id = p_actor
      and credential_reference.expires_at > clock_timestamp()
  ) as reference on true;
  update private.drive_oauth_transactions
  set credential_id = reusable_credential
  where state_hash = p_state_hash;
  return created;
end;
$$;

revoke all on function public.service_create_drive_oauth_transaction(
  uuid, uuid, bytea, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.service_create_drive_oauth_transaction(
  uuid, uuid, bytea, text, text, timestamptz
) to service_role;

create or replace function public.service_peek_drive_oauth_transaction(p_state_hash bytea)
returns table (team_id uuid, actor_id uuid, request_origin text, credential_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select oauth.team_id, oauth.actor_id, oauth.request_origin, oauth.credential_id
  from private.drive_oauth_transactions as oauth
  where oauth.state_hash = p_state_hash
    and oauth.consumed_at is null
    and oauth.expires_at > clock_timestamp();
$$;

revoke all on function public.service_peek_drive_oauth_transaction(bytea)
from public, anon, authenticated, service_role;
grant execute on function public.service_peek_drive_oauth_transaction(bytea) to service_role;

create or replace function public.service_consume_drive_oauth_transaction(p_state_hash bytea)
returns table (
  team_id uuid,
  actor_id uuid,
  pkce_verifier text,
  request_origin text,
  credential_id uuid
)
language sql
security definer
set search_path = ''
as $$
  select consumed.team_id,
         consumed.actor_id,
         consumed.pkce_verifier,
         consumed.request_origin,
         oauth.credential_id
  from private.consume_drive_oauth_transaction(p_state_hash) as consumed
  join private.drive_oauth_transactions as oauth on oauth.state_hash = p_state_hash
  where private.team_role(consumed.team_id, consumed.actor_id) = 'owner';
$$;

revoke all on function public.service_consume_drive_oauth_transaction(bytea)
from public, anon, authenticated, service_role;
grant execute on function public.service_consume_drive_oauth_transaction(bytea) to service_role;

create or replace function private.upsert_google_drive_credential(
  p_actor uuid,
  p_google_permission_id text,
  p_google_account_email text,
  p_scope text,
  p_refresh_token text default null,
  p_existing_credential uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  credential_row private.google_drive_credentials%rowtype;
  secret_id uuid;
begin
  if not private.team_profile_active(p_actor)
     or char_length(p_google_permission_id) not between 1 and 512
     or char_length(p_google_account_email) not between 3 and 320
     or position('https://www.googleapis.com/auth/drive' in p_scope) = 0
     or (p_refresh_token is not null and char_length(p_refresh_token) < 16) then
    raise exception 'INVALID_CREDENTIAL' using errcode = '22023';
  end if;

  if p_existing_credential is not null then
    select credential.* into credential_row
    from private.google_drive_credentials as credential
    where credential.id = p_existing_credential
      and credential.connected_by = p_actor
      and credential.google_permission_id = p_google_permission_id
    for update;
  else
    select credential.* into credential_row
    from private.google_drive_credentials as credential
    where credential.connected_by = p_actor
      and credential.google_permission_id = p_google_permission_id
    for update;
  end if;

  if credential_row.id is not null then
    if p_refresh_token is not null then
      perform vault.update_secret(credential_row.vault_secret_id, p_refresh_token);
    end if;
    update private.google_drive_credentials
    set google_account_email = p_google_account_email,
        scope = p_scope,
        updated_at = clock_timestamp()
    where id = credential_row.id;
    return credential_row.id;
  end if;
  if p_existing_credential is not null or p_refresh_token is null then
    raise exception 'NEEDS_REAUTH' using errcode = '22023';
  end if;

  select vault.create_secret(
    p_refresh_token,
    'wishly-drive-' || gen_random_uuid()::text,
    'Wishly Google Drive refresh token'
  ) into secret_id;
  insert into private.google_drive_credentials (
    connected_by, google_permission_id, google_account_email, vault_secret_id, scope
  ) values (
    p_actor, p_google_permission_id, p_google_account_email, secret_id, p_scope
  ) returning id into p_existing_credential;
  return p_existing_credential;
exception
  when others then
    if secret_id is not null and p_existing_credential is null then
      delete from vault.secrets where id = secret_id;
    end if;
    raise;
end;
$$;

revoke all on function private.upsert_google_drive_credential(
  uuid, text, text, text, text, uuid
) from public, anon, authenticated, service_role;

create or replace function public.service_store_google_drive_credential(
  p_actor uuid,
  p_google_permission_id text,
  p_google_account_email text,
  p_scope text,
  p_refresh_token text default null,
  p_existing_credential uuid default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.upsert_google_drive_credential(
    p_actor, p_google_permission_id, p_google_account_email, p_scope,
    p_refresh_token, p_existing_credential
  );
$$;

revoke all on function public.service_store_google_drive_credential(
  uuid, text, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.service_store_google_drive_credential(
  uuid, text, text, text, text, uuid
) to service_role;

create or replace function public.service_bind_drive_credential(
  p_team uuid,
  p_actor uuid,
  p_credential uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.team_role(p_team, p_actor) <> 'owner'
     or not exists (
       select 1
       from private.google_drive_credentials as credential
       where credential.id = p_credential and credential.connected_by = p_actor
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  insert into private.drive_credential_references (
    team_id, actor_id, credential_id, expires_at
  ) values (
    p_team, p_actor, p_credential, clock_timestamp() + interval '1 hour'
  )
  on conflict (team_id) do update
  set actor_id = excluded.actor_id,
      credential_id = excluded.credential_id,
      expires_at = excluded.expires_at,
      created_at = clock_timestamp();
  return true;
end;
$$;

revoke all on function public.service_bind_drive_credential(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_bind_drive_credential(uuid, uuid, uuid)
to service_role;

create or replace function public.service_get_drive_credential_reference(
  p_team uuid,
  p_actor uuid
)
returns table (credential_id uuid, google_account_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select credential.id, credential.google_account_email
  from (
    select connection.credential_id, 0 as priority
    from public.team_drive_connections as connection
    where connection.team_id = p_team and connection.state <> 'detached'
    union all
    select reference.credential_id, 1 as priority
    from private.drive_credential_references as reference
    where reference.team_id = p_team
      and reference.actor_id = p_actor
      and reference.expires_at > clock_timestamp()
  ) as available
  join private.google_drive_credentials as credential
    on credential.id = available.credential_id
   and credential.connected_by = p_actor
  where private.team_role(p_team, p_actor) = 'owner'
  order by available.priority
  limit 1;
$$;

revoke all on function public.service_get_drive_credential_reference(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_drive_credential_reference(uuid, uuid)
to service_role;

create or replace function public.service_delete_google_drive_credential(p_credential uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.delete_google_drive_credential(p_credential);
$$;

revoke all on function public.service_delete_google_drive_credential(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_delete_google_drive_credential(uuid) to service_role;

create or replace function public.service_get_drive_connection_credential(
  p_team uuid,
  p_actor uuid
)
returns table (
  connection_id uuid,
  credential_id uuid,
  google_account_email text,
  root_folder_id text,
  root_resource_key text,
  drive_id text,
  drive_kind text,
  state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select connection.id,
         connection.credential_id,
         credential.google_account_email,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id,
         connection.drive_kind,
         connection.state
  from public.team_drive_connections as connection
  join private.google_drive_credentials as credential on credential.id = connection.credential_id
  where connection.team_id = p_team
    and connection.state <> 'detached'
    and private.team_role(p_team, p_actor) = 'owner'
  limit 1;
$$;

revoke all on function public.service_get_drive_connection_credential(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_get_drive_connection_credential(uuid, uuid)
to service_role;

create or replace function public.service_confirm_drive_connection(
  p_team uuid,
  p_actor uuid,
  p_credential uuid,
  p_root_folder_id text,
  p_root_folder_name text,
  p_drive_id text,
  p_drive_kind text,
  p_capabilities jsonb
)
returns table (connection_id uuid, sync_job_id uuid, state text, initial_sync_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created_connection uuid;
  created_job uuid;
begin
  if private.team_role(p_team, p_actor) <> 'owner'
     or p_drive_kind not in ('my_drive', 'shared_drive')
     or (p_drive_kind = 'my_drive' and p_drive_id is not null)
     or (p_drive_kind = 'shared_drive' and p_drive_id is null)
     or char_length(p_root_folder_id) not between 1 and 1024
     or char_length(p_root_folder_name) not between 1 and 255
     or jsonb_typeof(coalesce(p_capabilities, '{}'::jsonb)) <> 'object'
     or not exists (
       select 1 from private.google_drive_credentials as credential
       where credential.id = p_credential and credential.connected_by = p_actor
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.team_drive_connections as connection
    where connection.team_id = p_team and connection.state <> 'detached'
  ) then
    raise exception 'WRONG_STATE' using errcode = '23505';
  end if;

  insert into public.team_drive_connections (
    team_id, credential_id, root_folder_id, root_resource_key, root_folder_name,
    drive_id, drive_kind, capability_snapshot, capabilities_checked_at,
    state, initial_sync_state, connected_at
  ) values (
    p_team,
    p_credential,
    p_root_folder_id,
    nullif(p_capabilities ->> 'resourceKey', ''),
    p_root_folder_name,
    p_drive_id,
    p_drive_kind,
    p_capabilities - 'resourceKey' - 'startPageToken',
    clock_timestamp(),
    'connected',
    'scanning',
    clock_timestamp()
  ) returning id into created_connection;

  created_job := private.enqueue_catalog_sync(
    created_connection,
    'initial_scan',
    jsonb_build_object(
      'rootFolderId', p_root_folder_id,
      'pageToken', null,
      'changePageToken', p_capabilities ->> 'startPageToken'
    ),
    jsonb_build_array(p_root_folder_id)
  );
  delete from private.drive_credential_references
  where team_id = p_team and actor_id = p_actor;
  perform private.record_team_audit(
    p_team, p_actor, 'drive.connected',
    jsonb_build_object('connection_id', created_connection, 'state', 'connected'),
    'succeeded', null
  );
  return query select created_connection, created_job, 'connected'::text, 'scanning'::text;
end;
$$;

revoke all on function public.service_confirm_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.service_confirm_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;

create or replace function public.service_replace_drive_connection(
  p_team uuid,
  p_actor uuid,
  p_credential uuid,
  p_root_folder_id text,
  p_root_folder_name text,
  p_drive_id text,
  p_drive_kind text,
  p_capabilities jsonb
)
returns table (connection_id uuid, sync_job_id uuid, state text, initial_sync_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_connection uuid;
begin
  if private.team_role(p_team, p_actor) <> 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select connection.id into old_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state <> 'detached'
  for update;
  if old_connection is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update public.team_drive_connections
  set state = 'detached', detached_at = clock_timestamp()
  where id = old_connection;
  return query
  select confirmed.connection_id,
         confirmed.sync_job_id,
         confirmed.state,
         confirmed.initial_sync_state
  from public.service_confirm_drive_connection(
    p_team, p_actor, p_credential, p_root_folder_id, p_root_folder_name,
    p_drive_id, p_drive_kind, p_capabilities
  ) as confirmed;
end;
$$;

revoke all on function public.service_replace_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.service_replace_drive_connection(
  uuid, uuid, uuid, text, text, text, text, jsonb
) to service_role;

create or replace function public.service_detach_drive_connection(
  p_team uuid,
  p_actor uuid,
  p_connection uuid
)
returns table (detached boolean, credential_id uuid, delete_credential boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_credential uuid;
  should_delete boolean;
begin
  if private.team_role(p_team, p_actor) <> 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  update public.team_drive_connections
  set state = 'detached', detached_at = clock_timestamp()
  where id = p_connection and team_id = p_team and state <> 'detached'
  returning team_drive_connections.credential_id into resolved_credential;
  if resolved_credential is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.revoke_team_transfer_grants(p_team, null);
  should_delete := not exists (
    select 1 from public.team_drive_connections as connection
    where connection.credential_id = resolved_credential and connection.state <> 'detached'
  );
  perform private.record_team_audit(
    p_team, p_actor, 'drive.detached',
    jsonb_build_object('connection_id', p_connection, 'state', 'detached'),
    'succeeded', null
  );
  return query select true, resolved_credential, should_delete;
end;
$$;

revoke all on function public.service_detach_drive_connection(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_detach_drive_connection(uuid, uuid, uuid)
to service_role;

create or replace function public.service_mark_drive_needs_reauth(p_credential uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.team_drive_connections
  set state = 'needs_reauth', last_error_code = 'NEEDS_REAUTH'
  where credential_id = p_credential and state <> 'detached';
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.service_mark_drive_needs_reauth(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_mark_drive_needs_reauth(uuid) to service_role;

create or replace function public.service_claim_catalog_sync_jobs(
  p_worker text,
  p_limit integer default 5,
  p_lease_seconds integer default 60
)
returns table (
  job_id uuid,
  connection_id uuid,
  phase text,
  cursor jsonb,
  folder_queue jsonb,
  attempts integer,
  team_id uuid,
  credential_id uuid,
  root_folder_id text,
  root_resource_key text,
  drive_id text,
  drive_kind text
)
language sql
security definer
set search_path = ''
as $$
  select job.id,
         job.connection_id,
         job.phase,
         job.cursor,
         job.folder_queue,
         job.attempts,
         connection.team_id,
         connection.credential_id,
         connection.root_folder_id,
         connection.root_resource_key,
         connection.drive_id,
         connection.drive_kind
  from private.claim_catalog_sync_jobs(p_worker, p_limit, p_lease_seconds) as job
  join public.team_drive_connections as connection on connection.id = job.connection_id
  where connection.state in ('connected', 'unavailable');
$$;

revoke all on function public.service_claim_catalog_sync_jobs(text, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function public.service_claim_catalog_sync_jobs(text, integer, integer)
to service_role;

create or replace function public.service_upsert_catalog_page(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle
  )
  select resolved_team,
         p_connection,
         item.drive_file_id,
         item.drive_id,
         item.resource_key,
         p_parent_folder_id,
         item.name,
         item.mime_type,
         item.file_extension,
         item.kind,
         item.shortcut_target_id,
         item.shortcut_target_resource_key,
         item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'),
         item.size_bytes,
         nullif(item.modified_at, '')::timestamptz,
         item.drive_version,
         item.checksum,
         'active'
  from jsonb_to_recordset(p_files) as item(
    drive_file_id text,
    drive_id text,
    resource_key text,
    name text,
    mime_type text,
    file_extension text,
    kind text,
    shortcut_target_id text,
    shortcut_target_resource_key text,
    category text,
    classification_version integer,
    classification_source text,
    size_bytes bigint,
    modified_at text,
    drive_version text,
    checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = excluded.category,
      classification_version = excluded.classification_version,
      classification_source = excluded.classification_source,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null;
  get diagnostics affected = row_count;
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'upserted');
  return affected;
end;
$$;

revoke all on function public.service_upsert_catalog_page(uuid, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.service_upsert_catalog_page(uuid, text, jsonb)
to service_role;

create or replace function public.service_checkpoint_initial_sync(
  p_job uuid,
  p_worker text,
  p_folder_queue jsonb,
  p_page_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_folder_queue) <> 'array' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_sync_jobs
  set folder_queue = p_folder_queue,
      cursor = cursor || jsonb_build_object('pageToken', p_page_token),
      state = 'pending',
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where id = p_job
    and phase = 'initial_scan'
    and lease_owner = p_worker
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

revoke all on function public.service_checkpoint_initial_sync(uuid, text, jsonb, text)
from public, anon, authenticated, service_role;
grant execute on function public.service_checkpoint_initial_sync(uuid, text, jsonb, text)
to service_role;

create or replace function public.service_begin_change_replay(
  p_job uuid,
  p_connection uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
begin
  update private.catalog_sync_jobs
  set phase = 'change_replay',
      state = 'pending',
      folder_queue = '[]'::jsonb,
      cursor = cursor || jsonb_build_object('pageToken', null),
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where id = p_job and connection_id = p_connection
  returning (
    select connection.team_id
    from public.team_drive_connections as connection
    where connection.id = p_connection
  ) into resolved_team;
  if resolved_team is null then return false; end if;
  update public.team_drive_connections
  set initial_sync_state = 'replaying'
  where id = p_connection and state <> 'detached';
  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (resolved_team, null, 'sync_state');
  return true;
end;
$$;

revoke all on function public.service_begin_change_replay(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.service_begin_change_replay(uuid, uuid) to service_role;

create or replace function public.get_drive_connection_status(p_team uuid)
returns table (
  connection_id uuid,
  state text,
  root_folder_name text,
  drive_kind text,
  initial_sync_state text,
  last_synced_at timestamptz,
  last_error_code text,
  connected_account_email text,
  capabilities_checked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role is null
     or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select connection.id,
         coalesce(connection.state, 'none'),
         connection.root_folder_name,
         connection.drive_kind,
         coalesce(connection.initial_sync_state, 'not_started'),
         connection.last_synced_at,
         connection.last_error_code,
         case when caller_role in ('owner', 'admin') then credential.google_account_email end,
         case when caller_role in ('owner', 'admin') then connection.capabilities_checked_at end
  from (select 1) as singleton
  left join lateral (
    select drive.*
    from public.team_drive_connections as drive
    where drive.team_id = p_team and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) as connection on true
  left join private.google_drive_credentials as credential
    on credential.id = connection.credential_id;
end;
$$;

revoke all on function public.get_drive_connection_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_drive_connection_status(uuid) to authenticated;

create or replace function public.list_team_materials(
  p_team uuid,
  p_parent_folder_id text default null
)
returns table (
  id uuid,
  team_id uuid,
  drive_file_id text,
  parent_folder_id text,
  name text,
  kind text,
  category text,
  mime_type text,
  file_extension text,
  size_bytes bigint,
  modified_at timestamptz,
  preview_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select material.id,
         material.team_id,
         material.drive_file_id,
         material.parent_folder_id,
         material.name,
         material.kind,
         material.category,
         material.mime_type,
         material.file_extension,
         material.size_bytes,
         material.modified_at,
         material.preview_state
  from public.team_materials as material
  where material.team_id = p_team
    and material.lifecycle = 'active'
    and material.parent_folder_id is not distinct from p_parent_folder_id
  order by material.kind desc, lower(material.name), material.id
  limit 500;
end;
$$;

revoke all on function public.list_team_materials(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_materials(uuid, text) to authenticated;

comment on function public.create_team(text) is
  'Atomically creates one active team and its sole owner membership for the authenticated caller.';
comment on function public.get_drive_connection_status(uuid) is
  'Caller-checked closed connection status; credential ids, Vault ids, and cursors are never returned.';
