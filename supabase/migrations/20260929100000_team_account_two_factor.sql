-- A social account has one authenticator, independent of its ad-account agents.
create table private.team_account_two_factor (
  account_id uuid primary key references public.team_accounts(id) on delete cascade,
  vault_secret_id uuid not null unique
);
alter table private.team_account_two_factor enable row level security;
revoke all on private.team_account_two_factor from public, anon, authenticated;

create or replace function private.delete_team_account_two_factor_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;
revoke all on function private.delete_team_account_two_factor_secret() from public, anon, authenticated, service_role;
create trigger team_account_two_factor_delete_secret after delete on private.team_account_two_factor
for each row execute function private.delete_team_account_two_factor_secret();

-- Keep the first credential for each account; remove agent-level rows thereafter.
do $$
declare
  item record;
  secret_id uuid;
begin
  for item in
    select distinct on (agent.account_id)
      agent.account_id, decrypted.decrypted_secret
    from private.team_agent_two_factor credential
    join public.team_account_agents agent on agent.id = credential.agent_row_id
    join vault.decrypted_secrets decrypted on decrypted.id = credential.vault_secret_id
    order by agent.account_id, agent.created_at, agent.id
  loop
    select vault.create_secret(
      item.decrypted_secret,
      'soty-account-2fa-' || item.account_id::text,
      'Soty social account 2FA seed'
    ) into secret_id;
    insert into private.team_account_two_factor(account_id, vault_secret_id)
    values (item.account_id, secret_id);
  end loop;
end;
$$;
delete from private.team_agent_two_factor;

create or replace function public.list_team_account_two_factor_seeds(p_team uuid)
returns table (account_id uuid, secret text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select account.id, decrypted.decrypted_secret
  from private.team_account_two_factor credential
  join public.team_accounts account on account.id = credential.account_id
  join vault.decrypted_secrets decrypted on decrypted.id = credential.vault_secret_id
  where account.team_id = p_team
  order by account.created_at, account.id;
end;
$$;
revoke all on function public.list_team_account_two_factor_seeds(uuid) from public, anon;
grant execute on function public.list_team_account_two_factor_seeds(uuid) to authenticated;

create or replace function public.set_team_account_two_factor_seed(p_team uuid, p_account uuid, p_secret text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  secret_id uuid;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.team_accounts where id = p_account and team_id = p_team) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_secret is not null and p_secret !~ '^[A-Z2-7]{16,}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  delete from private.team_account_two_factor where account_id = p_account;
  if p_secret is not null then
    select vault.create_secret(p_secret, 'soty-account-2fa-' || p_account::text, 'Soty social account 2FA seed') into secret_id;
    insert into private.team_account_two_factor(account_id, vault_secret_id) values (p_account, secret_id);
  end if;
  return true;
end;
$$;
revoke all on function public.set_team_account_two_factor_seed(uuid, uuid, text) from public, anon;
grant execute on function public.set_team_account_two_factor_seed(uuid, uuid, text) to authenticated;

drop function if exists public.list_team_agent_two_factor_seeds(uuid);
drop function if exists public.add_team_account_agent_with_2fa(uuid, uuid, text, text, text);
drop table private.team_agent_two_factor;
drop function if exists private.delete_team_agent_two_factor_secret();
