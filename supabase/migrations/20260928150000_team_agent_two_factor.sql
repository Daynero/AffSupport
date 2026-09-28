-- Team agents may carry an optional authenticator seed. Keep plaintext out of
-- the public agent row (and therefore out of its normal RPC and realtime path).
create table private.team_agent_two_factor (
  agent_row_id uuid primary key references public.team_account_agents(id) on delete cascade,
  vault_secret_id uuid not null unique
);

alter table private.team_agent_two_factor enable row level security;
revoke all on private.team_agent_two_factor from public, anon, authenticated;

create or replace function private.delete_team_agent_two_factor_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;
revoke all on function private.delete_team_agent_two_factor_secret() from public, anon, authenticated, service_role;

create trigger team_agent_two_factor_delete_secret
after delete on private.team_agent_two_factor
for each row execute function private.delete_team_agent_two_factor_secret();

-- This is the only list path that returns decrypted seeds. View permission is
-- deliberately the same as the account list: every member who can see agents
-- can use their 2FA code.
create or replace function public.list_team_agent_two_factor_seeds(p_team uuid)
returns table (agent_id uuid, secret text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
  select agent.id, decrypted.decrypted_secret
  from private.team_agent_two_factor as credential
  join public.team_account_agents as agent on agent.id = credential.agent_row_id
  join vault.decrypted_secrets as decrypted on decrypted.id = credential.vault_secret_id
  where agent.team_id = p_team
  order by agent.created_at, agent.id;
end;
$$;
revoke all on function public.list_team_agent_two_factor_seeds(uuid) from public, anon;
grant execute on function public.list_team_agent_two_factor_seeds(uuid) to authenticated;

-- One transaction creates the agent and stores its credential, so a vault
-- failure cannot leave a half-created agent behind.
create or replace function public.add_team_account_agent_with_2fa(
  p_team uuid,
  p_account uuid,
  p_agent_id text,
  p_note text,
  p_two_factor_secret text
)
returns public.team_account_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clean_id text := nullif(btrim(coalesce(p_agent_id, '')), '');
  clean_note text := private.team_agent_note(p_note);
  secret_id uuid;
  created public.team_account_agents%rowtype;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if clean_id is null or char_length(clean_id) > 64 or clean_id ~ '\s'
     or (clean_note is not null and char_length(clean_note) > 120)
     or p_two_factor_secret is null
     or p_two_factor_secret !~ '^[A-Z2-7]{16,}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.team_accounts as account
    where account.id = p_account and account.team_id = p_team
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.team_account_agents as existing
    where existing.account_id = p_account and existing.agent_id = clean_id
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.team_account_agents (team_id, account_id, created_by, agent_id, note)
  values (p_team, p_account, actor, clean_id, clean_note)
  returning * into created;
  select vault.create_secret(
    p_two_factor_secret,
    'soty-agent-2fa-' || created.id::text,
    'Soty team agent 2FA seed'
  ) into secret_id;
  insert into private.team_agent_two_factor (agent_row_id, vault_secret_id)
  values (created.id, secret_id);
  return created;
end;
$$;
revoke all on function public.add_team_account_agent_with_2fa(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.add_team_account_agent_with_2fa(uuid, uuid, text, text, text) to authenticated;
