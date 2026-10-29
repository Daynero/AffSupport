-- Assignment is an optional operational reservation, independent of generation inputs.
-- Keep the active-account guard and all immutable-source/replay fences.
do $migration$
declare definition text;
 needle text := 'if not exists(select 1 from private.team_launch_assignments a where a.team_id=p_team and a.launch_id=p_launch and a.state=''assigned'' and a.agent_row_id::text=p_config->>''agentRowId'' and a.agent_row_id::text=p_sources->>''agentRowId'') then raise exception ''WRONG_STATE'' using errcode=''55000'';end if;';
begin
 definition := pg_get_functiondef('public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'Launch optional assignment seam changed';end if;
 execute replace(definition,needle,'');
end $migration$;
