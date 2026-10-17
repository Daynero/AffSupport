-- One content-free invalidation per workspace; existing TeamContext remains the sole subscriber.
create table public.team_launch_workspace_signals(team_id uuid primary key references public.teams(id) on delete cascade,version bigint not null default 1,updated_at timestamptz not null default now());
alter table public.team_launch_workspace_signals enable row level security;
alter table public.team_launch_workspace_signals force row level security;
revoke all on public.team_launch_workspace_signals from public,anon,authenticated;
grant select(team_id,version,updated_at) on public.team_launch_workspace_signals to authenticated;
grant select,insert,update on public.team_launch_workspace_signals to service_role;
create policy team_launch_workspace_signal_view on public.team_launch_workspace_signals for select to authenticated using(private.can(team_id,'view',auth.uid()));
create function private.launch_workspace_invalidate() returns trigger language plpgsql security definer set search_path='' as $$
declare scope uuid;begin
 scope:=coalesce(new.team_id,old.team_id);
 if exists(select 1 from public.teams where id=scope) then
  insert into public.team_launch_workspace_signals(team_id) values(scope) on conflict(team_id) do update set version=team_launch_workspace_signals.version+1,updated_at=clock_timestamp();
 end if;
 return coalesce(new,old);
end $$;
revoke all on function private.launch_workspace_invalidate() from public,anon,authenticated,service_role;
create trigger team_launch_offers_invalidate after insert or update or delete on public.team_launch_offers for each row execute function private.launch_workspace_invalidate();
create trigger team_launch_buyers_invalidate after insert or update or delete on public.team_launch_buyers for each row execute function private.launch_workspace_invalidate();
create trigger team_launch_defaults_invalidate after insert or update or delete on public.team_launch_defaults for each row execute function private.launch_workspace_invalidate();
do $$ begin if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime') then alter publication supabase_realtime add table public.team_launch_workspace_signals;end if;end $$;
