-- Effective calendar existence is independent of the physical creation audit.
-- Existing NULL means legacy/unknown: retain all placements and money history.
begin;
alter table public.team_accounts add column starts_on date;
alter table public.team_account_agents add column starts_on date;

create function private.account_birth_date(p_date date,p_timezone text) returns date
language plpgsql stable set search_path='' as $$ declare today date;begin
 today:=private.finance_today(p_timezone);
 if p_date is not null and p_date<date '0001-01-01' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_date>today then raise exception 'FUTURE_FINANCE_DATE' using errcode='22023';end if;
 return coalesce(p_date,today);
end $$;

-- Reused by direct dated fixtures; NULL remains the old unbounded placement.
create or replace function private.finance_agent_insert() returns trigger
language plpgsql security definer set search_path='' as $$begin
 insert into public.team_agent_placements(team_id,agent_row_id,account_id,starts_on)
 values(new.team_id,new.id,new.account_id,coalesce(new.starts_on,date '0001-01-01'));
 return new;
end $$;

-- A dated child's container must exist at least as early as that child. Unknown
-- legacy parents stay unknown, and no creation or archive audit is rewritten.
create function private.account_extend_parent_birth() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_op='UPDATE' then if new.starts_on is not distinct from old.starts_on then return null;end if;end if;
 if new.starts_on is not null then
  update public.team_accounts set starts_on=new.starts_on
  where id=new.account_id and team_id=new.team_id and starts_on>new.starts_on;
 end if;return null;
end $$;
create trigger account_extend_parent_birth after insert or update of starts_on on public.team_account_agents
for each row execute function private.account_extend_parent_birth();

create function private.account_apply_agent_birth(p_team uuid,p_agent uuid,p_date date,p_timezone text) returns void
language plpgsql security definer set search_path='' as $$begin
 update public.team_account_agents set starts_on=p_date
 where team_id=p_team and id=p_agent and starts_on is null;
 if not found then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- Only the just-created RK reaches this private helper. All of these writes
 -- share its creation transaction; no intermediate unbounded placement escapes.
 update public.team_agent_placements set starts_on=p_date
 where team_id=p_team and agent_row_id=p_agent and ends_on is null;
 update public.team_account_parent_history set starts_at=p_date::timestamp at time zone p_timezone
 where team_id=p_team and agent_row_id=p_agent and ends_at is null;
end $$;

-- Move the old arities privately, avoiding ambiguous PostgREST overloads while
-- calls omitting the new optional arguments keep working with today's date.
alter function public.create_team_account(uuid,text) set schema private;
alter function private.create_team_account(uuid,text) rename to create_team_account_birth_base_038;
revoke all on function private.create_team_account_birth_base_038(uuid,text) from public,anon,authenticated,service_role;
create function public.create_team_account(p_team uuid,p_name text,p_starts_on date default null,p_timezone text default 'UTC')
returns public.team_accounts language plpgsql security definer set search_path='' as $$
declare created public.team_accounts%rowtype;birth date;begin
 perform private.finance_access(p_team,'edit');perform private.account_workspace_lock(p_team,auth.uid());
 birth:=private.account_birth_date(p_starts_on,p_timezone);
 created:=private.create_team_account_birth_base_038(p_team,p_name);
 update public.team_accounts set starts_on=birth where id=created.id and team_id=p_team returning * into created;
 return created;
end $$;

