create function private.commercial_drive_allowed(p_team uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select coalesce(private.team_role(p_team,p_actor) = 'owner',false)
 and private.team_workspace_allowed(p_team)
 and (exists(select 1 from public.admin_users where user_id=p_actor)
 or exists(select 1 from public.space_tariffs where team_id=p_team and owner_id=p_actor
 and revoked_at is null and ends_on + 3 >= private.kyiv_today()));
$$;
revoke all on function private.commercial_drive_allowed(uuid,uuid) from public, anon, authenticated, service_role;

-- Commercial access hardening. Existing credentials are retained; no provider calls.

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
  if not private.commercial_drive_allowed(p_team,p_actor)
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
  perform private.assert_commercial_drive_credential(p_actor,p_credential);
  perform 1 from public.teams where id=p_team for update;
  if not private.commercial_drive_allowed(p_team,p_actor)
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
  perform private.assert_commercial_drive_credential(p_actor,p_credential);
  perform 1 from public.teams where id=p_team for update;
  if not private.commercial_drive_allowed(p_team,p_actor)
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
  old_root_folder_id text;
  old_drive_id text;
  old_drive_kind text;
  resync_job uuid;
begin
  perform private.assert_commercial_drive_credential(p_actor,p_credential);
  perform 1 from public.teams where id=p_team for update;
  -- Keep the same validation as a first-time connection before changing the
  -- currently active source. A replacement may only use the caller's own
  -- credential and a validated Drive root shape.
  if not private.commercial_drive_allowed(p_team,p_actor)
     or p_drive_kind is null
     or p_drive_kind not in ('my_drive', 'shared_drive')
     or (p_drive_kind = 'my_drive' and p_drive_id is not null)
     or (p_drive_kind = 'shared_drive' and p_drive_id is null)
     or coalesce(char_length(p_root_folder_id), 0) not between 1 and 1024
     or coalesce(char_length(p_root_folder_name), 0) not between 1 and 255
     or jsonb_typeof(coalesce(p_capabilities, '{}'::jsonb)) <> 'object'
     or not exists (
       select 1
       from private.google_drive_credentials as credential
       where credential.id = p_credential and credential.connected_by = p_actor
     ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select connection.id,
         connection.root_folder_id,
         connection.drive_id,
         connection.drive_kind
    into old_connection,
         old_root_folder_id,
         old_drive_id,
         old_drive_kind
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state <> 'detached'
  for update;

  if old_connection is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if old_root_folder_id = p_root_folder_id
     and old_drive_kind = p_drive_kind
     and old_drive_id is not distinct from p_drive_id then
    update public.team_drive_connections
    set credential_id = p_credential,
        root_resource_key = nullif(coalesce(p_capabilities, '{}'::jsonb) ->> 'resourceKey', ''),
        root_folder_name = p_root_folder_name,
        drive_id = p_drive_id,
        drive_kind = p_drive_kind,
        capability_snapshot = coalesce(p_capabilities, '{}'::jsonb) - 'resourceKey' - 'startPageToken',
        capabilities_checked_at = clock_timestamp(),
        state = 'connected',
        initial_sync_state = 'scanning',
        change_page_token = coalesce(
          nullif(coalesce(p_capabilities, '{}'::jsonb) ->> 'startPageToken', ''),
          change_page_token
        ),
        last_synced_at = null,
        last_error_code = null,
        detached_at = null
    where id = old_connection;

    resync_job := public.service_enqueue_catalog_reconciliation(old_connection);
    delete from private.drive_credential_references
    where team_id = p_team and actor_id = p_actor;
    perform private.record_team_audit(
      p_team,
      p_actor,
      'drive.resynced',
      jsonb_build_object('connection_id', old_connection, 'state', 'connected'),
      'succeeded',
      null
    );

    return query select old_connection, resync_job, 'connected'::text, 'scanning'::text;
    return;
  end if;

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
  if not exists(select 1 from public.teams where id=p_team and owner_id=p_actor and status='active')
     or not private.team_profile_active(p_actor) then
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

create or replace function private.teams_tariff_bound_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id
     and not (coalesce(current_setting('soty.commercial_owner_correction',true),'off')='on'
       and exists(select 1 from public.admin_users where user_id=auth.uid()))
     and exists (
    select 1 from public.space_tariffs as tariff
    where tariff.team_id = new.id
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function private.validate_commercial_tariff()
returns trigger language plpgsql security definer set search_path = '' as $$
declare capacity integer;
begin
  if new.team_id is not null then
    perform 1 from public.teams where id = new.team_id for update;
    if new.owner_id is not null and not exists (select 1 from public.teams where id = new.team_id and owner_id = new.owner_id) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
    select base_seats + new.extra_seats into capacity from public.tariff_plans where code = new.plan_code;
    if new.revoked_at is null and capacity < private.team_seats_used(new.team_id) then
      raise exception 'SEATS_IN_USE' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.validate_commercial_tariff() from public, anon, authenticated, service_role;



create table private.commercial_access_journal (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, team_id uuid,
 kind text not null, observed_at timestamptz not null default clock_timestamp(),
 needs_review boolean, principal_bound boolean, seats_used integer, seats_total integer
);
alter table private.commercial_access_journal enable row level security;
alter table private.commercial_access_journal force row level security;
revoke all on private.commercial_access_journal from public,anon,authenticated,service_role;
create function private.journal_commercial_google() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into private.commercial_access_journal(owner_id,kind,needs_review,principal_bound)
 values(new.actor_id,'google_approval',new.needs_review,new.permission_id is not null);
 return new;
end;
$$;
revoke all on function private.journal_commercial_google() from public,anon,authenticated,service_role;

-- This durable reservation survives disconnects and token deletion.
create table private.commercial_google_principals (
 actor_id uuid primary key, -- retained tombstone even after account deletion
 account_email text not null,
 permission_id text,
 needs_review boolean not null default false,
 created_at timestamptz not null default now()
);
alter table private.commercial_google_principals enable row level security;
alter table private.commercial_google_principals force row level security;
revoke all on private.commercial_google_principals from public, anon, authenticated, service_role;
create trigger journal_commercial_google after insert or update on private.commercial_google_principals
for each row execute function private.journal_commercial_google();
insert into private.commercial_google_principals(actor_id,account_email,permission_id,needs_review)
select c.connected_by, min(lower(btrim(c.google_account_email))),
 case when count(distinct c.google_permission_id)=1 and not bool_or(exists(
   select 1 from private.google_drive_credentials other
   where other.google_permission_id=c.google_permission_id and other.connected_by<>c.connected_by
 )) then min(c.google_permission_id) end,
 count(distinct c.google_permission_id)<>1 or bool_or(exists(
   select 1 from private.google_drive_credentials other
   where other.google_permission_id=c.google_permission_id and other.connected_by<>c.connected_by
 ))
from private.google_drive_credentials c group by c.connected_by;
create unique index commercial_google_principal_unique
 on private.commercial_google_principals(permission_id) where permission_id is not null;
-- Freeze the address approved at sale, including grants awaiting a first sign-in.
insert into private.commercial_google_principals(actor_id,account_email)
select distinct on (owner_id) owner_id,lower(btrim(owner_email))
from public.space_tariffs where owner_id is not null order by owner_id,created_at,id
on conflict(actor_id) do nothing;
insert into private.commercial_google_principals(actor_id,account_email)
select u.id,lower(btrim(u.email)) from auth.users u join public.admin_users a on a.user_id=u.id
on conflict(actor_id) do nothing;
create function private.reserve_tariff_google_account() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.owner_id is not null then
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,713));
  insert into private.commercial_google_principals(actor_id,account_email)
  values(new.owner_id,lower(btrim(new.owner_email))) on conflict(actor_id) do nothing;
 end if;
 return new;
end;
$$;
revoke all on function private.reserve_tariff_google_account() from public,anon,authenticated,service_role;
create trigger reserve_tariff_google_account after insert or update of owner_id
on public.space_tariffs for each row execute function private.reserve_tariff_google_account();

-- All credential activation paths share the approval lock, including late callbacks.
create function private.assert_commercial_drive_credential(p_actor uuid,p_credential uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,713));
 if not exists(select 1 from private.commercial_google_principals a
   join private.google_drive_credentials c on c.connected_by=a.actor_id and c.google_permission_id=a.permission_id
   where a.actor_id=p_actor and c.id=p_credential and not a.needs_review) then
  raise exception 'GOOGLE_ACCOUNT_NOT_APPROVED' using errcode='22023';
 end if;
