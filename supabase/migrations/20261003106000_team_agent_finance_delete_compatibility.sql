begin;

-- Transfer-only agents are not financial archives. Preserve the existing
-- protection for any monetary journal/legacy history, including cleared values.
create or replace function private.finance_agent_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if new.balance is distinct from old.balance or new.topup is distinct from old.topup then
   raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023';
  end if;
  return new;
 end if;
 if exists(select 1 from public.teams where id=old.team_id) and (
  exists(select 1 from public.team_agent_finance_events where agent_row_id=old.id)
  or exists(select 1 from public.team_agent_finance_legacy where agent_row_id=old.id)
 ) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503'; end if;
 delete from public.team_agent_transfer_events where agent_row_id=old.id;
 return old;
end $$;

-- A former account may own only placements, but those placements still explain
-- a financial agent's transfers. Do not silently erase that archive.
create or replace function private.finance_account_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.teams where id=old.team_id) and (
  exists(select 1 from public.team_agent_finance_events where account_id=old.id)
  or exists(select 1 from public.team_agent_finance_legacy where account_id=old.id)
  or exists(
   select 1 from public.team_agent_placements p
   where p.account_id=old.id and (
    exists(select 1 from public.team_agent_finance_events e where e.agent_row_id=p.agent_row_id)
    or exists(select 1 from public.team_agent_finance_legacy l where l.agent_row_id=p.agent_row_id)
   )
  )
 ) then raise exception 'FINANCE_HISTORY_PROTECTED' using errcode='23503'; end if;
 delete from public.team_agent_transfer_events e using public.team_agent_placements p
 where p.account_id=old.id and (e.from_placement_id=p.id or e.to_placement_id=p.id);
 return old;
end $$;

revoke all on function private.finance_agent_guard(),private.finance_account_guard() from public,anon,authenticated;
commit;
