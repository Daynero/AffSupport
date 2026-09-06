-- The history names the thing it happened to.
--
-- Every line read "Роботу зупинено · Скасовано · 6 вер., 04:51" and then the
-- same again, and again — the actor, the outcome and the time, and never the
-- object. Three cancelled jobs look identical when the file is the only thing
-- that tells them apart, so a page of them is noise: you cannot tell which
-- video failed, or whether the one you care about is even in the list.
--
-- The target already carries `material_id`; the name is one join away, and it
-- is snapshotted at read time rather than stored, so a renamed file reads under
-- the name it has now.

drop function if exists public.list_team_audit_events(uuid, integer, timestamptz);

create or replace function public.list_team_audit_events(
  p_team uuid,
  p_limit integer default 50,
  -- The caller sends this only when paging, so it must keep its default: a
  -- drop-and-create loses them, and the panel's first read stopped matching any
  -- signature at all.
  p_before timestamptz default null
)
returns table (
  id uuid,
  actor_label text,
  action text,
  target jsonb,
  result text,
  error_code text,
  occurred_at timestamptz,
  subject_label text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role not in ('owner', 'admin') then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  return query
  select event.id,
         event.actor_label_snapshot,
         event.action,
         event.target,
         event.result,
         event.error_code,
         event.occurred_at,
         -- Whichever of the things an entry can be about it actually names: a
         -- file, an invitation's address, a folder. Null when the row is about
         -- the space itself, which needs no subject.
         coalesce(
           (select material.name
            from public.team_materials as material
            where material.team_id = p_team
              and material.id = nullif(event.target->>'material_id', '')::uuid),
           (select invitation.target_email
            from public.team_invitations as invitation
            where invitation.team_id = p_team
              and invitation.id = nullif(event.target->>'invitation_id', '')::uuid),
           -- A stopped job names only the operation; the file it was working on
           -- is one more hop, and it is the whole difference between three
           -- identical "Роботу зупинено" lines and three readable ones.
           (select material.name
            from public.team_operations as operation
            join public.team_materials as material
              on material.id = operation.source_material_id
             and material.team_id = operation.team_id
            where operation.team_id = p_team
              and operation.id = nullif(event.target->>'operation_id', '')::uuid),
           nullif(event.target->>'name', '')
         )
  from public.team_audit_events as event
  where event.team_id = p_team
    and (p_before is null or event.occurred_at < p_before)
  order by event.occurred_at desc, event.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_team_audit_events(uuid, integer, timestamptz) from public, anon;
grant execute on function public.list_team_audit_events(uuid, integer, timestamptz) to authenticated;
