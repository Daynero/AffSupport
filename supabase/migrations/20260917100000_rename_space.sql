-- Feature 024 — a space can be renamed.
--
-- A space's name was fixed the moment it was typed: there was no rename, so correcting it meant
-- deleting the space. Now that a space is named by what it holds rather than by who is in it,
-- the create flow suggests a name and takes the chosen folder's name for it, which needs the
-- same write. Owner only; the name stays unique among the spaces the owner belongs to, as
-- create_team keeps it. Forward-only; ROLLBACK.md drops the function.

create or replace function public.rename_team(p_team uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := pg_catalog.regexp_replace(pg_catalog.btrim(normalize(coalesce(p_name, ''), NFC)), '\s+', ' ', 'g');
  current_name text;
begin
  if actor is null or not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if private.team_role(p_team, actor) is distinct from 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if char_length(normalized_name) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select team.name into current_name from public.teams as team where team.id = p_team for update;
  if current_name = normalized_name then
    return normalized_name;
  end if;
  if exists (
    select 1
    from public.team_members as member
    join public.teams as team on team.id = member.team_id
    where member.user_id = actor
      and member.status = 'active'
      and team.status = 'active'
      and team.id <> p_team
      and lower(btrim(team.name)) = lower(normalized_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  update public.teams set name = normalized_name where id = p_team;
  perform private.record_team_audit(p_team, actor, 'team.renamed', '{}'::jsonb, 'succeeded', null);
  return normalized_name;
end;
$$;

revoke all on function public.rename_team(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.rename_team(uuid, text) to authenticated;