alter function public.add_team_account_agent(uuid,uuid,text,text,text) set schema private;
alter function private.add_team_account_agent(uuid,uuid,text,text,text) rename to add_team_account_agent_birth_base_038;
revoke all on function private.add_team_account_agent_birth_base_038(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
create function public.add_team_account_agent(p_team uuid,p_account uuid,p_agent_id text,p_note text default null,p_timezone text default 'UTC',p_starts_on date default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare created jsonb;birth date;begin
 perform private.finance_access(p_team,'edit');perform private.account_workspace_lock(p_team,auth.uid());
 birth:=private.account_birth_date(p_starts_on,p_timezone);
 created:=private.add_team_account_agent_birth_base_038(p_team,p_account,p_agent_id,p_note,p_timezone);
 perform private.account_apply_agent_birth(p_team,(created->>'id')::uuid,birth,p_timezone);
 return private.team_agent_json((created->>'id')::uuid);
end $$;

-- Extend the original helper OID so every retained write preserves birth data.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('private.team_agent_json(uuid)'::regprocedure);
 definition:=replace(definition,'FUNCTION private.team_agent_json(','FUNCTION private.team_agent_json_pre_birth_038(');execute definition;
end $$;
create or replace function private.team_agent_json(p_agent uuid) returns jsonb language sql stable set search_path='' as $$
 select private.team_agent_json_pre_birth_038(a.id)||case when a.starts_on is null then '{}'::jsonb else jsonb_build_object('starts_on',a.starts_on) end
 from public.team_account_agents a where a.id=p_agent;
$$;

-- Preserve all retained overview/launch fields and add only known calendar birth.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.get_team_accounts_overview(uuid,date,date,text)'::regprocedure);
 definition:=replace(definition,'FUNCTION public.get_team_accounts_overview(','FUNCTION private.account_overview_pre_birth_038(');execute definition;
end $$;
create or replace function public.get_team_accounts_overview(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare result jsonb;accounts jsonb;begin
 result:=private.account_overview_pre_birth_038(p_team,p_from,p_to,p_timezone);
 select coalesce(jsonb_agg(j.value||case when a.starts_on is null then '{}'::jsonb else jsonb_build_object('starts_on',a.starts_on) end||jsonb_build_object('agents',coalesce((
  select jsonb_agg(child.value order by child.ordinal)
  from jsonb_array_elements(j.value->'agents') with ordinality child(value,ordinal)
  join public.team_account_agents r on r.id=(child.value->>'id')::uuid and r.team_id=p_team
  where r.starts_on is null or r.starts_on<=p_to
 ),'[]'::jsonb)) order by j.ordinal),'[]') into accounts
 from jsonb_array_elements(result->'accounts') with ordinality j(value,ordinal)
 join public.team_accounts a on a.id=(j.value->>'id')::uuid and a.team_id=p_team
 where a.starts_on is null or a.starts_on<=p_to;
 return jsonb_set(result,'{accounts}',accounts);
end $$;

do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.get_team_agent_finance_v2(uuid,date,date,text)'::regprocedure);
 definition:=replace(definition,'FUNCTION public.get_team_agent_finance_v2(','FUNCTION private.account_finance_snapshot_pre_birth_038(');execute definition;
end $$;
create or replace function public.get_team_agent_finance_v2(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb
language plpgsql stable security definer set search_path='' as $$ declare result jsonb;accounts jsonb;agents jsonb;begin
 result:=private.account_finance_snapshot_pre_birth_038(p_team,p_from,p_to,p_timezone);
 select coalesce(jsonb_agg(j.value||case when a.starts_on is null then '{}'::jsonb else jsonb_build_object('startsOn',a.starts_on) end order by j.ordinal),'[]') into accounts
 from jsonb_array_elements(result#>'{lifecycle,accounts}') with ordinality j(value,ordinal)
 join public.team_accounts a on a.id=(j.value->>'id')::uuid and a.team_id=p_team;
 select coalesce(jsonb_agg(j.value||case when a.starts_on is null then '{}'::jsonb else jsonb_build_object('startsOn',a.starts_on) end order by j.ordinal),'[]') into agents
 from jsonb_array_elements(result#>'{lifecycle,agents}') with ordinality j(value,ordinal)
 join public.team_account_agents a on a.id=(j.value->>'id')::uuid and a.team_id=p_team;
 return jsonb_set(jsonb_set(result,'{lifecycle,accounts}',accounts),'{lifecycle,agents}',agents);
end $$;

-- Retain canonical transfer replay and all-history finance rehome. A requested
-- transfer cannot predate a known destination's existence, and moving an old RK
-- never changes the destination's independently audited effective birth.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('public.move_team_account_agent(uuid,uuid,uuid,date,uuid,text,text,uuid)'::regprocedure);
 definition:=replace(definition,'if replay is not null then return replay; end if;',
 'if replay is not null then return replay; end if;
  if exists(select 1 from public.team_accounts where team_id=p_team and id=p_target_account and starts_on>p_effective_on) then raise exception ''TRANSFER_DATE_INVALID'' using errcode=''22023'';end if;');
 execute definition;
end $$;

-- Request acceptance must guard even an empty/no-op write. Successful receipts
-- still replay before birth/active checks, and every writer retains CAS/replay.
create or replace function private.account_finance_accept(p_team uuid,p_request uuid,p_args jsonb,p_intent text) returns void
language plpgsql security definer set search_path='' as $$ declare ids uuid[];begin
 perform pg_advisory_xact_lock(hashtextextended(p_team::text||auth.uid()::text||p_request::text,0));
 if exists(select 1 from public.team_agent_finance_requests where team_id=p_team and actor_id=auth.uid() and request_id=p_request) then return;end if;
 if p_args ? 'p_agent' then ids:=array[(p_args->>'p_agent')::uuid];
 elsif p_args ? 'p_fields' then select array_agg((x->>'agent')::uuid) into ids from jsonb_array_elements(p_args->'p_fields') x;
 elsif p_args ? 'p_legacy' then select array_agg(agent_row_id) into ids from public.team_agent_finance_legacy where team_id=p_team and id=(p_args->>'p_legacy')::uuid;
 elsif p_args ? 'p_original_request_id' then select array_agg(distinct agent_row_id) into ids from public.team_agent_finance_events where team_id=p_team and actor_id=auth.uid() and request_id=(p_args->>'p_original_request_id')::uuid;end if;
 perform 1 from public.team_accounts where team_id=p_team and id in(select account_id from public.team_account_agents where id=any(ids) and team_id=p_team) order by id for update;
 perform 1 from public.team_account_agents where team_id=p_team and id=any(ids) order by id for update;
 if p_args ? 'p_date' and exists(select 1 from public.team_account_agents where team_id=p_team and id=any(ids) and starts_on>(p_args->>'p_date')::date) then raise exception 'DATE_BEFORE_AGENT' using errcode='22023';end if;
 if p_intent='normal' and exists(select 1 from unnest(ids) id where not private.team_account_effectively_active(p_team,id)) then raise exception 'HISTORICAL_CORRECTION_REQUIRED' using errcode='22023';end if;
end $$;
create function private.account_finance_birth_guard() returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.team_account_agents where id=new.agent_row_id and team_id=new.team_id and starts_on>new.entry_date) then raise exception 'DATE_BEFORE_AGENT' using errcode='22023';end if;
 return new;
end $$;
create trigger account_finance_birth_guard before insert or update on public.team_agent_finance_values for each row execute function private.account_finance_birth_guard();

-- Keep new helpers private; public optional signatures retain the original roles.
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in('account_birth_date','account_apply_agent_birth','account_extend_parent_birth','team_agent_json_pre_birth_038','account_overview_pre_birth_038','account_finance_snapshot_pre_birth_038','account_finance_birth_guard') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);end loop;
end $$;
revoke all on function public.create_team_account(uuid,text,date,text),public.add_team_account_agent(uuid,uuid,text,text,text,date) from public,anon;
grant execute on function public.create_team_account(uuid,text,date,text),public.add_team_account_agent(uuid,uuid,text,text,text,date) to authenticated;
notify pgrst,'reload schema';
commit;
