-- Forward-only: retain the same access checks and one-statement snapshot,
-- but accept completed calendar ranges (up to 366 inclusive days).
begin;
create or replace function public.get_team_agent_finance(p_team uuid,p_from date,p_to date,p_timezone text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 perform private.finance_access(p_team,'view');perform private.finance_today(p_timezone);
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>365 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select jsonb_build_object('schemaVersion',1,'teamId',t.id,'teamName',t.name,'from',p_from,'to',p_to,'currency','USD','generatedAt',now(),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name)) from public.team_accounts a where a.team_id=p_team),'[]'),
 'agents',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'agentId',a.agent_id)) from public.team_account_agents a where a.team_id=p_team),'[]'),
 'placements',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'agentRowId',p.agent_row_id,'accountId',p.account_id,'startsOn',p.starts_on,'endsOn',p.ends_on,'version',p.version::text)) from public.team_agent_placements p where p.team_id=p_team and p.starts_on<=p_to and (p.ends_on is null or p.ends_on>p_from)),'[]'),
 'fields',coalesce((select jsonb_agg(private.finance_field(v)) from public.team_agent_finance_values v where v.team_id=p_team and v.entry_date between p_from and p_to),'[]')) into result from public.teams t where t.id=p_team;
 return result;
end $$;
commit;
