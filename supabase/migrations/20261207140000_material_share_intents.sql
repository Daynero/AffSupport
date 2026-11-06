begin;
insert into public.team_error_codes(code) values
 ('CATALOG_LINK_UNAVAILABLE'),('CATALOG_LINK_SHARING_UNCERTAIN'),
 ('CATALOG_LINK_REQUEST_EXPIRED'),('CLIPBOARD_UNAVAILABLE'),('CATALOG_LINK_UPDATE_REQUIRED')
on conflict(code) do nothing;

-- Opaque per-file generations fence requests whose provider read preceded a
-- different accepted share. UUID versions avoid ABA when an idle authority expires.
create table private.team_material_share_authorities (
 team_id uuid not null references public.teams(id) on delete cascade,
 file_fingerprint text not null check(file_fingerprint ~ '^[a-f0-9]{64}$'),
 version uuid not null,last_consumed_at timestamptz not null default clock_timestamp(),
 primary key(team_id,file_fingerprint)
);
alter table private.team_material_share_authorities enable row level security;
alter table private.team_material_share_authorities force row level security;
revoke all on private.team_material_share_authorities from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.team_material_share_authorities
 for each row execute function private.guard_task_cleanup_reference();

-- A consumed permission-create permit is never reissued, even after a lost reply.
-- Completed receipts retain only a payload digest, not material/provider references.
create table private.team_material_share_intents (
 id uuid primary key default gen_random_uuid(),
 team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null,
 request_key text not null check(char_length(request_key) between 8 and 200),
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 file_fingerprint text not null check(file_fingerprint ~ '^[a-f0-9]{64}$'),
 write_attempted boolean not null,
 state text not null check(state in ('write_started','acknowledged','confirmed','blocked')),
 material_id uuid,
 provider_file_id text,
 permission_id text check(permission_id is null or char_length(permission_id) between 1 and 200),
 predecessor_id uuid references private.team_material_share_intents(id) on delete set null,
 created_at timestamptz not null default clock_timestamp(),
 confirmed_at timestamptz,
 unique(team_id,actor_id,request_key),
 check((state in ('write_started','acknowledged') and material_id is not null and provider_file_id is not null)
   or (state in ('confirmed','blocked') and material_id is null and provider_file_id is null)),
 check(state<>'acknowledged' or permission_id is not null),
 check((state='confirmed')=(confirmed_at is not null)),
 check(predecessor_id is null or predecessor_id<>id)
);
create unique index material_share_one_pending_file on private.team_material_share_intents(team_id,provider_file_id)
 where state in ('write_started','acknowledged');
create index material_share_pending_fingerprint on private.team_material_share_intents(team_id,file_fingerprint)
 where state in ('write_started','acknowledged');
create index material_share_expiry on private.team_material_share_intents(created_at)
 where state in ('confirmed','blocked');
alter table private.team_material_share_intents enable row level security;
alter table private.team_material_share_intents force row level security;
revoke all on private.team_material_share_intents from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.team_material_share_intents
 for each row execute function private.guard_task_cleanup_reference();

