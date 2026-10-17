-- One calendar day for every member of a space. Existing spaces use the
-- product's Kyiv day until an owner explicitly chooses another IANA zone.
alter table public.teams
  add column task_timezone text not null default 'Europe/Kyiv',
  add constraint teams_task_timezone_length check (char_length(task_timezone) between 1 and 100);

create function public.get_team_task_timezone(p_team uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare zone text;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select task_timezone into zone from public.teams where id = p_team;
  if zone is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return zone;
end $$;

create function public.set_team_task_timezone(p_team uuid, p_timezone text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'manage_metadata', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_timezone is null or char_length(p_timezone) > 100 or not exists (
    select 1 from pg_catalog.pg_timezone_names where name = p_timezone
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.teams set task_timezone = p_timezone where id = p_team;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return p_timezone;
end $$;

revoke all on function public.get_team_task_timezone(uuid) from public, anon;
revoke all on function public.set_team_task_timezone(uuid, text) from public, anon;
grant execute on function public.get_team_task_timezone(uuid) to authenticated;
grant execute on function public.set_team_task_timezone(uuid, text) to authenticated;
