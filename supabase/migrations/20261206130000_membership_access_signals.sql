-- 036: the affected person must receive invalidation even after membership RLS closes.
begin;
create table public.team_membership_access_signals (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  changed_at timestamptz not null default clock_timestamp(),
  primary key (team_id, user_id)
);
create index team_membership_access_signals_user on public.team_membership_access_signals(user_id);
alter table public.team_membership_access_signals enable row level security;
revoke all on public.team_membership_access_signals from public, anon, authenticated;
grant select on public.team_membership_access_signals to authenticated;
grant all on public.team_membership_access_signals to service_role;
-- No role, permission values, content or other members' identifiers are disclosed.
-- The own-row signal remains readable after removal; it grants no workspace access.
create policy membership_access_signal_self on public.team_membership_access_signals
for select to authenticated using (user_id = (select auth.uid()));

create function private.signal_membership_access_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare changed jsonb; target_team uuid; target_user uuid;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
    and new.base_role is not distinct from old.base_role
    and new.permission_overrides is not distinct from old.permission_overrides then
    return null;
  end if;
  changed := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  target_team := (changed->>'team_id')::uuid;
  target_user := (changed->>'user_id')::uuid;
  -- Cascading deletion of the parent must never resurrect an orphan signal.
  if not exists (select 1 from public.teams where id=target_team)
    or not exists (select 1 from auth.users where id=target_user) then return null; end if;
  insert into public.team_membership_access_signals(team_id,user_id)
  values(target_team,target_user)
  on conflict(team_id,user_id) do update
    set revision=public.team_membership_access_signals.revision+1,
        changed_at=clock_timestamp();
  return null;
end;
$$;
revoke all on function private.signal_membership_access_change() from public,anon,authenticated;
create trigger membership_access_changed
  after insert or update of status,base_role,permission_overrides or delete on public.team_members
  for each row execute function private.signal_membership_access_change();
insert into public.team_membership_access_signals(team_id,user_id)
select team_id,user_id from public.team_members on conflict do nothing;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.team_membership_access_signals;
  end if;
end $$;
-- Restricted diagnostics can prove production of a signal, never browser receipt.
create view public.analytics_membership_access_signals as
select team_id,user_id,revision,changed_at from public.team_membership_access_signals;
revoke all on public.analytics_membership_access_signals from public,anon,authenticated;
grant select on public.analytics_membership_access_signals to service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
    grant select on public.analytics_membership_access_signals to wishly_analytics_ro;
  end if;
end $$;
commit;
