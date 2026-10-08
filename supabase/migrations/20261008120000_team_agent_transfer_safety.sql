-- Transfers keep immutable history, protect stale editors and retain task tags.
begin;
-- Same-day hops have no reporting interval, but remain in the transfer audit.
alter table public.team_agent_placements drop constraint team_agent_placements_check;
alter table public.team_agent_placements add constraint team_agent_placements_check check(ends_on is null or ends_on>=starts_on);
create function public.set_team_agent_finance_value(p_team uuid,p_agent uuid,p_date date,p_metric text,p_value text,p_expected_version text,p_timezone text,p_request_id uuid,p_expected_placement_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 payload jsonb:=jsonb_build_array('set',p_agent,p_date,p_metric,p_value,p_expected_version,p_timezone,p_expected_placement_id);
 replay jsonb; place public.team_agent_placements%rowtype; current_row public.team_agent_finance_values%rowtype;
 cents bigint; previous bigint; old_value bigint; result jsonb;
begin
 perform private.finance_access(p_team,'edit');
 replay:=private.finance_lock_request(p_team,p_request_id,payload); if replay is not null then return replay; end if;
 if p_date is null or p_date>private.finance_today(p_timezone) then raise exception 'FUTURE_FINANCE_DATE' using errcode='22023'; end if;
 if p_metric is null or p_metric not in ('balance','topup','spend') or p_expected_version is null or p_expected_version!~'^\d+$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if p_value is not null then
  if p_value!~'^\d{1,9}(\.\d{1,2})?$' then raise exception 'FINANCE_AMOUNT_INVALID' using errcode='22023'; end if;
  cents:=(p_value::numeric*100)::bigint;
 end if;
 perform 1 from public.team_account_agents where id=p_agent and team_id=p_team for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 select * into place from public.team_agent_placements where team_id=p_team and agent_row_id=p_agent and starts_on<=p_date and (ends_on is null or p_date<ends_on);
 if not found then raise exception 'DATE_BEFORE_AGENT' using errcode='22023'; end if;
 if place.id is distinct from p_expected_placement_id then raise exception 'PLACEMENT_CONFLICT' using errcode='40001';end if;
 select * into current_row from public.team_agent_finance_values where team_id=p_team and agent_row_id=p_agent and entry_date=p_date and metric=p_metric;
 previous:=coalesce(current_row.version,0);old_value:=current_row.amount_cents;
 if previous::text<>p_expected_version then raise exception 'FINANCE_CONFLICT' using errcode='40001',detail=coalesce(private.finance_field(current_row)::text,'{}'); end if;
 if cents is distinct from old_value then
  insert into public.team_agent_finance_values(team_id,agent_row_id,placement_id,account_id,entry_date,metric,amount_cents,version,updated_by)
  values(p_team,p_agent,place.id,place.account_id,p_date,p_metric,cents,previous+1,auth.uid())
  on conflict(team_id,agent_row_id,entry_date,metric) do update set amount_cents=excluded.amount_cents,version=excluded.version,updated_by=excluded.updated_by,updated_at=clock_timestamp()
  returning * into current_row;
  insert into public.team_agent_finance_events(team_id,agent_row_id,account_id,placement_id,entry_date,metric,old_cents,new_cents,previous_version,new_version,actor_id,request_id)
  values(p_team,p_agent,place.account_id,place.id,p_date,p_metric,old_value,cents,previous,previous+1,auth.uid(),p_request_id);
 end if;
 result:=jsonb_build_object('requestId',p_request_id,'fields',case when current_row.id is null then '[]'::jsonb else jsonb_build_array(private.finance_field(current_row)) end,'undoReference',case when cents is null and old_value is not null then p_request_id else null end);
 insert into public.team_agent_finance_requests(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,result);
 return result;
end $$;

-- Legacy eight-argument setter remains owner-only for batch/import RPCs.
-- Old clients must refresh instead of bypassing placement concurrency checks.
revoke execute on function public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid) from authenticated;
revoke all on function public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid,uuid) to authenticated;
create or replace function public.move_team_account_agent(p_team uuid,p_agent uuid,p_target_account uuid,p_effective_on date,p_expected_placement_id uuid,p_expected_placement_version text,p_timezone text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array('move',p_agent,p_target_account,p_effective_on,p_expected_placement_id,p_expected_placement_version,p_timezone);replay jsonb;place public.team_agent_placements%rowtype;next_place uuid;result jsonb;begin
 perform private.finance_access(p_team,'edit');replay:=private.finance_lock_request(p_team,p_request_id,payload);if replay is not null then return replay;end if;
 perform 1 from public.team_accounts where team_id=p_team and id in(p_target_account,(select account_id from public.team_account_agents where id=p_agent and team_id=p_team)) order by id for update;
 if not exists(select 1 from public.team_accounts where id=p_target_account and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_account_agents where id=p_agent and team_id=p_team for update;if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into place from public.team_agent_placements where agent_row_id=p_agent and team_id=p_team and ends_on is null;
 if place.id is distinct from p_expected_placement_id or place.version::text is distinct from p_expected_placement_version then raise exception 'PLACEMENT_CONFLICT' using errcode='40001';end if;
 if place.account_id=p_target_account or p_effective_on is null or p_effective_on<place.starts_on or p_effective_on>private.finance_today(p_timezone) or exists(select 1 from public.team_agent_finance_events where placement_id=place.id and entry_date>=p_effective_on) then raise exception 'TRANSFER_DATE_INVALID' using errcode='22023';end if;
 if exists(select 1 from public.team_account_agents a where a.account_id=p_target_account and a.agent_id=(select agent_id from public.team_account_agents where id=p_agent)) then raise exception 'AGENT_ID_CONFLICT' using errcode='23505';end if;
 update public.team_agent_placements set ends_on=p_effective_on,version=version+1 where id=place.id;
 insert into public.team_agent_placements(team_id,agent_row_id,account_id,starts_on) values(p_team,p_agent,p_target_account,p_effective_on) returning id into next_place;
 update public.team_account_agents set account_id=p_target_account where id=p_agent;
 insert into public.team_agent_transfer_events(team_id,agent_row_id,from_placement_id,to_placement_id,effective_on,actor_id,request_id) values(p_team,p_agent,place.id,next_place,p_effective_on,auth.uid(),p_request_id);
 result:=jsonb_build_object('agent',private.team_agent_json(p_agent),'placementId',next_place,'placementVersion','1');
 insert into public.team_agent_finance_requests(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,result);return result;
end $$;
revoke all on function public.move_team_account_agent(uuid,uuid,uuid,date,uuid,text,text,uuid) from public,anon;
grant execute on function public.move_team_account_agent(uuid,uuid,uuid,date,uuid,text,text,uuid) to authenticated;
create or replace function public.get_team_agent_finance(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 perform private.finance_access(p_team,'view');perform private.finance_today(p_timezone);
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>365 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select jsonb_build_object('schemaVersion',1,'teamId',t.id,'teamName',t.name,'from',p_from,'to',p_to,'currency','USD','generatedAt',now(),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name)) from public.team_accounts a where a.team_id=p_team),'[]'),
 'agents',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'agentId',a.agent_id)) from public.team_account_agents a where a.team_id=p_team),'[]'),
 'placements',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'agentRowId',p.agent_row_id,'accountId',p.account_id,'startsOn',p.starts_on,'endsOn',p.ends_on,'version',p.version::text)) from public.team_agent_placements p where p.team_id=p_team and p.starts_on<=p_to and (p.ends_on is null or p.ends_on>p.starts_on) and (p.ends_on is null or p.ends_on>p_from)),'[]'),
 'fields',coalesce((select jsonb_agg(private.finance_field(v)) from public.team_agent_finance_values v where v.team_id=p_team and v.entry_date between p_from and p_to),'[]')) into result from public.teams t where t.id=p_team;
 return result;