end;
$$;
revoke all on function private.assert_commercial_drive_credential(uuid,uuid) from public,anon,authenticated,service_role;


create or replace function public.service_store_google_drive_credential(
 p_actor uuid, p_google_permission_id text, p_google_account_email text, p_scope text,
 p_refresh_token text default null, p_existing_credential uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare approved private.commercial_google_principals%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text, 713));
 if not exists (
   select 1 from public.teams t where t.owner_id = p_actor and private.team_workspace_allowed(t.id)
   and (exists (select 1 from public.admin_users a where a.user_id = p_actor)
     or exists (select 1 from public.space_tariffs st where st.team_id = t.id
       and st.owner_id = p_actor and st.revoked_at is null and st.ends_on + 3 >= private.kyiv_today()))
 ) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
 select * into approved from private.commercial_google_principals where actor_id = p_actor for update;
 if approved.actor_id is null or approved.needs_review then
   raise exception 'GOOGLE_ACCOUNT_NOT_APPROVED' using errcode='22023';
 elsif approved.permission_id is null and approved.account_email=lower(btrim(p_google_account_email)) then
   if exists(select 1 from private.commercial_google_principals where permission_id=p_google_permission_id)
     or exists(select 1 from private.google_drive_credentials where google_permission_id=p_google_permission_id and connected_by<>p_actor) then
    raise exception 'GOOGLE_ACCOUNT_NOT_APPROVED' using errcode='22023';
   end if;
   update private.commercial_google_principals set permission_id=p_google_permission_id where actor_id=p_actor;
 elsif approved.permission_id is distinct from p_google_permission_id then
   raise exception 'GOOGLE_ACCOUNT_NOT_APPROVED' using errcode = '22023';
 end if;
 return private.upsert_google_drive_credential(p_actor,p_google_permission_id,p_google_account_email,
   p_scope,p_refresh_token,p_existing_credential);
end;
$$;

