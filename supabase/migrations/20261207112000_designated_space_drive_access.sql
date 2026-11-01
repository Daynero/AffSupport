-- 1.3.0 owner decision: retain the existing explicitly designated no-tariff spaces.
-- Global admin ownership and legacy designation remain distinct from paid access.
-- Keep owner/membership and approved-Google-identity fences on every Drive seam.
begin;
create or replace function private.commercial_drive_allowed(p_team uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(private.team_role(p_team,p_actor)='owner',false)
 and private.team_workspace_allowed(p_team)
 and (exists(select 1 from public.admin_users where user_id=p_actor)
   or exists(select 1 from public.space_tariffs where team_id=p_team and owner_id=p_actor
     and revoked_at is null and ends_on + 3 >= private.kyiv_today())
   or (private.tariff_legacy_rule_enabled() and private.team_legacy_open(p_team)));
$$;
revoke all on function private.commercial_drive_allowed(uuid,uuid) from public,anon,authenticated,service_role;

-- Retain any existing verified principal, including its review flag. A legacy
-- owner with no previous connection starts with the same sign-in-email approval
-- used for internal admins; this grants no global administrative permission.
insert into private.commercial_google_principals(actor_id,account_email)
select distinct u.id,lower(btrim(u.email))
from auth.users u join public.teams t on t.owner_id=u.id
where t.status='active' and u.email is not null and btrim(u.email)<>''
 and private.tariff_legacy_rule_enabled()
 and private.team_legacy_open(t.id)
on conflict(actor_id) do nothing;

create or replace function public.service_store_google_drive_credential(
 p_actor uuid, p_google_permission_id text, p_google_account_email text, p_scope text,
 p_refresh_token text default null, p_existing_credential uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare approved private.commercial_google_principals%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text, 713));
 if not exists (
   select 1 from public.teams t where private.commercial_drive_allowed(t.id,p_actor)
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

create or replace function public.admin_approve_drive_account(p_owner uuid,p_email text,p_confirm_new_google_slot boolean,p_expected_scope text default null)
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
 and not exists(select 1 from public.admin_users where user_id=p_owner)
 and not exists(select 1 from public.teams t where private.commercial_drive_allowed(t.id,p_owner))
 then raise exception 'PERMISSION_DENIED'; end if;
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

commit;
