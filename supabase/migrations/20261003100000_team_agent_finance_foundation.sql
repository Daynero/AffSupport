-- Feature 027: calendar money. Legacy data is frozen, never guessed to be a payment.
begin;
lock table public.team_account_agents in share row exclusive mode;
alter table public.team_account_agents add constraint team_agents_tenant_key unique(id, team_id);
create table public.team_agent_placements (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 agent_row_id uuid not null, account_id uuid not null, starts_on date not null, ends_on date,
 version bigint not null default 1 check(version>0),
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id) on delete cascade,
 foreign key(account_id,team_id) references public.team_accounts(id,team_id) on delete cascade,
 unique(id,team_id), unique(id,team_id,agent_row_id,account_id), check(ends_on is null or ends_on>starts_on)
);
create unique index team_agent_one_open_placement on public.team_agent_placements(agent_row_id) where ends_on is null;
create index team_agent_placement_dates on public.team_agent_placements(team_id,agent_row_id,starts_on);
insert into public.team_agent_placements(team_id,agent_row_id,account_id,starts_on)
 select team_id,id,account_id,(created_at at time zone 'UTC')::date from public.team_account_agents;
create table public.team_agent_finance_values (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 agent_row_id uuid not null, placement_id uuid not null, account_id uuid not null, entry_date date not null,
 metric text not null check(metric in ('balance','topup','spend')),
 amount_cents bigint check(amount_cents between 0 and 99999999999), currency text not null default 'USD' check(currency='USD'),
 version bigint not null default 1 check(version>0), updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id) on delete set null,
 unique(team_id,agent_row_id,entry_date,metric),
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id) deferrable initially deferred,
 foreign key(placement_id,team_id,agent_row_id,account_id) references public.team_agent_placements(id,team_id,agent_row_id,account_id) deferrable initially deferred,
 foreign key(account_id,team_id) references public.team_accounts(id,team_id) deferrable initially deferred
);
create index team_finance_period on public.team_agent_finance_values(team_id,entry_date,agent_row_id);
create table public.team_agent_finance_events (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 agent_row_id uuid not null, account_id uuid not null, placement_id uuid not null, entry_date date not null,
 metric text not null check(metric in ('balance','topup','spend')), old_cents bigint, new_cents bigint,
 previous_version bigint not null, new_version bigint not null,
 actor_id uuid references auth.users(id) on delete set null, occurred_at timestamptz not null default clock_timestamp(), request_id uuid not null,
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id) deferrable initially deferred,
 foreign key(account_id,team_id) references public.team_accounts(id,team_id) deferrable initially deferred,
 foreign key(placement_id,team_id,agent_row_id,account_id) references public.team_agent_placements(id,team_id,agent_row_id,account_id) deferrable initially deferred
);
create index team_finance_history on public.team_agent_finance_events(team_id,agent_row_id,occurred_at,id);
create table public.team_agent_transfer_events (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 agent_row_id uuid not null, from_placement_id uuid not null, to_placement_id uuid not null, effective_on date not null,
 actor_id uuid references auth.users(id) on delete set null, occurred_at timestamptz not null default clock_timestamp(), request_id uuid not null,
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id) deferrable initially deferred,
 foreign key(from_placement_id,team_id) references public.team_agent_placements(id,team_id) deferrable initially deferred,
 foreign key(to_placement_id,team_id) references public.team_agent_placements(id,team_id) deferrable initially deferred
);
create table public.team_agent_finance_legacy (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 agent_row_id uuid not null, account_id uuid not null, captured_at timestamptz not null default now(),
 balance_units integer, requested_topup_units integer, balance_imported_event_id uuid, topup_imported_event_id uuid,
 unique(agent_row_id),
 foreign key(agent_row_id,team_id) references public.team_account_agents(id,team_id) deferrable initially deferred,
 foreign key(account_id,team_id) references public.team_accounts(id,team_id) deferrable initially deferred
);
insert into public.team_agent_finance_legacy(team_id,agent_row_id,account_id,balance_units,requested_topup_units)
 select team_id,id,account_id,balance,topup from public.team_account_agents where balance is not null or topup is not null;