create table private.commercial_tariff_mutations (
 actor_id uuid not null, operation_id uuid not null, tariff_id uuid not null,
 request jsonb not null, result jsonb not null, committed_at timestamptz not null default clock_timestamp(), primary key(actor_id,operation_id)
);
alter table private.commercial_tariff_mutations enable row level security;
revoke all on private.commercial_tariff_mutations from public,anon,authenticated,service_role;
create function public.admin_mutate_space_tariff(p_id uuid,p_operation uuid,p_expected timestamptz,p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := private.require_tariff_admin(); current_row public.space_tariffs%rowtype;
 prior private.commercial_tariff_mutations%rowtype; output jsonb;
begin
 if p_operation is null or p_expected is null then raise exception 'INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||p_operation::text,714));
 select * into prior from private.commercial_tariff_mutations where actor_id=actor and operation_id=p_operation;
 if prior.operation_id is not null then
  if prior.tariff_id <> p_id or prior.request <> jsonb_build_object('action',p_action,'input',p_input) then
   raise exception 'INVALID_INPUT';
  end if;
  return prior.result;
 end if;
 select * into current_row from public.space_tariffs where id=p_id for update;
 if current_row.id is null then raise exception 'NOT_FOUND'; end if;
 if current_row.updated_at <> p_expected then raise exception 'WRONG_STATE'; end if;
 perform set_config('soty.tariff_mutation','on',true);
 case p_action
 when 'extend' then output := public.admin_extend_space_tariff(p_id,(p_input->>'months')::integer,coalesce((p_input->>'notify')::boolean,false));
 when 'update' then
 if nullif(p_input->>'approvedGoogleEmail','') is not null then
  perform public.admin_approve_drive_account(current_row.owner_id,p_input->>'approvedGoogleEmail',true,p_input->>'googleApprovalRevision');
 end if;
 output := public.admin_update_space_tariff(p_id,p_input->>'plan',(p_input->>'endsOn')::date,(p_input->>'extraSeats')::integer,p_input->>'note',p_input->>'externalRef');
 if nullif(p_input->>'approvedGoogleEmail','') is not null then
  update public.space_tariff_events set before=null where id=(select id from public.space_tariff_events
    where tariff_id=p_id order by created_at desc,id desc limit 1);
 end if;
 when 'end' then output := public.admin_end_space_tariff(p_id,(p_input->>'now')::boolean);
 else raise exception 'INVALID_INPUT';
 end case;
 perform set_config('soty.tariff_mutation','off',true);
 insert into private.commercial_tariff_mutations(actor_id,operation_id,tariff_id,request,result) values(actor,p_operation,p_id,jsonb_build_object('action',p_action,'input',p_input),output);
 return output;
end;
$$;
revoke all on function public.admin_mutate_space_tariff(uuid,uuid,timestamptz,text,jsonb) from public,anon;
grant execute on function public.admin_mutate_space_tariff(uuid,uuid,timestamptz,text,jsonb) to authenticated;

-- Keep the pre-existing maximum sellable capacity (1000 base + 1000 extra).
alter table public.space_tariffs drop constraint space_tariffs_extra_check;
alter table public.space_tariffs add constraint space_tariffs_extra_check check(extra_seats between 0 and 1999);
create or replace function private.checked_tariff_terms(p_plan text, p_extra_seats integer)
returns public.tariff_plans
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  plan public.tariff_plans%rowtype;
begin
  select * into plan from public.tariff_plans where code = p_plan and active;
  if plan.code is null
     or p_extra_seats is null or p_extra_seats < 0 or p_extra_seats > 1999 or plan.base_seats + p_extra_seats > 2000
     or (p_plan='solo' and p_extra_seats<>0)
     or (p_extra_seats > 0 and not plan.extra_seats_allowed)
     or (plan.max_extra_seats is not null and p_extra_seats > plan.max_extra_seats) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return plan;
end;
$$;
-- Existing sold capacities remain unchanged when the advertised base changes.
do $$ begin
 if exists(select 1 from public.tariff_plans where code='lead' and base_seats=3) then
update public.tariff_plans set base_seats=2, name_uk='Команда', name_en='Team',
 summary_uk='Власник і один учень; місця можна додати',
 summary_en='Owner and one pupil; more seats on request' where code='lead' and base_seats=3;
update public.space_tariffs set extra_seats=extra_seats+1, updated_at=clock_timestamp() where plan_code='lead';
end if; end $$;
-- Solo is exactly one seat. Preserve previously sold multi-seat capacity as Team.
insert into private.commercial_access_journal(owner_id,team_id,kind,seats_used,seats_total)
select owner_id,team_id,'migration_solo_reclassified',
 case when team_id is not null then private.team_seats_used(team_id) else 0 end,1+extra_seats
from public.space_tariffs where plan_code='solo' and extra_seats>0 and owner_id is not null;
update public.space_tariffs set plan_code='lead',
 extra_seats=greatest(0,1+extra_seats-(select base_seats from public.tariff_plans where code='lead')),
 updated_at=clock_timestamp() where plan_code='solo' and extra_seats>0;
update public.tariff_plans set extra_seats_allowed=false,max_extra_seats=0 where code='solo';
create trigger validate_commercial_tariff before insert or update of plan_code, extra_seats, revoked_at, owner_id, team_id
on public.space_tariffs for each row execute function private.validate_commercial_tariff();
create function private.preserve_sold_tariff_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.base_seats > old.base_seats and exists(select 1 from public.space_tariffs where plan_code=new.code) then
 raise exception 'INVALID_INPUT';
 end if;
 if new.base_seats <> old.base_seats then
   update public.space_tariffs set extra_seats=greatest(0,extra_seats+old.base_seats-new.base_seats),
     updated_at=clock_timestamp() where plan_code=new.code;
 end if;
 return new;
end;
$$;
revoke all on function private.preserve_sold_tariff_capacity() from public,anon,authenticated,service_role;
create trigger preserve_sold_tariff_capacity after update of base_seats on public.tariff_plans
for each row execute function private.preserve_sold_tariff_capacity();

create function private.revoke_departed_inviter_links() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or not coalesce((private.effective_permissions(old.team_id,old.user_id)->>'manage_members')::boolean,false) then
  update public.team_invitations set state='revoked',responded_at=clock_timestamp()
  where team_id=old.team_id and inviter_id=old.user_id and state='pending';
 end if;
 return null;
end;
$$;
revoke all on function private.revoke_departed_inviter_links() from public,anon,authenticated,service_role;
create trigger revoke_departed_inviter_links after delete or update on public.team_members
for each row execute function private.revoke_departed_inviter_links();


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
  resolved_connection_state text;
begin
  select invitation.* into invitation_row
  from public.team_invitations invitation
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

  perform 1 from public.teams team
  where team.id = invitation_row.team_id and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_workspace_allowed(invitation_row.team_id) then
    raise exception 'SPACE_BLOCKED' using errcode = '42501';
  end if;
  if not coalesce((private.effective_permissions(invitation_row.team_id, invitation_row.inviter_id)->>'manage_members')::boolean,false) then
    raise exception 'EXPIRED' using errcode='22023';
  end if;
  if exists (
    select 1 from public.team_members member
    where member.team_id = invitation_row.team_id
      and member.user_id = actor
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  -- The accepted invitation already held its seat; only members are counted. Admins take none.
  if not exists (select 1 from public.admin_users as admin where admin.user_id = actor) then
    perform private.assert_team_seat_free(invitation_row.team_id, false);
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
  from public.teams team where team.id = invitation_row.team_id;
  select coalesce(connection.state, 'none') into resolved_connection_state
  from (select 1) singleton
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = invitation_row.team_id and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) connection on true;
  return query
  select invitation_row.team_id,
         resolved_name,
         invitation_row.initial_role,
         private.effective_permissions(invitation_row.team_id, actor),
         resolved_connection_state;
end;
$$;

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
  perform private.assert_team_seat_free(p_team, true);

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

create or replace function public.service_direct_add_registered_member(
  p_actor uuid,
  p_team uuid,
  p_email text,
  p_base_role text
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role text,
  base_role text,
  permission_overrides jsonb,
  effective_permissions jsonb,
  joined_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_email extensions.citext := lower(btrim(p_email))::extensions.citext;
  target_user uuid;
begin
  if p_actor is null
     or p_team is null
     or canonical_email is null
     or char_length(canonical_email::text) not between 3 and 320
     or position('@' in canonical_email::text) <= 1
     or p_base_role not in ('admin', 'editor', 'viewer') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1
  from public.teams as team
  where team.id = p_team
    and team.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if not private.can(p_team, 'manage_members', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select users.id
    into target_user
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = canonical_email::text
  limit 1;
  if target_user is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.team_members as member
    where member.team_id = p_team
      and member.user_id = target_user
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;

  -- The target's own pending invitations are revoked below, so their seat moves to the member.
  if not exists (select 1 from public.admin_users as admin where admin.user_id = target_user) then
    perform private.assert_team_seat_free(p_team, true, null, canonical_email::text);
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (p_team, target_user, p_base_role);

  update public.team_invitations as invitation
  set state = 'revoked',
      responded_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where invitation.team_id = p_team
    and invitation.state = 'pending'
    and (
      invitation.target_user_id = target_user
      or invitation.target_email = canonical_email
    );

  perform private.record_team_audit(
    p_team,
    p_actor,
    'membership.direct_added',
    jsonb_build_object('member_id', target_user, 'role', p_base_role),
    'succeeded',
    null
  );

  return query
  select member.id,
         member.user_id,
         profile.display_name,
         lower(btrim(users.email)),
         member.base_role,
         member.base_role,
         member.permission_overrides,
         private.effective_permissions(p_team, target_user),
         member.joined_at
  from public.team_members as member
  join public.profiles as profile on profile.id = member.user_id
  join auth.users as users on users.id = member.user_id
  where member.team_id = p_team
    and member.user_id = target_user
    and member.status = 'active';
end;
$$;

create function public.service_get_approved_drive_account(p_team uuid,p_actor uuid)
returns text language plpgsql security definer set search_path='' as $$
declare approved_email text;
begin
 if not private.commercial_drive_allowed(p_team,p_actor) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text,713));
 select account_email into approved_email from private.commercial_google_principals
 where actor_id=p_actor and not needs_review;
 if approved_email is null then raise exception 'GOOGLE_ACCOUNT_NOT_APPROVED' using errcode='22023'; end if;
 return approved_email;
end;
$$;
revoke all on function public.service_get_approved_drive_account(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_get_approved_drive_account(uuid,uuid) to service_role;

-- Deliberate operator correction; never exposed to team administrators.
create function public.admin_reassign_space_tariff(p_id uuid,p_new_owner uuid,p_confirm_new_google_slot boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_tariff_admin(); previous public.space_tariffs%rowtype; email text;
begin
 if p_confirm_new_google_slot is distinct from true then raise exception 'INVALID_INPUT'; end if;
 select * into previous from public.space_tariffs where id=p_id for update;
 if previous.id is null or previous.team_id is null then raise exception 'NOT_FOUND'; end if;
 select u.email into email from auth.users u join public.profiles p on p.id=u.id
 where u.id=p_new_owner and u.email_confirmed_at is not null and private.team_profile_active(p_new_owner);
 if email is null or p_new_owner=previous.owner_id then raise exception 'INVALID_INPUT'; end if;
 -- Match callback lock order before changing ownership or detaching connections.
 perform pg_advisory_xact_lock(hashtextextended(least(previous.owner_id,p_new_owner)::text,713));
 perform pg_advisory_xact_lock(hashtextextended(greatest(previous.owner_id,p_new_owner)::text,713));
 perform 1 from public.teams where id=previous.team_id for update;
 if not exists(select 1 from public.team_members where team_id=previous.team_id and user_id=p_new_owner and status='active') then
  raise exception 'INVALID_INPUT';
 end if;
 perform set_config('soty.commercial_owner_correction','on',true);
 update public.teams set owner_id=p_new_owner where id=previous.team_id;
 update public.space_tariffs set owner_id=p_new_owner,owner_email=email,updated_at=clock_timestamp() where id=p_id;
 delete from public.team_members where team_id=previous.team_id and user_id=previous.owner_id;
 update public.team_drive_connections set state='detached',detached_at=clock_timestamp() where team_id=previous.team_id and state<>'detached';
 perform private.revoke_team_transfer_grants(previous.team_id,null);
 delete from private.drive_credential_references where team_id=previous.team_id;
 update public.team_invitations set state='revoked',responded_at=clock_timestamp()
 where team_id=previous.team_id and state='pending';
 insert into public.space_tariff_events(tariff_id,team_id,actor_id,kind,before,after)
 select p_id,previous.team_id,actor,'updated',private.space_tariff_snapshot(previous),private.space_tariff_snapshot(t)
 from public.space_tariffs t where id=p_id;
 perform set_config('soty.commercial_owner_correction','off',true);
 return private.admin_tariff_row(p_id);
end;
$$;
revoke all on function public.admin_reassign_space_tariff(uuid,uuid,boolean) from public,anon;
grant execute on function public.admin_reassign_space_tariff(uuid,uuid,boolean) to authenticated;

CREATE OR REPLACE FUNCTION private.space_tariff_state(p_team uuid, p_at timestamp with time zone DEFAULT private.tariff_now())
 RETURNS TABLE(state text, tariff_id uuid, plan_code text, seats_total integer, seats_used integer, ends_on date, ends_at timestamp with time zone, grace_until timestamp with time zone, days_left integer, legacy_also boolean, pending_invites integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  owner uuid;
  tariff public.space_tariffs%rowtype;
  plan_seats integer;
  legacy boolean;
  live boolean := false;
  resolved text;
  remaining integer;
begin
  select team.owner_id into owner
  from public.teams as team where team.id = p_team and team.status = 'active';
  if owner is null then
    return query select 'none'::text, null::uuid, null::text, 0, 0, null::date, null::timestamptz,
                        null::timestamptz, null::integer, false, 0;
    return;
  end if;

  legacy := private.tariff_legacy_rule_enabled() and private.team_legacy_open(p_team);
  select current_tariff.* into tariff from private.team_current_tariff(p_team, p_at) as current_tariff;
  if tariff.id is not null then
    select plan.base_seats + tariff.extra_seats into plan_seats
    from public.tariff_plans as plan where plan.code = tariff.plan_code;
    remaining := tariff.ends_on - private.kyiv_today(p_at);
    live := (tariff.revoked_at is null or tariff.revoked_at > p_at)
      and p_at < private.kyiv_day_end(tariff.ends_on + 3);
  end if;

  if exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = owner) then
    resolved := 'internal';
  elsif live then
    resolved := case when remaining > 3 then 'active' when remaining >= 0 then 'expiring' else 'grace' end;
    -- US2.2: while the legacy rule holds the space, it has no warnings.
    if resolved in ('expiring', 'grace') and legacy then
      resolved := 'legacy';
    end if;
  elsif legacy then
    resolved := 'legacy';
  elsif tariff.id is not null then
    resolved := 'blocked';
  else
    resolved := 'none';
  end if;

  return query select
    resolved,
    tariff.id,
    tariff.plan_code,
    case
      when resolved = 'internal' then null::integer
      when tariff.id is not null and (live or resolved = 'blocked') then plan_seats
      else 50
    end,
    private.team_seats_used(p_team),
    tariff.ends_on,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on) end,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on + 3) end,
    remaining,
    legacy,
    private.team_pending_invites(p_team);
end;
$function$;

create function private.drive_approval_scope(p_owner uuid,p_email text)
returns jsonb language sql stable security definer set search_path='' as $$
 with connections as (
  select c.id,c.team_id,c.credential_id from public.team_drive_connections c
  join private.google_drive_credentials g on g.id=c.credential_id
  where g.connected_by=p_owner and c.state<>'detached' and lower(btrim(g.google_account_email))<>lower(btrim(p_email))
 ), refs as (
  select r.team_id,r.credential_id from private.drive_credential_references r
  join private.google_drive_credentials g on g.id=r.credential_id
  where g.connected_by=p_owner and lower(btrim(g.google_account_email))<>lower(btrim(p_email))
 ), snapshot as (
  select jsonb_build_object('owner',p_owner,'email',lower(btrim(p_email)),
   'approval',(select to_jsonb(a) from private.commercial_google_principals a where actor_id=p_owner),
   'connections',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from connections c),'[]'),
   'references',coalesce((select jsonb_agg(to_jsonb(r) order by r.team_id) from refs r),'[]'),
   'oauth',coalesce((select jsonb_agg(encode(o.state_hash,'hex') order by o.state_hash)
     from private.drive_oauth_transactions o where actor_id=p_owner and consumed_at is null),'[]')) value
 )
 select jsonb_build_object('revision',md5(snapshot.value::text),
  'accountEmail',(select account_email from private.commercial_google_principals where actor_id=p_owner),
  'spaces',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.id)
    from public.teams t where t.id in(select team_id from connections union select team_id from refs)),'[]')) from snapshot;
