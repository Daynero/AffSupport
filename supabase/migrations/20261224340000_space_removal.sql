-- Removing a space (owner, 2026-11-25): no space hangs in the list with nothing to press.
--
-- Everyone has a way out of every space. A member leaves (`leave_team`, 024). An owner with
-- people in the space hands it over first (`transfer_ownership`, 001) — the refusal below is the
-- same `OWNER_TRANSFER_REQUIRED` that `leave_team` raises. An owner alone deletes it.
--
-- Deleting is the archive every surface already honours: `teams.status = 'archived'` takes the
-- space out of `list_my_teams`, gives nobody a role in it (`private.team_role`) and closes the
-- 034 gate (`private.team_workspace_allowed`), which every worker claim already checks — so
-- sync, the catalog updater, re-stitching and the assistant stop for it without a list of their
-- own here. A hard delete is not possible for a space that has been used: retention guards
-- (catalog variants, their operations, assignments) refuse it, and they are right to.
--
-- What the hard delete's triggers would have released is released here, by hand:
--   * R2 copies of catalog videos and published catalog pictures are queued for purging with
--     reason 'team_deleted' (the same rows `catalog_video_r2_before_team_delete` and
--     `catalog_image_before_team_delete` write), and the video copies stop being live;
--   * the space's identities in the global catalog pool close (`catalog_global_team_deleted`);
--   * a paid tariff bound to the space is unbound, which is what the FK's `on delete set null`
--     does: `create_team` binds it to the owner's next space.
-- Pending invitations are revoked. Nothing touches Google Drive: the folder, the files and the
-- catalog sheets stay where they are, the owner's.

-- ---------------------------------------------------------------------------------------------
-- What deleting would take with it, for the confirmation to name. Owner-only counts; anyone else
-- learns only their role, which is all the leave confirmation needs.
create or replace function public.get_space_removal_preview(p_team uuid)
returns jsonb
language plpgsql
stable
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
    return jsonb_build_object('role', actor_role);
  end if;

  return jsonb_build_object(
    'role', actor_role,
    'otherMembers', (
      select count(*) from public.team_members as member
      where member.team_id = p_team and member.status = 'active' and member.user_id <> actor
    ),
    'pendingInvitations', (
      select count(*) from public.team_invitations as invitation
      where invitation.team_id = p_team and invitation.state = 'pending'
        and invitation.expires_at > clock_timestamp()
    ),
    'files', (
      select count(*) from public.team_materials as material
      where material.team_id = p_team and material.lifecycle = 'active'
        and material.kind = 'file' and material.companion_of is null
    ),
    'catalogs', (
      select count(*) from public.team_product_catalogs as catalog
      join public.team_materials as material
        on material.id = catalog.material_id and material.lifecycle = 'active'
      where catalog.team_id = p_team
    ),
    'tasks', (select count(*) from public.team_tasks as task where task.team_id = p_team),
    'launches', (
      select count(*) from public.team_launches as launch
      where launch.team_id = p_team and launch.archived_at is null
    ),
    'accounts', (
      select count(*) from public.team_accounts as account
      where account.team_id = p_team and account.archived_at is null
    ),
    'storedVideos', (
      select count(*) from private.catalog_video_r2_copies as copy
      where copy.team_id = p_team and copy.state = 'ready'
    ),
    'tariff', exists (
      select 1 from public.space_tariffs as tariff
      where tariff.team_id = p_team and tariff.revoked_at is null
        and tariff.ends_on >= private.kyiv_today()
    ),
    'driveFolder', (
      select connection.root_folder_name from public.team_drive_connections as connection
      where connection.team_id = p_team and connection.state <> 'detached'
      order by connection.created_at desc limit 1
    )
  );
end;
$$;

revoke all on function public.get_space_removal_preview(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_space_removal_preview(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The owner, alone in the space, deletes it.
create or replace function public.delete_space(p_team uuid)
returns table (ok boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  space_owner uuid;
begin
  if actor is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  -- Membership first, as `leave_team` does: a stranger cannot tell an existing space from none.
  if private.team_role(p_team, actor) is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select team.owner_id into space_owner
  from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if space_owner is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if space_owner <> actor then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  -- Other people's work is in it: the space is theirs to keep, under a new owner.
  if exists (
    select 1 from public.team_members as member
    where member.team_id = p_team and member.status = 'active' and member.user_id <> actor
  ) then
    raise exception 'OWNER_TRANSFER_REQUIRED' using errcode = '42501';
  end if;

  update public.team_invitations as invitation
     set state = 'revoked', responded_at = clock_timestamp(), updated_at = clock_timestamp()
   where invitation.team_id = p_team and invitation.state = 'pending';

  perform private.record_team_audit(p_team, actor, 'team.deleted', '{}'::jsonb, 'succeeded', null);

  update public.teams as team set status = 'archived' where team.id = p_team;

  -- The gate is closed now: a catalog the updater was keeping on a schedule is paused.
  perform private.apply_tariff_pauses(p_team);

  -- A live paid tariff goes back to its owner, for the next space they create.
  update public.space_tariffs as tariff
     set team_id = null, updated_at = clock_timestamp()
   where tariff.team_id = p_team and tariff.revoked_at is null
     and tariff.ends_on >= private.kyiv_today();

  -- R2: the rows the team-delete triggers write, then the copies stop being live.
  insert into private.catalog_video_r2_purges (team_ref, copy_ref, object_key, upload_id, reason)
  select p_team, copy.id, copy.object_key, copy.upload_id, 'team_deleted'
  from private.catalog_video_r2_copies as copy
  where copy.team_id = p_team and copy.state <> 'deleted'
  on conflict (object_key) do nothing;
  update private.catalog_video_r2_copies as copy
     set state = 'deleted', retire_reason = 'team_deleted', deleted_at = clock_timestamp(),
         lease_owner = null, lease_until = null, fence = copy.fence + 1
   where copy.team_id = p_team and copy.state <> 'deleted';

  insert into private.catalog_image_purges
    (publication_id, scope_id, bucket_kind, object_key, reason, uncertain_write, not_before)
  select publication.id, p_team, 'public', publication.object_key, 'team_deleted',
         publication.uncertain_write or publication.state = 'put_unknown',
         clock_timestamp() + interval '2 minutes'
  from private.catalog_image_publications as publication
  where publication.team_id = p_team
  on conflict (bucket_kind, object_key) do update set
    reason = 'team_deleted', state = 'pending', fence = catalog_image_purges.fence + 1,
    lease_until = null, attempts = 0, next_attempt_at = clock_timestamp(),
    uncertain_write = catalog_image_purges.uncertain_write or excluded.uncertain_write,
    not_before = greatest(excluded.not_before,
      case when catalog_image_purges.reason in ('explicit_revoke', 'team_deleted')
        then catalog_image_purges.not_before else '-infinity'::timestamptz end);
  insert into private.catalog_image_purges (scope_id, bucket_kind, object_key, reason, not_before)
  select p_team, 'staging', entry.staging_key, 'expired_staging',
         greatest(coalesce(entry.grant_expires_at, clock_timestamp()), clock_timestamp())
           + interval '5 minutes'
  from private.catalog_image_import_entries as entry
  where entry.team_id = p_team and entry.staging_key is not null
  on conflict (bucket_kind, object_key) do nothing;

  update private.catalog_global_identities as identity
     set closed = true
   where identity.team_id = p_team and not identity.closed;

  return query select true;
end;
$$;

revoke all on function public.delete_space(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.delete_space(uuid) to authenticated;
