-- Registration in Soty is not the beginning of an ad account's financial history.
-- The first placement owns all dates before the first recorded transfer.
begin;
lock table public.team_account_agents in share row exclusive mode;
lock table public.team_agent_placements in share row exclusive mode;

update public.team_agent_placements p
set starts_on = date '0001-01-01', version = version + 1
where not exists (
  select 1 from public.team_agent_transfer_events t where t.to_placement_id = p.id
);

create or replace function private.finance_agent_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_agent_placements(team_id, agent_row_id, account_id, starts_on)
  values(new.team_id, new.id, new.account_id, date '0001-01-01');
  return new;
end $$;

create or replace function public.add_team_account_agent(
  p_team uuid, p_account uuid, p_agent_id text,
  p_note text default null, p_timezone text default 'UTC'
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.finance_today(p_timezone);
  return private.finance_create_agent(p_team, p_account, p_agent_id, p_note);
end $$;
commit;