end $$;

-- Authoritative eligibility includes events outside the currently viewed period.
create function public.get_team_agent_transfer_eligibility(p_team uuid,p_agent uuid,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare place public.team_agent_placements%rowtype;latest date;begin
 perform private.finance_access(p_team,'edit');perform private.finance_today(p_timezone);
 select * into place from public.team_agent_placements where team_id=p_team and agent_row_id=p_agent and ends_on is null;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select max(entry_date) into latest from public.team_agent_finance_events where team_id=p_team and placement_id=place.id;
 return jsonb_build_object('accountId',place.account_id,'placementId',place.id,'placementVersion',place.version::text,'minDate',greatest(place.starts_on,latest+1),'blockers',coalesce((select jsonb_agg(jsonb_build_object('date',v.entry_date,'metric',v.metric,'value',case when v.amount_cents is null then null else to_char(v.amount_cents::numeric/100,'FM9999999990.00') end)) from public.team_agent_finance_values v where v.team_id=p_team and v.placement_id=place.id and v.entry_date=latest),'[]'));
end $$;
revoke all on function public.get_team_agent_transfer_eligibility(uuid,uuid,text) from public,anon;
grant execute on function public.get_team_agent_transfer_eligibility(uuid,uuid,text) to authenticated;

-- Reconstruct existing task associations from the actual transfer times,
-- rather than financial effective dates. Names still follow account renames.
alter table public.team_task_agents add column account_id uuid, add column account_name_snapshot text;
update public.team_task_agents l set account_id=coalesce(
 (select p.account_id from public.team_agent_transfer_events e join public.team_agent_placements p on p.id=e.to_placement_id where e.agent_row_id=l.agent_row_id and e.occurred_at<=l.attached_at order by e.occurred_at desc,e.id desc limit 1),
 (select p.account_id from public.team_agent_transfer_events e join public.team_agent_placements p on p.id=e.from_placement_id where e.agent_row_id=l.agent_row_id order by e.occurred_at,e.id limit 1),
 (select a.account_id from public.team_account_agents a where a.id=l.agent_row_id));
update public.team_task_agents l set account_name_snapshot=a.name from public.team_accounts a where a.id=l.account_id;
alter table public.team_task_agents alter column account_id set not null;
alter table public.team_task_agents alter column account_name_snapshot set not null;
-- Historical account identity is a tombstone, not a cascading foreign key:
-- deleting an empty former account must not remove the surviving agent's tasks.
-- The capture trigger validates the tenant and makes both snapshot fields immutable.
create function private.capture_task_agent_account() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if TG_OP='UPDATE' then
  if new.account_name_snapshot is distinct from old.account_name_snapshot or new.account_id is distinct from old.account_id or new.agent_row_id is distinct from old.agent_row_id or new.team_id is distinct from old.team_id then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 else
  select a.account_id into new.account_id from public.team_account_agents a where a.id=new.agent_row_id and a.team_id=new.team_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  select a.name into new.account_name_snapshot from public.team_accounts a where a.id=new.account_id and a.team_id=new.team_id;
 end if;
 return new;
end $$;
revoke all on function private.capture_task_agent_account() from public,anon,authenticated;
create trigger capture_task_agent_account before insert or update on public.team_task_agents for each row execute function private.capture_task_agent_account();
create or replace function private.team_task_agent_tags(p_task uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', link.id,
          'agent_row_id', agent.id,
          'account_id', link.account_id,
          'account_name', coalesce(account.name,link.account_name_snapshot),
          'agent_id', agent.agent_id,
          'runs', private.team_agent_runs_json(agent.id)
        )
        order by account.name, agent.created_at, agent.id
      )
      from public.team_task_agents as link
      join public.team_account_agents as agent on agent.id = link.agent_row_id
      left join public.team_accounts as account on account.id = link.account_id
      where link.task_id = p_task
    ),
    '[]'::jsonb
  );