$$;
revoke all on function private.drive_approval_scope(uuid,text) from public,anon,authenticated,service_role;
create function public.admin_preview_drive_account(p_owner uuid,p_email text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_tariff_admin();
 return private.drive_approval_scope(p_owner,p_email);
end;
$$;
revoke all on function public.admin_preview_drive_account(uuid,text) from public,anon;
grant execute on function public.admin_preview_drive_account(uuid,text) to authenticated;

create function public.admin_approve_drive_account(p_owner uuid,p_email text,p_confirm_new_google_slot boolean,p_expected_scope text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_tariff_admin(); normalized text:=lower(btrim(p_email)); existing_principal text;
begin
 if p_confirm_new_google_slot is distinct from true or normalized is null
 or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized)>320 then
  raise exception 'INVALID_INPUT';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,713));
 if p_expected_scope is null or p_expected_scope <> private.drive_approval_scope(p_owner,normalized)->>'revision' then
  raise exception 'WRONG_STATE';
 end if;
 if not exists(select 1 from public.space_tariffs where owner_id=p_owner and revoked_at is null)
 and not exists(select 1 from public.admin_users where user_id=p_owner) then raise exception 'PERMISSION_DENIED'; end if;
 select google_permission_id into existing_principal from private.google_drive_credentials
 where connected_by=p_owner and lower(btrim(google_account_email))=normalized order by created_at limit 1;
 perform private.revoke_team_transfer_grants(c.team_id,null)
 from public.team_drive_connections c join private.google_drive_credentials g on g.id=c.credential_id
 where g.connected_by=p_owner and lower(btrim(g.google_account_email))<>normalized and c.state<>'detached';
 update public.team_drive_connections c set state='detached',detached_at=clock_timestamp()
 from private.google_drive_credentials g where c.credential_id=g.id and g.connected_by=p_owner
 and lower(btrim(g.google_account_email))<>normalized and c.state<>'detached';
 delete from private.drive_credential_references r using private.google_drive_credentials g
 where r.credential_id=g.id and g.connected_by=p_owner and lower(btrim(g.google_account_email))<>normalized;
 update private.drive_oauth_transactions set consumed_at=clock_timestamp()
 where actor_id=p_owner and consumed_at is null;
 insert into private.commercial_google_principals(actor_id,account_email,permission_id)
 values(p_owner,normalized,existing_principal)
 on conflict(actor_id) do update set account_email=excluded.account_email,permission_id=excluded.permission_id,needs_review=false;
 return true;
