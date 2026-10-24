-- T167: a browser-visible acknowledgement and its durable server evidence commit together.
-- The existing actor/installation retirement RPC remains the only revocation implementation.
begin;
create table private.team_recovery_retirement_attempts (
 actor_id uuid not null references auth.users(id) on delete cascade,
 attempt_id uuid not null,
 installation_id uuid not null,
 retired_count integer not null check(retired_count>=0),
 confirmed_at timestamptz not null default clock_timestamp(),
 primary key(actor_id,attempt_id)
);
create index recovery_retirement_attempt_lookup on private.team_recovery_retirement_attempts(attempt_id);
create index recovery_retirement_installation_lookup on private.team_recovery_retirement_attempts(installation_id,confirmed_at);
create index recovery_retirement_receipt_retention on private.team_recovery_retirement_attempts(confirmed_at,actor_id,attempt_id);
create table private.team_recovery_retirement_rates (
 actor_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null default clock_timestamp(),
 attempts integer not null default 0 check(attempts between 0 and 60)
);
create index recovery_retirement_rate_retention on private.team_recovery_retirement_rates(window_start,actor_id);
alter table private.team_recovery_retirement_attempts enable row level security;
alter table private.team_recovery_retirement_attempts force row level security;
alter table private.team_recovery_retirement_rates enable row level security;
alter table private.team_recovery_retirement_rates force row level security;
revoke all on private.team_recovery_retirement_attempts,private.team_recovery_retirement_rates
 from public,anon,authenticated,service_role;

-- Identity-only ledgers are not material references. Any new column/type, JSON or material FK
-- cancels their exemption, so future consumers still fail closed until registered.
create or replace function private.task_cleanup_reference_tables() returns table(schema_name text,table_name text)
language sql stable set search_path='' as $$
 select n.nspname::text,c.relname::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
 where n.nspname in ('public','private') and c.relkind='r' and (c.relname like 'team_%' or c.relname like 'launch_%' or c.relname like 'catalog_%'
 or exists(select 1 from pg_catalog.pg_constraint f where f.conrelid=c.oid and f.contype='f' and f.confrelid='public.team_materials'::regclass)
 or exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.atttypid in ('json'::regtype,'jsonb'::regtype)))
 and not ((c.relname in ('team_recovery_enrollments','team_recovery_delegations','team_recovery_credentials','team_recovery_claim_receipts','team_recovery_rate_buckets')
   or (n.nspname='private' and c.relname='team_recovery_retirement_attempts' and not exists(
     select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
     and (a.attname::text,a.atttypid) not in (values
       ('actor_id','uuid'::regtype),('attempt_id','uuid'::regtype),('installation_id','uuid'::regtype),
       ('retired_count','int4'::regtype),('confirmed_at','timestamptz'::regtype))))
   or (n.nspname='private' and c.relname='team_recovery_retirement_rates' and not exists(
     select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
     and (a.attname::text,a.atttypid) not in (values
       ('actor_id','uuid'::regtype),('window_start','timestamptz'::regtype),('attempts','int4'::regtype)))))
   and not exists(select 1 from pg_catalog.pg_constraint f where f.conrelid=c.oid and f.contype='f' and f.confrelid='public.team_materials'::regclass)
   and not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and a.atttypid in ('json'::regtype,'jsonb'::regtype)))
 and c.relname not in ('team_catalog_events','team_audit_events','team_bulk_trash_groups','team_bulk_trash_items','task_attachment_cleanup','task_owned_uploads')

$$;

create function public.retire_team_recovery_installation_observed(p_installation uuid,p_attempt uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); receipt private.team_recovery_retirement_attempts;
 budget private.team_recovery_retirement_rates; actual_now timestamptz; retired integer;
begin
 if actor is null then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_installation is null or p_attempt is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 -- Same attempt is independent across actors. Serialize before both receipt lookup and cleanup.
 perform pg_advisory_xact_lock(hashtextextended('recovery-retirement-attempt:'||actor::text||':'||p_attempt::text,0));
 select * into receipt from private.team_recovery_retirement_attempts
  where actor_id=actor and attempt_id=p_attempt;
 if receipt.attempt_id is not null then
  if receipt.installation_id<>p_installation then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  return jsonb_build_object('attemptId',receipt.attempt_id,'state','server_confirmed','retiredCount',receipt.retired_count);
 end if;
 -- One bounded rate row per actor; cached retries do not consume a new-attempt budget.
 insert into private.team_recovery_retirement_rates(actor_id) values(actor) on conflict do nothing;
 select * into budget from private.team_recovery_retirement_rates where actor_id=actor for update;
 actual_now:=clock_timestamp();
 if budget.window_start<=actual_now-interval '60 seconds' then
  budget.window_start:=actual_now;budget.attempts:=0;
 end if;
 if budget.attempts>=60 then raise exception 'RATE_LIMITED'; end if;
 update private.team_recovery_retirement_rates set window_start=budget.window_start,attempts=budget.attempts+1
  where actor_id=actor;
 -- This calls the existing installation lock and retirement logic, including in-flight setup.
 retired:=public.retire_team_recovery_installation(p_installation);
 insert into private.team_recovery_retirement_attempts(actor_id,attempt_id,installation_id,retired_count)
 values(actor,p_attempt,p_installation,retired);
 return jsonb_build_object('attemptId',p_attempt,'state','server_confirmed','retiredCount',retired);
end $$;
revoke all on function public.retire_team_recovery_installation_observed(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.retire_team_recovery_installation_observed(uuid,uuid) to authenticated;

create view public.analytics_recovery_retirement with(security_barrier=true) as
 select actor_id,attempt_id,installation_id,retired_count,confirmed_at
 from private.team_recovery_retirement_attempts;
revoke all on public.analytics_recovery_retirement from public,anon,authenticated,service_role;
grant select on public.analytics_recovery_retirement to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_recovery_retirement to wishly_analytics_ro;
 end if;
end $$;

-- Separate retention class: never expire a receipt using the tariff-domain clock.
create function private.sweep_recovery_retirement_receipts()
returns void language plpgsql security definer set search_path='' as $$
begin
 with doomed as (
  select actor_id,attempt_id from private.team_recovery_retirement_attempts
  where confirmed_at<clock_timestamp()-interval '30 days'
  order by confirmed_at,actor_id,attempt_id limit 100 for update skip locked
 ) delete from private.team_recovery_retirement_attempts receipt using doomed
  where receipt.actor_id=doomed.actor_id and receipt.attempt_id=doomed.attempt_id;
 -- Rate rows contain no history; inactive actors need no continuing rate state.
 with doomed as (
  select actor_id from private.team_recovery_retirement_rates
  where window_start<clock_timestamp()-interval '30 days'
  order by window_start,actor_id limit 100 for update skip locked
 ) delete from private.team_recovery_retirement_rates budget using doomed where budget.actor_id=doomed.actor_id;
end $$;
revoke all on function private.sweep_recovery_retirement_receipts() from public,anon,authenticated,service_role;
-- Preserve the complete current lifecycle sweep; its existing cron continues to call this name.
alter function private.sweep_workspace_recovery() rename to sweep_workspace_recovery_before_retirement_receipts;
revoke all on function private.sweep_workspace_recovery_before_retirement_receipts() from public,anon,authenticated,service_role;
create function private.sweep_workspace_recovery()
returns void language plpgsql security definer set search_path='' as $$
begin
 perform private.sweep_workspace_recovery_before_retirement_receipts();
 perform private.sweep_recovery_retirement_receipts();
end $$;
revoke all on function private.sweep_workspace_recovery() from public,anon,authenticated,service_role;
commit;
