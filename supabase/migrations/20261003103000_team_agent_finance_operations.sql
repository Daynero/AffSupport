create function public.clear_team_agent_finance_values(p_team uuid,p_date date,p_metric text,p_fields jsonb,p_timezone text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array('clear',p_date,p_metric,p_fields,p_timezone);replay jsonb;item jsonb;part jsonb;fields jsonb:='[]';result jsonb;changed boolean:=false;begin
 perform private.finance_access(p_team,'edit');replay:=private.finance_lock_request(p_team,p_request_id,payload);if replay is not null then return replay;end if;
 if p_metric is null or p_metric not in('balance','topup') or jsonb_typeof(p_fields)<>'array' or jsonb_array_length(p_fields)>500 or jsonb_array_length(p_fields)<1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if (select count(distinct v->>'agent') from jsonb_array_elements(p_fields) v)<>jsonb_array_length(p_fields) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_account_agents where team_id=p_team and id in(select (v->>'agent')::uuid from jsonb_array_elements(p_fields) v) order by id for update;
 for item in select v from jsonb_array_elements(p_fields) v order by v->>'agent' loop
  -- Child requests are deterministic and committed with the batch; no partial results escape.
  part:=public.set_team_agent_finance_value(p_team,(item->>'agent')::uuid,p_date,p_metric,null,item->>'expectedVersion',p_timezone,md5(p_request_id::text||(item->>'agent'))::uuid);
  fields:=fields||(part->'fields');changed:=changed or part->>'undoReference' is not null;
  update public.team_agent_finance_events set request_id=p_request_id where team_id=p_team and actor_id=auth.uid() and request_id=md5(p_request_id::text||(item->>'agent'))::uuid;
  update public.team_agent_finance_requests r set result=jsonb_set(r.result,'{undoReference}','null'::jsonb) where r.team_id=p_team and r.actor_id=auth.uid() and r.request_id=md5(p_request_id::text||(item->>'agent'))::uuid;
 end loop;
 result:=jsonb_build_object('requestId',p_request_id,'fields',fields,'undoReference',case when changed then p_request_id else null end);
 insert into public.team_agent_finance_requests(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,result);return result;
end $$;
create function public.list_team_agent_finance_legacy(p_team uuid,p_agent uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.finance_access(p_team,'view');return coalesce((select jsonb_agg(to_jsonb(l)) from public.team_agent_finance_legacy l where l.team_id=p_team and (p_agent is null or l.agent_row_id=p_agent)),'[]');
end $$;
create function public.import_team_agent_finance_legacy(p_team uuid,p_legacy uuid,p_metric text,p_date date,p_value text,p_currency text,p_timezone text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array('legacy',p_legacy,p_metric,p_date,p_value,p_currency,p_timezone);replay jsonb;l public.team_agent_finance_legacy%rowtype;r jsonb;child uuid;event_id uuid;begin
 perform private.finance_access(p_team,'edit');replay:=private.finance_lock_request(p_team,p_request_id,payload);if replay is not null then return replay;end if;
 select * into l from public.team_agent_finance_legacy where id=p_legacy and team_id=p_team;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_account_agents where id=l.agent_row_id for update;
 select * into l from public.team_agent_finance_legacy where id=p_legacy for update;
 if p_currency is distinct from 'USD' or p_value is null or p_metric is null or p_metric not in('balance','topup') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if (p_metric='balance' and (l.balance_units is null or l.balance_imported_event_id is not null)) or(p_metric='topup' and(l.requested_topup_units is null or l.topup_imported_event_id is not null)) then raise exception 'LEGACY_ALREADY_IMPORTED' using errcode='22023';end if;
 if exists(select 1 from public.team_agent_finance_values where team_id=p_team and agent_row_id=l.agent_row_id and entry_date=p_date and metric=p_metric) then raise exception 'LEGACY_TARGET_OCCUPIED' using errcode='22023';end if;
 child:=md5(p_request_id::text||'legacy')::uuid;r:=public.set_team_agent_finance_value(p_team,l.agent_row_id,p_date,p_metric,p_value,'0',p_timezone,child);
 select id into event_id from public.team_agent_finance_events where team_id=p_team and request_id=child;
 if event_id is null then
  -- Importing a factual zero must create its record, not a missing value.
  raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if p_metric='balance' then update public.team_agent_finance_legacy set balance_imported_event_id=event_id where id=p_legacy;
 else update public.team_agent_finance_legacy set topup_imported_event_id=event_id where id=p_legacy;end if;
 r:=jsonb_set(r,'{requestId}',to_jsonb(p_request_id));insert into public.team_agent_finance_requests(team_id,actor_id,request_id,payload,result) values(p_team,auth.uid(),p_request_id,payload,r);return r;
end $$;
-- A storage-free team with financial history is no longer a disposable draft.
alter function public.delete_draft_team(uuid) set schema private;
alter function private.delete_draft_team(uuid) rename to finance_delete_draft;
revoke all on function private.finance_delete_draft(uuid) from public,anon,authenticated;
create function public.delete_draft_team(p_team uuid) returns table(ok boolean) language plpgsql security definer set search_path='' as $$ begin
 perform private.finance_access(p_team,'edit');
 if exists(select 1 from public.team_agent_finance_events where team_id=p_team) or exists(select 1 from public.team_agent_finance_legacy where team_id=p_team) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503';end if;
 return query select * from private.finance_delete_draft(p_team);
end $$;
revoke all on function public.clear_team_agent_finance_values(uuid,date,text,jsonb,text,uuid),public.list_team_agent_finance_legacy(uuid,uuid),public.import_team_agent_finance_legacy(uuid,uuid,text,date,text,text,text,uuid),public.delete_draft_team(uuid) from public,anon;
grant execute on function public.clear_team_agent_finance_values(uuid,date,text,jsonb,text,uuid),public.list_team_agent_finance_legacy(uuid,uuid),public.import_team_agent_finance_legacy(uuid,uuid,text,date,text,text,text,uuid),public.delete_draft_team(uuid) to authenticated;