end;
$$;
revoke all on function public.admin_approve_drive_account(uuid,text,boolean,text) from public,anon;
grant execute on function public.admin_approve_drive_account(uuid,text,boolean,text) to authenticated;

create or replace function public.admin_update_space_tariff(
  p_id uuid,
  p_plan text,
  p_ends_on date,
  p_extra_seats integer,
  p_note text,
  p_external_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  plan public.tariff_plans%rowtype;
  was_allowed boolean;
  new_ends date;
  new_extra integer;
begin
  if coalesce(current_setting('soty.tariff_mutation',true),'off') <> 'on' then
    raise exception 'WRONG_STATE' using errcode='P0001';
  end if;
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous.revoked_at is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  new_ends := coalesce(p_ends_on, previous.ends_on);
  new_extra := coalesce(p_extra_seats, previous.extra_seats);
  plan := private.checked_tariff_terms(coalesce(p_plan, previous.plan_code), new_extra);
  if new_ends <> previous.ends_on and new_ends < private.kyiv_today() then
    raise exception 'TARIFF_DATE_INVALID' using errcode = '22023';
  end if;
  if previous.team_id is not null
     and plan.base_seats + new_extra < private.team_seats_used(previous.team_id) then
    raise exception 'SEATS_IN_USE' using errcode = '22023';
  end if;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set plan_code = plan.code,
         ends_on = new_ends,
         extra_seats = new_extra,
         note = nullif(btrim(p_note), ''),
         external_ref = nullif(btrim(p_external_ref), ''),
         updated_at = clock_timestamp()
   where tariff.id = p_id
  returning * into updated;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor, 'updated',
          private.space_tariff_snapshot(previous), private.space_tariff_snapshot(updated));
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id);
end;
$$;

