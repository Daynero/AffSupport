-- A task's ad-account tag follows the ad account when it moves (027 T026).
--
-- 20261008120000 froze each tag at the social account the ad account sat under when the tag was
-- attached, so after a transfer the task kept pointing at the former social account: filtered
-- under the old one, absent from the new one. The owner decided the opposite (2026-10-11): a tag
-- names the ad account, and the ad account is wherever it is now — the same rule the money
-- already follows since 20261125110000. The transfer audit keeps where it came from.

begin;

-- Tags stay immutable to clients; only the move itself re-points them.
create or replace function private.capture_task_agent_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if new.agent_row_id is distinct from old.agent_row_id
       or new.team_id is distinct from old.team_id
       or (
         (new.account_name_snapshot is distinct from old.account_name_snapshot
          or new.account_id is distinct from old.account_id)
         and coalesce(current_setting('soty.task_tags_follow', true), '') <> 'on'
       ) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  else
    select a.account_id into new.account_id
    from public.team_account_agents a
    where a.id = new.agent_row_id and a.team_id = new.team_id
    for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    select a.name into new.account_name_snapshot
    from public.team_accounts a
    where a.id = new.account_id and a.team_id = new.team_id;
  end if;
  return new;
end $$;

revoke all on function private.capture_task_agent_account() from public, anon, authenticated;

create function private.task_tags_follow_ad_account() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('soty.task_tags_follow', 'on', true);
  update public.team_task_agents as link
     set account_id = new.account_id,
         account_name_snapshot = account.name
    from public.team_accounts as account
   where link.agent_row_id = new.id
     and link.team_id = new.team_id
     and account.id = new.account_id
     and link.account_id is distinct from new.account_id;
  perform set_config('soty.task_tags_follow', 'off', true);
  return new;
end $$;

revoke all on function private.task_tags_follow_ad_account() from public, anon, authenticated;

create trigger task_tags_follow_ad_account
  after update of account_id on public.team_account_agents
  for each row
  when (new.account_id is distinct from old.account_id)
  execute function private.task_tags_follow_ad_account();

-- Tags left behind by transfers made before this migration.
select set_config('soty.task_tags_follow', 'on', true);
update public.team_task_agents as link
   set account_id = agent.account_id,
       account_name_snapshot = account.name
  from public.team_account_agents as agent
  join public.team_accounts as account on account.id = agent.account_id
 where agent.id = link.agent_row_id
   and link.account_id is distinct from agent.account_id;
select set_config('soty.task_tags_follow', 'off', true);

commit;
