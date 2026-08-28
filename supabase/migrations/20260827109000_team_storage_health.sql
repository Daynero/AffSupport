-- 011 (T071): the one storage-health value the chip renders.
--
-- Exactly one state, in the priority the contract fixes: attention >
-- disconnected > waiting for the provider > indexing > preparing previews >
-- connected. Composed from what the tables already record; nothing is written.
-- Forward-only. Reverse steps are in ROLLBACK.md.

create or replace function public.get_team_storage_health(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  connection record;
  waiting_since timestamptz;
  folder_total integer;
  folder_unindexed integer;
  file_total integer;
  thumbs_pending integer;
  thumbs_ready integer;
  renders_pending integer;
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select drive.id, drive.state, drive.initial_sync_state, drive.last_error_code,
         drive.last_reconciled_at, drive.last_synced_at, drive.connected_at
    into connection
  from public.team_drive_connections as drive
  where drive.team_id = p_team and drive.state <> 'detached'
  order by drive.connected_at desc nulls last
  limit 1;

  if connection.id is null or connection.state in ('pending', 'unavailable') then
    return jsonb_build_object('kind', 'disconnected');
  end if;
  if connection.state = 'needs_reauth' then
    return jsonb_build_object('kind', 'attention', 'reason', 'needs_reauth', 'fixer', 'owner');
  end if;
  if connection.state = 'root_missing' then
    return jsonb_build_object('kind', 'attention', 'reason', 'root_missing', 'fixer', 'owner');
  end if;
  if connection.last_error_code in ('PERMISSION_DENIED', 'ROOT_ESCAPE') then
    return jsonb_build_object('kind', 'attention', 'reason', 'permission_lost', 'fixer', 'owner');
  end if;
  if connection.initial_sync_state = 'failed' then
    return jsonb_build_object('kind', 'attention', 'reason', 'sync_failed', 'fixer', 'manager');
  end if;

  -- The provider pushed back within the last ten minutes: a pause, not a failure.
  select min(job.updated_at) into waiting_since
  from private.catalog_sync_jobs as job
  where job.connection_id = connection.id
    and job.state = 'retry'
    and job.last_error_code in ('RATE_LIMITED', 'DRIVE_UNAVAILABLE')
    and job.updated_at > clock_timestamp() - interval '10 minutes';
  if waiting_since is not null then
    return jsonb_build_object('kind', 'waiting_provider', 'since', waiting_since);
  end if;

  select count(*) filter (where material.kind = 'folder')::integer,
         count(*) filter (where material.kind = 'folder' and material.folder_indexed_at is null)::integer,
         count(*) filter (where material.kind <> 'folder')::integer,
         count(*) filter (where material.provider_thumbnail_state = 'pending')::integer,
         count(*) filter (where material.provider_thumbnail_state = 'ready')::integer
    into folder_total, folder_unindexed, file_total, thumbs_pending, thumbs_ready
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = connection.id
    and material.lifecycle = 'active';

  if connection.initial_sync_state in ('not_started', 'scanning', 'replaying')
     or folder_unindexed > 0 then
    return jsonb_build_object(
      'kind', 'indexing',
      'indexedFolders', folder_total - folder_unindexed,
      'totalFolders', case when connection.initial_sync_state = 'scanning' then null else folder_total end,
      'files', file_total
    );
  end if;

  select count(*)::integer into renders_pending
  from public.team_landing_renders as render
  join public.team_materials as material
    on material.id = render.material_id and material.team_id = render.team_id
  where render.team_id = p_team
    and material.lifecycle = 'active'
    and render.render_state in ('rendering', 'stale');
  if thumbs_pending + renders_pending > 0 then
    return jsonb_build_object(
      'kind', 'preparing',
      'ready', thumbs_ready,
      'pending', thumbs_pending + renders_pending
    );
  end if;

  return jsonb_build_object(
    'kind', 'connected',
    'lastReconciledAt', coalesce(
      connection.last_reconciled_at, connection.last_synced_at, connection.connected_at, clock_timestamp()
    )
  );
end;
$$;

revoke all on function public.get_team_storage_health(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_team_storage_health(uuid) to authenticated;