create or replace function public.admin_extend_space_tariff(p_id uuid, p_months integer, p_notify boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  row_state text;
  base_day date;
  was_allowed boolean;
  event_id uuid;
begin
  if coalesce(current_setting('soty.tariff_mutation',true),'off') <> 'on' then
    raise exception 'WRONG_STATE' using errcode='P0001';
  end if;
  if p_months is null or p_months not between 1 and 36 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select state.state into row_state from private.space_tariff_row_state(previous, private.tariff_now()) as state;
  if previous.revoked_at is not null then
    -- Bringing a revoked tariff back must not create a second live one.
    if exists (
      select 1 from public.space_tariffs as other
      where other.id <> previous.id and other.revoked_at is null
        and ((previous.team_id is not null and other.team_id = previous.team_id)
             or (previous.team_id is null and other.team_id is null
                 and lower(other.owner_email::text) = lower(previous.owner_email::text)))
    ) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
  end if;
  base_day := case
    when previous.revoked_at is not null or row_state in ('blocked', 'pending_expired')
         or (row_state = 'legacy' and previous.ends_on + 3 < private.kyiv_today())
      then private.kyiv_today()
    else previous.ends_on
  end;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set ends_on = (base_day + make_interval(months => p_months))::date,
         revoked_at = null,
         updated_at = clock_timestamp()
   where tariff.id = p_id
  returning * into updated;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor, 'extended', private.space_tariff_snapshot(previous),
          private.space_tariff_snapshot(updated) || jsonb_build_object('notify', coalesce(p_notify, false)))
  returning id into event_id;

  if coalesce(p_notify, false) then
    perform private.queue_space_tariff_letter(p_id, 'renewed');
  end if;
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id) || jsonb_build_object('eventId', event_id);
end;
$function$;

