-- An ad account's money follows it to the social account it moves to.
--
-- Until now a transfer split the agent's history at an effective date: sums
-- before it stayed under the former social account, and a day that already had
-- entries blocked the transfer. Owners asked for the opposite: an agent may be
-- moved at any time, and every sum it ever had — balances, top-ups, spend, the
-- frozen legacy amounts — is taken off the former social account and counted
-- under the new one. The amounts themselves are tied to the agent and never
-- change.
--
-- The signature of move_team_account_agent stays, so a web build that still
-- sends a date keeps working; the date is ignored. A move opens one new
-- placement that starts where the agent's earliest began and names the new
-- account; the older placements stay only for the transfer audit, shrunk to
-- zero length the way same-day hops already are, so period reports show one
-- row per agent and every date resolves to the new one. A new placement id
-- also keeps a draft made before the move answering PLACEMENT_CONFLICT.
--
-- Rewriting placement accounts would erase where a transfer came from, so the
-- transfer audit records both accounts by id and name at the moment it happens.

begin;

alter table public.team_agent_transfer_events
  add column from_account_id uuid,
  add column to_account_id uuid,
  add column from_account_name text,
  add column to_account_name text;

update public.team_agent_transfer_events e
set from_account_id = f.account_id,
    to_account_id = t.account_id,
    from_account_name = fa.name,
    to_account_name = ta.name
from public.team_agent_placements f, public.team_agent_placements t,
     public.team_accounts fa, public.team_accounts ta
where f.id = e.from_placement_id and t.id = e.to_placement_id
  and fa.id = f.account_id and ta.id = t.account_id;

grant select(from_account_id, to_account_id, from_account_name, to_account_name)
  on public.team_agent_transfer_events to authenticated;

-- The audit outlives the former account: its placements go with the account
-- (they cascade), so a transfer keeps its own names and only loses the link.
alter table public.team_agent_transfer_events
  alter column from_placement_id drop not null,
  alter column to_placement_id drop not null,
  drop constraint team_agent_transfer_events_from_placement_id_team_id_fkey,
  drop constraint team_agent_transfer_events_to_placement_id_team_id_fkey,
  add constraint team_agent_transfer_events_from_placement_id_team_id_fkey
    foreign key (from_placement_id, team_id) references public.team_agent_placements(id, team_id)
    on delete set null (from_placement_id) deferrable initially deferred,
  add constraint team_agent_transfer_events_to_placement_id_team_id_fkey
    foreign key (to_placement_id, team_id) references public.team_agent_placements(id, team_id)
    on delete set null (to_placement_id) deferrable initially deferred;

-- A former social account holds nothing once its agents moved on: their sums
-- left with them, and what stays behind is a zero-length placement kept for the
-- audit. Only money the account still carries, or a placement that still
-- counts, protects it — and deleting it no longer erases the transfers.
create or replace function private.finance_account_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.teams where id=old.team_id) and (
  exists(select 1 from public.team_agent_finance_events where account_id=old.id)
  or exists(select 1 from public.team_agent_finance_values where account_id=old.id)
  or exists(select 1 from public.team_agent_finance_legacy where account_id=old.id)
  or exists(
   select 1 from public.team_agent_placements p
   where p.account_id=old.id and (p.ends_on is null or p.ends_on>p.starts_on) and (
    exists(select 1 from public.team_agent_finance_events e where e.agent_row_id=p.agent_row_id)
    or exists(select 1 from public.team_agent_finance_legacy l where l.agent_row_id=p.agent_row_id)
   )
  )
 ) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503'; end if;
 return old;
end $$;
revoke all on function private.finance_account_guard() from public, anon, authenticated;

create or replace function public.move_team_account_agent(
  p_team uuid, p_agent uuid, p_target_account uuid, p_effective_on date,
  p_expected_placement_id uuid, p_expected_placement_version text,
  p_timezone text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payload jsonb := jsonb_build_array('move', p_agent, p_target_account, p_effective_on,
    p_expected_placement_id, p_expected_placement_version, p_timezone);
  replay jsonb;
  place public.team_agent_placements%rowtype;
  next_place uuid;
  earliest date;
  source public.team_accounts%rowtype;
  target public.team_accounts%rowtype;
  result jsonb;
begin
  perform private.finance_access(p_team, 'edit');
  replay := private.finance_lock_request(p_team, p_request_id, payload);
  if replay is not null then return replay; end if;
  perform private.finance_today(p_timezone);

  perform 1 from public.team_accounts
  where team_id = p_team
    and id in (p_target_account,
      (select account_id from public.team_account_agents where id = p_agent and team_id = p_team))
  order by id for update;
  select * into target from public.team_accounts where id = p_target_account and team_id = p_team;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform 1 from public.team_account_agents where id = p_agent and team_id = p_team for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select * into place from public.team_agent_placements
  where agent_row_id = p_agent and team_id = p_team and ends_on is null;
  if place.id is distinct from p_expected_placement_id
    or place.version::text is distinct from p_expected_placement_version then
    raise exception 'PLACEMENT_CONFLICT' using errcode = '40001';
  end if;
  if place.account_id = p_target_account then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.team_account_agents a
    where a.account_id = p_target_account
      and a.agent_id = (select agent_id from public.team_account_agents where id = p_agent)
  ) then
    raise exception 'AGENT_ID_CONFLICT' using errcode = '23505';
  end if;
  select * into source from public.team_accounts where id = place.account_id;

  -- Every sum the agent ever had moves with it. The composite foreign keys from
  -- values and events to placements are deferred, so the order is free here.
  select min(starts_on) into earliest from public.team_agent_placements
  where agent_row_id = p_agent and team_id = p_team;
  update public.team_agent_placements
  set ends_on = starts_on, version = version + 1
  where agent_row_id = p_agent and team_id = p_team;
  insert into public.team_agent_placements(team_id, agent_row_id, account_id, starts_on)
  values (p_team, p_agent, p_target_account, earliest)
  returning id into next_place;
  update public.team_agent_finance_values
  set account_id = p_target_account, placement_id = next_place
  where agent_row_id = p_agent and team_id = p_team;
  update public.team_agent_finance_events
  set account_id = p_target_account, placement_id = next_place
  where agent_row_id = p_agent and team_id = p_team;
  update public.team_agent_finance_legacy
  set account_id = p_target_account
  where agent_row_id = p_agent and team_id = p_team;
  update public.team_account_agents set account_id = p_target_account where id = p_agent;

  insert into public.team_agent_transfer_events(
    team_id, agent_row_id, from_placement_id, to_placement_id, effective_on, actor_id, request_id,
    from_account_id, to_account_id, from_account_name, to_account_name)
  values (
    p_team, p_agent, place.id, next_place, private.finance_today(p_timezone), auth.uid(), p_request_id,
    source.id, target.id, source.name, target.name);

  result := jsonb_build_object('agent', private.team_agent_json(p_agent),
    'placementId', next_place, 'placementVersion', '1');
  insert into public.team_agent_finance_requests(team_id, actor_id, request_id, payload, result)
  values (p_team, auth.uid(), p_request_id, payload, result);
  return result;
