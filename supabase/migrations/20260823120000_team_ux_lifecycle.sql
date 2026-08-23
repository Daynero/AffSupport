-- Team UX refresh (010): the four backend gaps the reworked surfaces need.
--
--   leave_team                  a member can exit without asking an admin (FR-022)
--   delete_draft_team           an abandoned wizard leaves nothing behind (FR-023)
--   delete_team_task            the task lifecycle closes (FR-027)
--   list_team_trashed_materials the trash view has something to read (FR-025)
--
-- Every function follows the 001 template: security definer, `set search_path = ''`,
-- fully-qualified names, permission checks through the existing membership helpers,
-- an audit row per mutation, and a narrow grant to `authenticated` only.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

-- ---------------------------------------------------------------------------
-- Audit target vocabulary
-- ---------------------------------------------------------------------------
-- `task.deleted` has to name what was deleted, and a task id is not in the
-- target key whitelist yet. The list is a guard against unbounded PII in the
-- audit trail, so it grows by explicit amendment rather than by loosening.
-- `task_title` is a snapshot for the same reason `actor_label_snapshot` is one:
-- the row it described no longer exists to be joined against.
create or replace function private.record_team_audit(
  p_team uuid,
  p_actor uuid,
  p_action text,
  p_target jsonb,
  p_result text,
  p_error_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id uuid;
  actor_label text;
begin
  if p_actor is null
     or p_action is null
     or char_length(p_action) not between 1 and 96
     or p_result not in ('succeeded', 'denied', 'failed', 'canceled')
     or jsonb_typeof(coalesce(p_target, '{}'::jsonb)) <> 'object'
     or exists (
       select 1
       from jsonb_object_keys(coalesce(p_target, '{}'::jsonb)) as target_key(key)
       where target_key.key not in (
         'member_id', 'invitation_id', 'connection_id', 'material_id',
         'operation_id', 'relation', 'role', 'state', 'warning_code',
         'task_id', 'task_title'
       )
     ) then
    raise exception 'INVALID_AUDIT_EVENT' using errcode = '22023';
  end if;

  select left(profile.display_name, 120)
    into actor_label
  from public.profiles as profile
  where profile.id = p_actor;

  insert into public.team_audit_events (
    team_id,
    actor_id,
    actor_label_snapshot,
    action,
    target,
    result,
    error_code
  ) values (
    p_team,
    p_actor,
    actor_label,
    p_action,
    coalesce(p_target, '{}'::jsonb),
    p_result,
    p_error_code
  )
  returning id into audit_id;
  return audit_id;
end;
$$;

revoke all on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
from public, anon, authenticated;
grant execute on function private.record_team_audit(uuid, uuid, text, jsonb, text, text)
to service_role;

-- ---------------------------------------------------------------------------
-- 1. leave_team
-- ---------------------------------------------------------------------------
-- Same row-level effect as `remove_member`, authorized on *self* instead of on
-- `manage_members`. The membership check runs before the team lookup so a
-- caller who is not a member cannot tell an existing space from an absent one
-- (001 FR-016) — both answers are NOT_FOUND.
create or replace function public.leave_team(p_team uuid)
returns table (ok boolean, warning_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  canonical_owner uuid;
begin
  if actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  perform 1
  from public.team_members as member
  where member.team_id = p_team
    and member.user_id = actor
    and member.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select team.owner_id
    into canonical_owner
  from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if canonical_owner is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- A space cannot be left without an owner. The UI hides the action for owners
  -- and explains the transfer path; this is the server saying the same thing.
  if actor = canonical_owner then
    raise exception 'OWNER_TRANSFER_REQUIRED' using errcode = '42501';
  end if;

  update public.team_members as member
  set status = 'removed',
      removed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where member.team_id = p_team
    and member.user_id = actor
    and member.status = 'active';

  perform private.revoke_team_transfer_grants(p_team, actor);
  perform private.record_team_audit(
    p_team,
    actor,
    'membership.left',
    jsonb_build_object(
      'member_id', actor,
      'warning_code', 'EXTERNAL_DRIVE_ACCESS_REMAINS'
    ),
    'succeeded',
    null
  );

  -- Leaving the space does not revoke Google Drive's own sharing ACL; the
  -- caller must say so out loud, exactly as the remove path does.
  return query select true, 'EXTERNAL_DRIVE_ACCESS_REMAINS'::text;
end;
$$;

revoke all on function public.leave_team(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.leave_team(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. delete_draft_team
-- ---------------------------------------------------------------------------
-- Draftness is a server fact, and a stricter one than the lobby's
-- `setup_incomplete` presentation: a team that has *ever* had a drive
-- connection row — including a detached one — is not a draft, because catalog,
-- provenance and audit history may exist behind it. Presentation may be wrong
-- or stale; this guard is what makes the action safe regardless.
--
-- Retention note: `team_audit_events.team_id` cascades on team delete, so the
-- `team.draft_deleted` row written here does not outlive the team. It is
-- written anyway so the mutation path is uniform and any future audit-retention
-- change (a nullable team reference, an archive sink) picks it up without
-- touching this function. Giving draft deletions a durable trail is a retention
-- change, deliberately out of this feature's scope.
create or replace function public.delete_draft_team(p_team uuid)
returns table (ok boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
begin
  if actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  actor_role := private.team_role(p_team, actor);
  if actor_role is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if actor_role <> 'owner' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  perform 1
  from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.team_drive_connections as connection
    where connection.team_id = p_team
  ) then
    raise exception 'TEAM_NOT_DRAFT' using errcode = '42501';
  end if;

  perform private.record_team_audit(
    p_team, actor, 'team.draft_deleted', '{}'::jsonb, 'succeeded', null
  );

  -- Memberships, invitations and the audit rows above cascade from this delete.
  -- Nothing else can exist: the guard above proves the space never had storage.
  delete from public.teams as team where team.id = p_team;

  return query select true;
end;
$$;

revoke all on function public.delete_draft_team(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.delete_draft_team(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. delete_team_task
-- ---------------------------------------------------------------------------
-- Task create/update is gated on `edit` (005), so deletion is too. Attachment
-- links cascade from `team_task_attachments`' composite FK; the attached
-- materials themselves are untouched — detaching a file from a task has never
-- meant losing the file.
create or replace function public.delete_team_task(p_team uuid, p_task uuid)
returns table (ok boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  task_title text;
begin
  if actor is null or not private.can(p_team, 'edit', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select left(task.title, 160)
    into task_title
  from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team
  for update;
  if task_title is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.team_tasks as task
  where task.id = p_task and task.team_id = p_team;

  perform private.record_team_audit(
    p_team,
    actor,
    'task.deleted',
    jsonb_build_object('task_id', p_task, 'task_title', task_title),
    'succeeded',
    null
  );

  return query select true;
end;
$$;

revoke all on function public.delete_team_task(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.delete_team_task(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. list_team_trashed_materials
-- ---------------------------------------------------------------------------
-- The read behind the trash view. Same visibility rule as the catalog (`view`),
-- newest-first, keyset-paged on `trashed_at`. `parent_path_hint` is the name of
-- the folder the file was in, resolved through the Drive parent id — enough to
-- tell two same-named files apart in a restore list without reconstructing a
-- full path for a row whose parent may itself be gone.
create or replace function public.list_team_trashed_materials(
  p_team uuid,
  p_limit int default 50,
  p_before timestamptz default null
)
returns table (
  id uuid,
  name text,
  kind text,
  trashed_at timestamptz,
  parent_path_hint text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  effective_limit int;
begin
  if actor is null or not private.can(p_team, 'view', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  effective_limit := p_limit;

  return query
  select material.id,
         material.name,
         material.kind,
         material.trashed_at,
         parent.name
  from public.team_materials as material
  left join public.team_materials as parent
    on parent.team_id = material.team_id
   and parent.drive_file_id = material.parent_folder_id
   and parent.kind = 'folder'
  where material.team_id = p_team
    and material.lifecycle = 'trashed'
    and material.trashed_at is not null
    and (p_before is null or material.trashed_at < p_before)
  order by material.trashed_at desc, material.id desc
  limit effective_limit;
end;
$$;

revoke all on function public.list_team_trashed_materials(uuid, int, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function public.list_team_trashed_materials(uuid, int, timestamptz)
to authenticated;