create or replace function public.admin_end_space_tariff(p_id uuid, p_now boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  was_allowed boolean;
  waiting boolean;
begin
  if coalesce(current_setting('soty.tariff_mutation',true),'off') <> 'on' then
    raise exception 'WRONG_STATE' using errcode='P0001';
  end if;
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous.revoked_at is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  waiting := previous.team_id is null;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  if coalesce(p_now, false) or waiting then
    -- Transaction time, which the gate compares against: the space closes within this call.
    update public.space_tariffs as tariff
       set revoked_at = private.tariff_now(), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  else
    update public.space_tariffs as tariff
       set ends_on = least(tariff.ends_on, private.kyiv_today()), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  end if;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor,
          case when coalesce(p_now, false) or waiting then 'ended_now' else 'ended_today' end,
          private.space_tariff_snapshot(previous), private.space_tariff_snapshot(updated));
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id);
end;
$function$;

create or replace function private.space_tariff_snapshot(p_tariff public.space_tariffs)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ownerId', p_tariff.owner_id,
    'ownerEmail', p_tariff.owner_email::text,
    'planCode', p_tariff.plan_code,
    'endsOn', p_tariff.ends_on::text,
    'extraSeats', p_tariff.extra_seats,
    'note', p_tariff.note,
    'externalRef', p_tariff.external_ref,
    'revokedAt', p_tariff.revoked_at,
    'teamId', p_tariff.team_id
  );
$$;