end $$;
revoke all on function public.move_team_account_agent(uuid,uuid,uuid,date,uuid,text,text,uuid) from public, anon;
grant execute on function public.move_team_account_agent(uuid,uuid,uuid,date,uuid,text,text,uuid) to authenticated;

-- Nothing blocks a transfer any more: the earliest date is always today and
-- there are no blocking entries. The shape stays for clients that read it.
create or replace function public.get_team_agent_transfer_eligibility(p_team uuid, p_agent uuid, p_timezone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare place public.team_agent_placements%rowtype;
begin
  perform private.finance_access(p_team, 'edit');
  select * into place from public.team_agent_placements
  where team_id = p_team and agent_row_id = p_agent and ends_on is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('accountId', place.account_id, 'placementId', place.id,
    'placementVersion', place.version::text, 'minDate', private.finance_today(p_timezone),
    'blockers', '[]'::jsonb);
end $$;
revoke all on function public.get_team_agent_transfer_eligibility(uuid,uuid,text) from public, anon;
grant execute on function public.get_team_agent_transfer_eligibility(uuid,uuid,text) to authenticated;

-- The history names a transfer's accounts from its own record: placements no
-- longer remember the former account, and a former account may be deleted.
create or replace function public.list_team_agent_finance_history(p_team uuid,p_agent uuid,p_cursor jsonb default null,p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare page jsonb;begin
  perform private.finance_access(p_team,'view');
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  with entries as (
    select e.occurred_at,e.id,'finance'::text as kind,
      (to_jsonb(e)-'old_cents'-'new_cents'-'previous_version'-'new_version')||jsonb_build_object(
        'oldValue',case when e.old_cents is null then null else to_char(e.old_cents::numeric/100,'FM9999999990.00') end,
        'newValue',case when e.new_cents is null then null else to_char(e.new_cents::numeric/100,'FM9999999990.00') end,
        'previous_version',e.previous_version::text,'new_version',e.new_version::text,
        'account_name',a.name,'actor_name',p.display_name) as value
    from public.team_agent_finance_events e join public.team_accounts a on a.id=e.account_id
      left join public.profiles p on p.id=e.actor_id
    where e.team_id=p_team and e.agent_row_id=p_agent
    union all
    select e.occurred_at,e.id,'transfer'::text,
      to_jsonb(e)||jsonb_build_object(
        'from_account',coalesce(a.name,e.from_account_name),
        'to_account',coalesce(b.name,e.to_account_name),
        'actor_name',p.display_name)
    from public.team_agent_transfer_events e
      left join public.team_accounts a on a.id=e.from_account_id
      left join public.team_accounts b on b.id=e.to_account_id
      left join public.profiles p on p.id=e.actor_id
    where e.team_id=p_team and e.agent_row_id=p_agent
  ), limited as (
    select * from entries where p_cursor is null or (occurred_at,id)<((p_cursor->>'time')::timestamptz,(p_cursor->>'id')::uuid)
    order by occurred_at desc,id desc limit p_limit
  ) select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'value',value,'time',occurred_at,'id',id) order by occurred_at desc,id desc),'[]') into page from limited;
  return jsonb_build_object(
    'events',coalesce((select jsonb_agg(v->'value' order by ord) from jsonb_array_elements(page) with ordinality x(v,ord) where v->>'kind'='finance'),'[]'),
    'transfers',coalesce((select jsonb_agg(v->'value' order by ord) from jsonb_array_elements(page) with ordinality x(v,ord) where v->>'kind'='transfer'),'[]'),
    'nextCursor',case when jsonb_array_length(page)=p_limit then jsonb_build_object('time',page->-1->>'time','id',page->-1->>'id') else null end);
end $$;

commit;