create function public.service_begin_material_share(
 p_team uuid,p_actor uuid,p_material uuid,p_connection uuid,p_file text,
 p_key text,p_remember boolean,p_public_observed boolean,p_expected_share_version uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare item public.team_materials%rowtype; prior private.team_material_share_intents%rowtype;
 active private.team_material_share_intents%rowtype; created private.team_material_share_intents%rowtype;
 digest text; key_time timestamptz; file_digest text; observed_version uuid;
begin
 if p_key is null or p_key !~ '^share[.]v2:[0-9]{13}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or p_remember is null or p_public_observed is null or p_file is null
   or char_length(p_file) not between 1 and 200 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if p_actor is null or not private.can(p_team,case when p_public_observed then 'view' else 'edit' end,p_actor) then
   raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 -- Serialize aliases of the same provider file, then enter the existing cleanup fence.
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||':'||p_file,4710));
 select * into item from public.team_materials where id=p_material and team_id=p_team for update;
 if not found or item.lifecycle<>'active' then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 if item.connection_id is distinct from p_connection or item.drive_file_id is distinct from p_file then
   raise exception 'STALE_RESULT' using errcode='40001'; end if;
 digest:=encode(extensions.digest(convert_to(jsonb_build_array(p_team,p_actor,p_material,p_connection,p_file,p_remember,p_expected_share_version)::text,'UTF8'),'sha256'),'hex');
 file_digest:=encode(extensions.digest(convert_to(p_team::text||':'||p_file,'UTF8'),'sha256'),'hex');
 select version into observed_version from private.team_material_share_authorities where team_id=p_team and file_fingerprint=file_digest;
 select * into prior from private.team_material_share_intents
   where team_id=p_team and actor_id=p_actor and request_key=p_key for update;
 if found then
   if prior.fingerprint<>digest then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   return jsonb_build_object('intentId',prior.id,'state',prior.state,'shareVersion',observed_version,'writeAllowed',false,'attribution',
     case when prior.permission_id is not null then 'acknowledged' when prior.write_attempted or prior.state='blocked' then 'unknown' else 'unchanged' end);
 end if;
 -- A timestamp is part of the immutable request key. Old replay keys cannot become
 -- fresh writes after bounded completed-receipt retention; browser clock is not used.
 key_time:=to_timestamp(split_part(p_key,':',2)::bigint/1000.0);
 if key_time<clock_timestamp()-interval '5 minutes' or key_time>clock_timestamp()+interval '5 minutes' then
   raise exception 'CATALOG_LINK_REQUEST_EXPIRED' using errcode='22023'; end if;
 select * into active from private.team_material_share_intents
   where team_id=p_team and provider_file_id=p_file and state in ('write_started','acknowledged') for update;
 if not p_public_observed and active.id is null and observed_version is distinct from p_expected_share_version then
   raise exception 'STALE_RESULT' using errcode='40001'; end if;
 insert into private.team_material_share_intents(team_id,actor_id,request_key,fingerprint,file_fingerprint,write_attempted,state,material_id,provider_file_id,predecessor_id,confirmed_at)
 values(p_team,p_actor,p_key,digest,file_digest,
   not p_public_observed and active.id is null,
   case when p_public_observed then 'confirmed' when active.id is not null then 'blocked' else 'write_started' end,
   case when not p_public_observed and active.id is null then p_material end,
   case when not p_public_observed and active.id is null then p_file end,
   active.id,case when p_public_observed then clock_timestamp() end) returning * into created;
 -- A new public observation may settle an older uncertain write; never attribute
 -- another actor's observed permission to this request.
 if p_public_observed and active.id is not null then
   update private.team_material_share_intents set state='confirmed',confirmed_at=clock_timestamp(),
     material_id=null,provider_file_id=null where id=active.id;
 end if;
 if created.state='write_started' then
   insert into private.team_material_share_authorities(team_id,file_fingerprint,version) values(p_team,file_digest,gen_random_uuid())
     on conflict(team_id,file_fingerprint) do update set version=gen_random_uuid(),last_consumed_at=clock_timestamp()
     returning version into observed_version;
 end if;
 return jsonb_build_object('intentId',created.id,'state',created.state,'shareVersion',observed_version,'writeAllowed',created.state='write_started',
   'attribution',case when created.state='blocked' then 'unknown' else 'unchanged' end);
end $$;

create function public.service_acknowledge_material_share(p_team uuid,p_actor uuid,p_intent uuid,p_permission text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_permission is null or char_length(p_permission) not between 1 and 200 then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 update private.team_material_share_intents set state='acknowledged',permission_id=p_permission
 where id=p_intent and team_id=p_team and actor_id=p_actor and state in ('write_started','acknowledged')
   and (permission_id is null or permission_id=p_permission);
 return found;
end $$;

create function public.service_confirm_material_share(p_team uuid,p_actor uuid,p_intent uuid,p_file text,p_permission text default null,p_no_write boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare receipt private.team_material_share_intents%rowtype;
begin
 if p_no_write is null or p_file is null or char_length(p_file) not between 1 and 200 or
   (p_permission is not null and char_length(p_permission) not between 1 and 200) then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||':'||p_file,4710));
 select * into receipt from private.team_material_share_intents
   where id=p_intent and team_id=p_team and actor_id=p_actor for update;
 if not found then return false; end if;
 if receipt.file_fingerprint<>encode(extensions.digest(convert_to(p_team::text||':'||p_file,'UTF8'),'sha256'),'hex') then
   raise exception 'STALE_RESULT' using errcode='40001'; end if;
 if receipt.state='confirmed' then return true; end if;
 if receipt.state='blocked' then
   if p_permission is not null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
   update private.team_material_share_intents set state='confirmed',confirmed_at=clock_timestamp(),material_id=null,provider_file_id=null
   where id=receipt.predecessor_id and team_id=p_team and provider_file_id=p_file and state in ('write_started','acknowledged');
   -- A predecessor may already be confirmed or expired from completed history.
   -- This blocked key still never receives a new write permit.
 else
   if receipt.provider_file_id is distinct from p_file or
      (receipt.permission_id is not null and p_permission is not null and receipt.permission_id<>p_permission) then
     raise exception 'STALE_RESULT' using errcode='40001'; end if;
 end if;
 if p_no_write and (p_permission is not null or receipt.permission_id is not null or receipt.state<>'write_started') then
   raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 update private.team_material_share_intents set state='confirmed',confirmed_at=clock_timestamp(),
   write_attempted=case when p_no_write then false else write_attempted end,
   permission_id=coalesce(permission_id,p_permission),material_id=null,provider_file_id=null where id=receipt.id;
 return true;