create or replace function public.admin_undo_space_tariff_event(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  event public.space_tariff_events%rowtype;
  previous public.space_tariffs%rowtype;
  restored public.space_tariffs%rowtype;
  was_allowed boolean;
begin
  select * into event from public.space_tariff_events where id = p_event for update;
  if event.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into previous from public.space_tariffs where id = event.tariff_id for update;
  if previous.id is null or not private.space_tariff_event_undoable(event) or event.before is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if previous.revoked_at is not null and (event.before ->> 'revokedAt') is null and exists (
    select 1 from public.space_tariffs as other
    where other.id <> previous.id and other.revoked_at is null
      and ((previous.team_id is not null and other.team_id = previous.team_id)
           or (previous.team_id is null and other.team_id is null
               and lower(other.owner_email::text) = lower(previous.owner_email::text)))
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;
  if not coalesce(event.after @> private.space_tariff_snapshot(previous),false) then
    raise exception 'WRONG_STATE' using errcode='P0001';
  end if;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set plan_code = event.before ->> 'planCode',
         ends_on = (event.before ->> 'endsOn')::date,
         extra_seats = (event.before ->> 'extraSeats')::integer,
         note = event.before ->> 'note',
         external_ref = event.before ->> 'externalRef',
         revoked_at = (event.before ->> 'revokedAt')::timestamptz,
         updated_at = clock_timestamp()
   where tariff.id = previous.id
  returning * into restored;

  update public.space_tariff_events set undone_at = clock_timestamp() where id = event.id;
  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (previous.id, restored.team_id, actor, 'undone',
          private.space_tariff_snapshot(previous),
          private.space_tariff_snapshot(restored) || jsonb_build_object('undoneEventId', event.id,
                                                                         'undoneKind', event.kind));
  perform private.after_space_tariff_change(restored.team_id, was_allowed);
  return private.admin_tariff_row(previous.id);
end;
$$;

insert into public.team_error_codes(code) values ('GOOGLE_ACCOUNT_NOT_APPROVED') on conflict do nothing;

create function public.admin_grant_space_tariff_once(p_operation uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.require_tariff_admin(); prior private.commercial_tariff_mutations%rowtype; output jsonb;
begin
 if p_operation is null then raise exception 'INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||p_operation::text,714));
 select * into prior from private.commercial_tariff_mutations where actor_id=actor and operation_id=p_operation;
 if prior.operation_id is not null then
  if prior.request <> jsonb_build_object('action','grant','input',p_input) then raise exception 'INVALID_INPUT'; end if;
  return prior.result;
 end if;
 perform set_config('soty.tariff_mutation','on',true);
 output:=public.admin_grant_space_tariff(p_input->>'email',p_input->>'plan',(p_input->>'endsOn')::date,
   coalesce((p_input->>'extraSeats')::integer,0),(p_input->>'teamId')::uuid,p_input->>'note',p_input->>'externalRef',
   coalesce((p_input->>'notify')::boolean,false),coalesce(p_input->>'source','manual'));
 perform set_config('soty.tariff_mutation','off',true);
 insert into private.commercial_tariff_mutations(actor_id,operation_id,tariff_id,request,result) values(actor,p_operation,(output->>'id')::uuid,jsonb_build_object('action','grant','input',p_input),output);
 return output;
end;
$$;
revoke all on function public.admin_grant_space_tariff_once(uuid,jsonb) from public,anon;
grant execute on function public.admin_grant_space_tariff_once(uuid,jsonb) to authenticated;

create or replace function public.admin_grant_space_tariff(
  p_email text,
  p_plan text,
  p_ends_on date,
  p_extra_seats integer,
  p_team uuid default null,
  p_note text default null,
  p_external_ref text default null,
  p_notify boolean default false,
  p_source text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  canonical_email text := lower(btrim(p_email));
  plan public.tariff_plans%rowtype;
  account uuid;
  was_allowed boolean := false;
  created public.space_tariffs%rowtype;
begin
 if coalesce(current_setting('soty.tariff_mutation',true),'off') <> 'on' then raise exception 'WRONG_STATE'; end if;
  if canonical_email is null
     or canonical_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(canonical_email) > 320
     or coalesce(p_source, 'manual') not in ('manual', 'trial') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  plan := private.checked_tariff_terms(p_plan, coalesce(p_extra_seats, 0));
  if p_ends_on is null or p_ends_on < private.kyiv_today() then
    raise exception 'TARIFF_DATE_INVALID' using errcode = '22023';
  end if;
  account := private.tariff_account_for_email(canonical_email);

  if p_team is not null then
    perform 1 from public.teams as team
    where team.id = p_team and team.status = 'active' and team.owner_id = account
    for update;
    if not found or account is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if exists (select 1 from public.space_tariffs as tariff
               where tariff.team_id = p_team and tariff.revoked_at is null) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
    if plan.base_seats + coalesce(p_extra_seats, 0) < private.team_seats_used(p_team) then
      raise exception 'SEATS_IN_USE' using errcode = '22023';
    end if;
    was_allowed := private.team_workspace_allowed(p_team);
  elsif exists (
    select 1 from public.space_tariffs as tariff
    where tariff.team_id is null and tariff.revoked_at is null
      and lower(tariff.owner_email::text) = canonical_email
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;

  insert into public.space_tariffs (
    owner_email, owner_id, team_id, plan_code, extra_seats, ends_on, source, external_ref, note,
    granted_by, claimed_at, bound_at
  ) values (
    canonical_email, account, p_team, plan.code, coalesce(p_extra_seats, 0), p_ends_on,
    coalesce(p_source, 'manual'), nullif(btrim(p_external_ref), ''), nullif(btrim(p_note), ''),
    actor, case when account is not null then clock_timestamp() end,
    case when p_team is not null then clock_timestamp() end
  ) returning * into created;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, after)
  values (created.id, created.team_id, actor, 'granted',
          private.space_tariff_snapshot(created) || jsonb_build_object('notify', coalesce(p_notify, false)));

  if coalesce(p_notify, false) then
    perform private.queue_space_tariff_letter(created.id, 'granted');
  end if;
  perform private.after_space_tariff_change(p_team, was_allowed);
  return private.admin_tariff_row(created.id);
end;
$$;

CREATE OR REPLACE FUNCTION private.team_seat_limit(p_team uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when exists (
      select 1 from public.teams as team
      join public.admin_users as owner_admin on owner_admin.user_id = team.owner_id
      where team.id = p_team
    ) then null
    else coalesce((
      select plan.base_seats + tariff.extra_seats
      from public.space_tariffs as tariff
      join public.tariff_plans as plan on plan.code = tariff.plan_code
      where tariff.team_id = p_team
        and (tariff.revoked_at is null or tariff.revoked_at > private.tariff_now())
        and private.tariff_now() < private.kyiv_day_end(tariff.ends_on + 3)
      limit 1
    ),50)
  end;
$function$;

create or replace function private.space_tariff_event_undoable(p_event public.space_tariff_events)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_event.kind in ('extended', 'updated', 'ended_today', 'ended_now')
    and p_event.before is not null
    and (p_event.before->>'ownerId') is not distinct from (p_event.after->>'ownerId')
    and p_event.undone_at is null
    and p_event.tariff_id is not null
    and p_event.created_at > now() - interval '10 minutes'
    and not exists (
      select 1 from public.space_tariff_events as later
      where later.tariff_id = p_event.tariff_id
        and (later.created_at > p_event.created_at
             or (later.created_at = p_event.created_at and later.id > p_event.id))
        and later.kind not in ('claimed', 'member_removed', 'invitation_revoked')
    );
$$;
-- Record pre-existing over-capacity without granting free seats or deleting users.
insert into private.commercial_access_journal(owner_id,team_id,kind,seats_used,seats_total)
select t.owner_id,t.id,'migration_capacity_review',private.team_seats_used(t.id),private.team_seat_limit(t.id)
from public.teams t where t.status='active' and private.team_seats_used(t.id)>private.team_seat_limit(t.id);
create view public.analytics_commercial_access as
select id,owner_id,team_id,kind,observed_at,needs_review,principal_bound,seats_used,seats_total
from private.commercial_access_journal
union all
select m.operation_id,(m.result->>'ownerId')::uuid,(m.result->>'teamId')::uuid,'tariff_'||(m.request->>'action')||'_committed',
 m.committed_at,null::boolean,null::boolean,null::integer,null::integer
from private.commercial_tariff_mutations m;
revoke all on public.analytics_commercial_access from public,anon,authenticated;
grant select on public.analytics_commercial_access to service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_commercial_access to wishly_analytics_ro;
 end if;
end; $$;
