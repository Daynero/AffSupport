create function private.finance_field(p_row public.team_agent_finance_values) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('agentRowId',p_row.agent_row_id,'date',p_row.entry_date,'metric',p_row.metric,
 'value',case when p_row.amount_cents is null then null else to_char(p_row.amount_cents::numeric/100,'FM9999999990.00') end,
 'currency',p_row.currency,'version',p_row.version::text,'placementId',p_row.placement_id,'updatedAt',p_row.updated_at,'updatedBy',p_row.updated_by);
$$;
create function private.finance_access(p_team uuid,p_permission text) returns void language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null or not private.can(p_team,p_permission,auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
end $$;
create function private.finance_lock_request(p_team uuid,p_request uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.team_agent_finance_requests%rowtype; begin
 if p_request is null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 -- Locks a request across agents too: a reused UUID cannot race two independent agent locks.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text||auth.uid()::text||p_request::text,0));
 select * into r from public.team_agent_finance_requests where team_id=p_team and actor_id=auth.uid() and request_id=p_request;
 if found then
  if r.payload<>p_payload then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='22023'; end if;
  return r.result;
 end if;
 return null;
end $$;
create function public.set_team_agent_finance_value(p_team uuid,p_agent uuid,p_date date,p_metric text,p_value text,p_expected_version text,p_timezone text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 payload jsonb:=jsonb_build_array('set',p_agent,p_date,p_metric,p_value,p_expected_version,p_timezone);
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
create function public.undo_team_agent_finance_clear(p_team uuid,p_original_request_id uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array('undo',p_original_request_id);replay jsonb;r public.team_agent_finance_requests%rowtype;
 e public.team_agent_finance_events%rowtype;v public.team_agent_finance_values%rowtype;fields jsonb:='[]';result jsonb;
begin
 perform private.finance_access(p_team,'edit');replay:=private.finance_lock_request(p_team,p_request_id,payload);if replay is not null then return replay;end if;
 select * into r from public.team_agent_finance_requests where team_id=p_team and actor_id=auth.uid() and request_id=p_original_request_id for update;
 if not found or r.result->>'undoReference' is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if r.undone_by_request_id is not null then raise exception 'FINANCE_UNDO_ALREADY_APPLIED' using errcode='22023';end if;
 perform 1 from public.team_account_agents where team_id=p_team and id in(select agent_row_id from public.team_agent_finance_events where team_id=p_team and request_id=p_original_request_id and actor_id=auth.uid()) order by id for update;
 for e in select * from public.team_agent_finance_events where team_id=p_team and request_id=p_original_request_id and actor_id=auth.uid() and new_cents is null and old_cents is not null order by agent_row_id loop
  select * into v from public.team_agent_finance_values where team_id=p_team and agent_row_id=e.agent_row_id and entry_date=e.entry_date and metric=e.metric;
  if v.version<>e.new_version or v.amount_cents is not null then raise exception 'FINANCE_CONFLICT' using errcode='40001';end if;
  update public.team_agent_finance_values set amount_cents=e.old_cents,version=version+1,updated_at=clock_timestamp(),updated_by=auth.uid() where id=v.id returning * into v;
  insert into public.team_agent_finance_events(team_id,agent_row_id,account_id,placement_id,entry_date,metric,old_cents,new_cents,previous_version,new_version,actor_id,request_id)
  values(p_team,e.agent_row_id,e.account_id,e.placement_id,e.entry_date,e.metric,null,e.old_cents,e.new_version,v.version,auth.uid(),p_request_id);
  fields:=fields||jsonb_build_array(private.finance_field(v));
 end loop;
 result:=jsonb_build_object('requestId',p_request_id,'fields',fields,'undoReference',null);
 update public.team_agent_finance_requests set undone_by_request_id=p_request_id where team_id=p_team and actor_id=auth.uid() and request_id=p_original_request_id;
 insert into public.team_agent_finance_requests(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,result);
 return result;
end $$;
create function public.get_team_agent_finance(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 perform private.finance_access(p_team,'view');perform private.finance_today(p_timezone);
 if p_from is null or p_to is null or p_from>p_to or not(p_from=p_to or (p_from=date_trunc('month',p_from)::date and p_to=(p_from+interval '1 month'-interval '1 day')::date)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select jsonb_build_object('schemaVersion',1,'teamId',t.id,'teamName',t.name,'from',p_from,'to',p_to,'currency','USD','generatedAt',now(),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name)) from public.team_accounts a where a.team_id=p_team),'[]'),
 'agents',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'agentId',a.agent_id)) from public.team_account_agents a where a.team_id=p_team),'[]'),
 'placements',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'agentRowId',p.agent_row_id,'accountId',p.account_id,'startsOn',p.starts_on,'endsOn',p.ends_on,'version',p.version::text)) from public.team_agent_placements p where p.team_id=p_team and p.starts_on<=p_to and (p.ends_on is null or p.ends_on>p_from)),'[]'),
 'fields',coalesce((select jsonb_agg(private.finance_field(v)) from public.team_agent_finance_values v where v.team_id=p_team and v.entry_date between p_from and p_to),'[]')) into result from public.teams t where t.id=p_team;
 return result;
end $$;
create function public.list_team_agent_finance_history(p_team uuid,p_agent uuid,p_cursor jsonb default null,p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare events jsonb;begin
 perform private.finance_access(p_team,'view');
 if p_limit<1 or p_limit>100 or p_limit is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(to_jsonb(q) order by q.occurred_at desc,q.id desc),'[]') into events from (
 select * from public.team_agent_finance_events where team_id=p_team and agent_row_id=p_agent and (p_cursor is null or (occurred_at,id)<((p_cursor->>'time')::timestamptz,(p_cursor->>'id')::uuid)) order by occurred_at desc,id desc limit p_limit) q;
 return jsonb_build_object('events',events,'transfers',coalesce((select jsonb_agg(to_jsonb(e)) from public.team_agent_transfer_events e where e.team_id=p_team and e.agent_row_id=p_agent),'[]'),
 'nextCursor',case when jsonb_array_length(events)=p_limit then jsonb_build_object('time',events->-1->>'occurred_at','id',events->-1->>'id') else null end);
end $$;
revoke all on function private.finance_field(public.team_agent_finance_values),private.finance_access(uuid,text),private.finance_lock_request(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid),public.undo_team_agent_finance_clear(uuid,uuid,uuid),public.get_team_agent_finance(uuid,date,date,text),public.list_team_agent_finance_history(uuid,uuid,jsonb,integer) from public,anon;
grant execute on function public.set_team_agent_finance_value(uuid,uuid,date,text,text,text,text,uuid),public.undo_team_agent_finance_clear(uuid,uuid,uuid),public.get_team_agent_finance(uuid,date,date,text),public.list_team_agent_finance_history(uuid,uuid,jsonb,integer) to authenticated;
