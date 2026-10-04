-- Preserve the existing anti-enumeration and owner-only draft-delete contract.
create or replace function public.delete_draft_team(p_team uuid) returns table(ok boolean)
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000';end if;
  if private.team_role(p_team,auth.uid()) is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
  if private.team_role(p_team,auth.uid())<>'owner' then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  perform private.finance_access(p_team,'edit');
  if exists(select 1 from public.team_agent_finance_events where team_id=p_team)
    or exists(select 1 from public.team_agent_finance_legacy where team_id=p_team)
    then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503';end if;
  return query select * from private.finance_delete_draft(p_team);
end $$;