$$;

create or replace function public.list_team_tasks(
  p_team uuid,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_cursor uuid default null,
  p_page_size integer default 50,
  p_status text default null,
  p_agent uuid default null,
  p_account uuid default null,
  p_day_from date default null,
  p_day_to date default null,
  p_labels uuid[] default null,
  p_sort text default 'date',
  p_assignee uuid default null,
  p_unassigned boolean default false
)
returns table (
  id uuid,
  team_id uuid,
  created_by uuid,
  title text,
  note text,
  assignee_id uuid,
  assignee_label_snapshot text,
  status text,
  progress_max integer,
  progress_value integer,
  progress_manually_set boolean,
  attachment_count bigint,
  agents jsonb,
  labels jsonb,
  task_date date,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sort text := coalesce(nullif(btrim(coalesce(p_sort, '')), ''), 'date');
  unassigned boolean := coalesce(p_unassigned, false);
  cursor_sort timestamptz;
  cursor_key text;
  cursor_untagged boolean;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if (p_created_from is null) <> (p_created_to is null)
     or (p_created_from is not null and p_created_from >= p_created_to)
     or (p_day_from is null) <> (p_day_to is null)
     or (p_day_from is not null and (p_created_from is null or p_day_from > p_day_to))
     or p_page_size not between 1 and 100
     or (p_status is not null and p_status not in ('todo', 'in_progress', 'done'))
     or sort not in ('date', 'label')
     or (p_labels is not null and coalesce(array_length(p_labels, 1), 0) not between 1 and 20)
     -- One person, or nobody: asking for both is asking for nothing.
     or (p_assignee is not null and unassigned) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_cursor is not null then
    select private.team_task_sort_at(task.task_date, task.created_at),
           private.team_task_label_key(task.id)
      into cursor_sort, cursor_key
    from public.team_tasks as task
    where task.id = p_cursor and task.team_id = p_team;
    if cursor_sort is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    cursor_untagged := cursor_key is null;
    cursor_key := coalesce(cursor_key, '');
  end if;
  return query
  select task.id, task.team_id, task.created_by, task.title, task.note,
         task.assignee_id, task.assignee_label_snapshot, task.status,
         task.progress_max, task.progress_value, task.progress_manually_set,
         count(attachment.id) as attachment_count,
         private.team_task_agent_tags(task.id) as agents,
         private.team_task_labels(task.id) as labels,
         task.task_date,
         task.created_at, task.updated_at, task.completed_at
  from public.team_tasks as task
  left join public.team_task_attachments as attachment on attachment.task_id = task.id
  where task.team_id = p_team
    and (p_status is null or task.status = p_status)
    and (p_assignee is null or task.assignee_id = p_assignee)
    and (not unassigned or task.assignee_id is null)
    and (
      p_created_from is null
      or case
           when p_day_from is not null and task.task_date is not null
             then task.task_date between p_day_from and p_day_to
           else task.created_at >= p_created_from and task.created_at < p_created_to
         end
    )
    and (p_cursor is null or case
      when sort = 'label' then
        (private.team_task_label_key(task.id) is null,
         coalesce(private.team_task_label_key(task.id), ''))
          > (cursor_untagged, cursor_key)
        or (
          (private.team_task_label_key(task.id) is null) = cursor_untagged
          and coalesce(private.team_task_label_key(task.id), '') = cursor_key
          and (private.team_task_sort_at(task.task_date, task.created_at), task.id)
              < (cursor_sort, p_cursor)
        )
      else
        (private.team_task_sort_at(task.task_date, task.created_at), task.id)
          < (cursor_sort, p_cursor)
    end)
    and (p_labels is null or exists (
      select 1 from public.team_task_label_links as link
      where link.task_id = task.id and link.label_id = any(p_labels)
    ))
    and (p_agent is null or exists (
      select 1 from public.team_task_agents as link
      where link.task_id = task.id and link.agent_row_id = p_agent
    ))
    and (p_account is null or exists (
      select 1 from public.team_task_agents as link
      join public.team_account_agents as agent on agent.id = link.agent_row_id
      where link.task_id = task.id and link.account_id = p_account
    ))
  group by task.id
  order by
    case when sort = 'label' then (private.team_task_label_key(task.id) is null) end asc,
    case when sort = 'label' then private.team_task_label_key(task.id) end asc,
    private.team_task_sort_at(task.task_date, task.created_at) desc,
    task.id desc
  limit p_page_size;
end;
$$;
-- Account counts follow historical task membership; agent counts retain all history.
create or replace function private.team_agent_json(p_agent uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', agent.id,
    'account_id', agent.account_id,
    'team_id', agent.team_id,
    'agent_id', agent.agent_id,
    'runs', private.team_agent_runs_json(agent.id),
    'labels', private.team_agent_labels(agent.id),
    'balance', agent.balance,
    'topup', agent.topup,
    'task_count', (
      select count(*)
      from public.team_task_agents as link
      join public.team_tasks as task on task.id = link.task_id and task.team_id = link.team_id
      where link.agent_row_id = agent.id and task.status <> 'done'
    ),
    'account_task_count', (
      select count(*) from public.team_task_agents link
      join public.team_tasks task on task.id=link.task_id and task.team_id=link.team_id
      where link.agent_row_id=agent.id and link.account_id=agent.account_id and task.status<>'done'
    ),
    'created_at', agent.created_at,
    'updated_at', agent.updated_at
  )
  from public.team_account_agents as agent
  where agent.id = p_agent;
$$;

drop function public.list_team_accounts(uuid);
create or replace function public.list_team_accounts(p_team uuid)
returns table (
  id uuid,
  team_id uuid,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  agents jsonb,
  task_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select account.id, account.team_id, account.name, account.created_at, account.updated_at,
         coalesce(
           (
             select jsonb_agg(private.team_agent_json(agent.id) order by agent.created_at, agent.id)
             from public.team_account_agents as agent
             where agent.account_id = account.id
           ),
           '[]'::jsonb
         ) as agents,
         (select count(distinct link.task_id) from public.team_task_agents link
          join public.team_tasks task on task.id=link.task_id and task.team_id=link.team_id
          where link.account_id=account.id and link.team_id=p_team and task.status<>'done') as task_count
  from public.team_accounts as account
  where account.team_id = p_team
  order by account.name, account.id;
end;
$$;
revoke all on function public.list_team_accounts(uuid) from public,anon;
grant execute on function public.list_team_accounts(uuid) to authenticated;
commit;
