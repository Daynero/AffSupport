create function public.move_team_account_agent(p_team uuid,p_agent uuid,p_target_account uuid,p_effective_on date,p_expected_placement_id uuid,p_expected_placement_version text,p_timezone text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload jsonb:=jsonb_build_array('move',p_agent,p_target_account,p_effective_on,p_expected_placement_id,p_expected_placement_version,p_timezone);replay jsonb;place public.team_agent_placements%rowtype;next_place uuid;result jsonb;begin
 perform private.finance_access(p_team,'edit');replay:=private.finance_lock_request(p_team,p_request_id,payload);if replay is not null then return replay;end if;
 perform 1 from public.team_accounts where team_id=p_team and id in(p_target_account,(select account_id from public.team_account_agents where id=p_agent and team_id=p_team)) order by id for update;
 if not exists(select 1 from public.team_accounts where id=p_target_account and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_account_agents where id=p_agent and team_id=p_team for update;if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into place from public.team_agent_placements where agent_row_id=p_agent and team_id=p_team and ends_on is null;
 if place.id is distinct from p_expected_placement_id or place.version::text is distinct from p_expected_placement_version then raise exception 'PLACEMENT_CONFLICT' using errcode='40001';end if;
 if place.account_id=p_target_account or p_effective_on is null or p_effective_on<=place.starts_on or p_effective_on>private.finance_today(p_timezone) or exists(select 1 from public.team_agent_finance_events where placement_id=place.id and entry_date>=p_effective_on) then raise exception 'TRANSFER_DATE_INVALID' using errcode='22023';end if;
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
