-- Every space draws catalog pictures from the shared pool (owner, 2026-11-18: «пілот для всіх»), but
-- the pilot list only held the spaces that existed that day. A space created later had no pictures:
-- its catalog launch stopped at «У поточному стані це неможливо» (WRONG_STATE, production
-- 2026-11-23, «Prostalis GR f18 vid7-8-9»; «MB Space» and «My space» were outside too).
-- A new space now joins the pilot as it is created, and any left outside join now.
begin;

create or replace function private.join_catalog_global_pilot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.catalog_global_pilot_teams (team_id, note)
  values (new.id, 'joined on creation')
  on conflict (team_id) do nothing;
  return new;
end;
$$;

revoke all on function private.join_catalog_global_pilot() from public, anon, authenticated, service_role;

create trigger teams_join_catalog_global_pilot
  after insert on public.teams
  for each row execute function private.join_catalog_global_pilot();

insert into private.catalog_global_pilot_teams (team_id, note)
select t.id, 'pilot for all, 2026-11-23'
from public.teams t
on conflict (team_id) do nothing;

commit;