create table public.team_agent_finance_requests (
 team_id uuid not null references public.teams(id) on delete cascade, actor_id uuid not null,
 request_id uuid not null, payload jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), undone_by_request_id uuid,
 primary key(team_id,actor_id,request_id)
);
do $$ declare t text; begin
 foreach t in array array['team_agent_placements','team_agent_finance_values','team_agent_finance_events','team_agent_transfer_events','team_agent_finance_legacy','team_agent_finance_requests'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('create policy finance_view on public.%I for select to authenticated using (private.can(team_id,''view'',auth.uid())%s)',t,case when t='team_agent_finance_requests' then ' and actor_id=auth.uid()' else '' end);
  -- Explicit columns below are used instead of table-wide grants.
 end loop;
end $$;
grant select(id,team_id,agent_row_id,account_id,starts_on,ends_on,version) on public.team_agent_placements to authenticated;
grant select(id,team_id,agent_row_id,placement_id,account_id,entry_date,metric,amount_cents,currency,version,updated_at,updated_by) on public.team_agent_finance_values to authenticated;
grant select(id,team_id,agent_row_id,account_id,placement_id,entry_date,metric,old_cents,new_cents,previous_version,new_version,actor_id,occurred_at,request_id) on public.team_agent_finance_events to authenticated;
grant select(id,team_id,agent_row_id,from_placement_id,to_placement_id,effective_on,actor_id,occurred_at,request_id) on public.team_agent_transfer_events to authenticated;
grant select(id,team_id,agent_row_id,account_id,captured_at,balance_units,requested_topup_units,balance_imported_event_id,topup_imported_event_id) on public.team_agent_finance_legacy to authenticated;

create function private.finance_today(p_timezone text) returns date language plpgsql stable set search_path='' as $$
begin
 if p_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_timezone) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 return (now() at time zone p_timezone)::date;
end $$;
create function private.finance_agent_insert() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.team_agent_placements(team_id,agent_row_id,account_id,starts_on) values(new.team_id,new.id,new.account_id,(new.created_at at time zone 'UTC')::date);
 return new;
end $$;
create trigger finance_initial_placement after insert on public.team_account_agents for each row execute function private.finance_agent_insert();

-- Keep the previous implementation as a private helper so runs and other contracts are preserved.
alter function public.add_team_account_agent(uuid,uuid,text,text) set schema private;
alter function private.add_team_account_agent(uuid,uuid,text,text) rename to finance_create_agent;
revoke all on function private.finance_create_agent(uuid,uuid,text,text) from public,anon,authenticated;
create function public.add_team_account_agent(p_team uuid,p_account uuid,p_agent_id text,p_note text default null,p_timezone text default 'UTC') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
 perform private.finance_today(p_timezone);
 result:=private.finance_create_agent(p_team,p_account,p_agent_id,p_note);
 update public.team_agent_placements p set starts_on=(a.created_at at time zone p_timezone)::date from public.team_account_agents a where a.id=(result->>'id')::uuid and p.agent_row_id=a.id;
 return result;
end $$;

create or replace function public.set_team_agent_money(p_team uuid,p_agent uuid,p_balance integer,p_topup integer) returns jsonb language plpgsql security definer set search_path='' as $$ begin
 if not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023';
end $$;
create or replace function public.clear_team_agent_topups(p_team uuid) returns table(agent_row_id uuid,topup integer) language plpgsql security definer set search_path='' as $$ begin
 if not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023';
end $$;
create or replace function public.clear_team_agent_balances(p_team uuid) returns table(agent_row_id uuid,balance integer) language plpgsql security definer set search_path='' as $$ begin
 if not private.can(p_team,'edit',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023';
end $$;
create function private.finance_agent_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='UPDATE' then
  if new.balance is distinct from old.balance or new.topup is distinct from old.topup then raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023'; end if;
  return new;
 end if;
 if exists(select 1 from public.teams where id=old.team_id) and (
  exists(select 1 from public.team_agent_finance_events where agent_row_id=old.id) or exists(select 1 from public.team_agent_finance_legacy where agent_row_id=old.id)
 ) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503'; end if;
 return old;
end $$;
create trigger finance_agent_protection before update or delete on public.team_account_agents for each row execute function private.finance_agent_guard();
create function private.finance_account_guard() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if exists(select 1 from public.teams where id=old.team_id) and (
 exists(select 1 from public.team_agent_finance_events where account_id=old.id) or exists(select 1 from public.team_agent_finance_legacy where account_id=old.id)
 ) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503'; end if;
 return old;
end $$;
create trigger finance_account_protection before delete on public.team_accounts for each row execute function private.finance_account_guard();
revoke all on function private.finance_today(text), private.finance_agent_insert(), private.finance_agent_guard(), private.finance_account_guard() from public,anon,authenticated;
revoke all on function public.add_team_account_agent(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.add_team_account_agent(uuid,uuid,text,text,text) to authenticated;
alter publication supabase_realtime add table public.team_agent_finance_values,public.team_agent_placements;
commit;