end $$;

-- A Get-link read may reconcile ledger evidence after observing public access.
-- This boundary never creates or removes a provider permission or preference.
create function public.service_observe_material_share_public(p_team uuid,p_actor uuid,p_material uuid,p_file text)
returns integer language plpgsql security definer set search_path='' as $$
declare settled integer;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if not exists(select 1 from public.team_materials where id=p_material and team_id=p_team
   and drive_file_id=p_file and lifecycle='active') then raise exception 'STALE_RESULT' using errcode='40001'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||':'||p_file,4710));
 update private.team_material_share_intents set state='confirmed',confirmed_at=clock_timestamp(),material_id=null,provider_file_id=null
   where team_id=p_team and provider_file_id=p_file and state in ('write_started','acknowledged');
 get diagnostics settled=row_count;
 return settled;
end $$;

create function public.service_material_share_status(p_team uuid,p_actor uuid,p_material uuid,p_file text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare pending private.team_material_share_intents%rowtype; observed_version uuid;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if not exists(select 1 from public.team_materials where id=p_material and team_id=p_team
   and drive_file_id=p_file and lifecycle='active') then raise exception 'STALE_RESULT' using errcode='40001'; end if;
 select * into pending from private.team_material_share_intents
   where team_id=p_team and provider_file_id=p_file and state in ('write_started','acknowledged');
 select version into observed_version from private.team_material_share_authorities
   where team_id=p_team and file_fingerprint=encode(extensions.digest(convert_to(p_team::text||':'||p_file,'UTF8'),'sha256'),'hex');
 return jsonb_build_object('pending',pending.id is not null,'shareVersion',observed_version,'commandId',
   case when pending.actor_id=p_actor then split_part(pending.request_key,':',3)::uuid end);
end $$;

create view public.analytics_material_share_intents as
 select id intent_id,team_id,actor_id,split_part(request_key,':',3)::uuid command_id,
   state,write_attempted as write_may_have_started,permission_id is not null permission_acknowledged,
   created_at,confirmed_at,material_id
 from private.team_material_share_intents;
revoke all on public.analytics_material_share_intents from public,anon,authenticated,service_role;
do $$ begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
 grant select on public.analytics_material_share_intents to wishly_analytics_ro;
end if; end $$;

-- Unknown writes are never expired. Removed keys carry their issuance time, so
-- their replay fails the fresh-key window even after this bounded cleanup.
create function public.service_prune_material_share_receipts(p_limit integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare removed integer; authorities_removed integer;
begin
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 with candidates as (select id from private.team_material_share_intents
   where state in ('confirmed','blocked') and created_at<clock_timestamp()-interval '31 days'
   order by created_at limit p_limit for update skip locked), deleted as (
   delete from private.team_material_share_intents x using candidates c where x.id=c.id returning 1)
 select count(*)::integer into removed from deleted;
 with candidates as (select a.team_id,a.file_fingerprint from private.team_material_share_authorities a
   where a.last_consumed_at<clock_timestamp()-interval '31 days'
   and not exists(select 1 from private.team_material_share_intents i where i.team_id=a.team_id
     and i.file_fingerprint=a.file_fingerprint and i.state in ('write_started','acknowledged'))
   order by a.last_consumed_at limit greatest(0,p_limit-removed) for update of a skip locked), deleted as (
   delete from private.team_material_share_authorities a using candidates c
   where a.team_id=c.team_id and a.file_fingerprint=c.file_fingerprint returning 1)
 select count(*)::integer into authorities_removed from deleted;
 return removed+authorities_removed;
end $$;
revoke all on function public.service_begin_material_share(uuid,uuid,uuid,uuid,text,text,boolean,boolean,uuid),
 public.service_acknowledge_material_share(uuid,uuid,uuid,text),public.service_confirm_material_share(uuid,uuid,uuid,text,text,boolean),
 public.service_prune_material_share_receipts(integer),public.service_observe_material_share_public(uuid,uuid,uuid,text),public.service_material_share_status(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_begin_material_share(uuid,uuid,uuid,uuid,text,text,boolean,boolean,uuid),
 public.service_acknowledge_material_share(uuid,uuid,uuid,text),public.service_confirm_material_share(uuid,uuid,uuid,text,text,boolean),
 public.service_prune_material_share_receipts(integer),public.service_observe_material_share_public(uuid,uuid,uuid,text),public.service_material_share_status(uuid,uuid,uuid,text) to service_role;
select cron.schedule('material-share-receipt-retention','*/5 * * * *',
  'select public.service_prune_material_share_receipts(100)');
notify pgrst,'reload schema';
commit;
