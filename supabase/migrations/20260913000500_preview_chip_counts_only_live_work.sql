-- "Готуємо превʼю · 473 з 474", forever, one short of done.
--
-- 20260912160000 bounded the *thumbnail* half of this with a 24-hour window and
-- left the render half counting anything not finished. The owner hit it again
-- on the last item, and the reason was in the data rather than in the window:
-- one row in `team_landing_renders` sat in `rendering` from a pass that ended
-- hours earlier, because nothing ever writes a stopped render back.
--
-- The project already decided what a live render is. `list_landing_renders`
-- (20260815112000) projects any `rendering` row older than four minutes as
-- `failed`, matching the agent's three-minute watchdog: the file's own tile has
-- been saying "render failed" this whole time while the space-wide chip said
-- "preparing". Two readings of one row, and the chip had the wrong one.
--
-- So the chip now counts only work something is demonstrably doing:
--
--   * renders — only while a render was touched inside that same four-minute
--     window; a queue with no worker is not progress,
--   * thumbnails — only while the warm pass is running (it claims rows at most
--     ten minutes apart, so a claim in the last fifteen proves it) or the file
--     is new enough that its first claim has not come round yet.
--
-- The stopped rows are also written back rather than reinterpreted on every
-- read: a `rendering` row older than the watchdog is a failed render, and a
-- table that stores one thing while every reader means another is how this bug
-- survived its first fix. Once here for what is already stuck, and every five
-- minutes after that, on the tick the warm pass already runs on.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

with expired as (
  update public.team_landing_renders as render
  set render_state = 'failed',
      failure_reason = 'render_error',
      artifact_root = null,
      segment_count = 0,
      updated_at = pg_catalog.clock_timestamp()
  where render.render_state = 'rendering'
    and render.updated_at < pg_catalog.clock_timestamp() - interval '4 minutes'
  returning render.team_id, render.material_id
)
insert into public.team_catalog_events (team_id, material_id, event_kind)
select expired.team_id, expired.material_id, 'upserted'
from expired;

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
  live_job boolean;
  warm_active boolean;
  render_active boolean;
  folder_total integer;
  folder_unindexed integer;
  file_total integer;
  thumbs_pending integer;
  thumbs_ready integer;
  renders_pending integer;
  scanning boolean;
  -- How long a missing preview can still honestly be called "preparing".
  preview_window constant interval := interval '24 hours';
  -- The warm pass claims a row at most ten minutes apart, so a claim inside
  -- this window is proof it is running.
  warm_liveness constant interval := interval '15 minutes';
  -- The agent's watchdog is three minutes; `list_landing_renders` already reads
  -- anything older than four as a failed render.
  render_liveness constant interval := interval '4 minutes';
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
         count(*) filter (
           where material.provider_thumbnail_state = 'pending'
             and coalesce(material.modified_at, material.created_at)
                 > clock_timestamp() - preview_window
         )::integer,
         count(*) filter (where material.provider_thumbnail_state = 'ready')::integer,
         -- Is anything actually warming previews right now? Either the pass has
         -- claimed a row recently, or a file arrived before its first claim was
         -- due. Without one of those, `pending` means "Drive never made one".
         bool_or(
           material.provider_thumbnail_state = 'pending'
           and (
             material.provider_thumbnail_claimed_at > clock_timestamp() - warm_liveness
             or coalesce(material.created_at, material.modified_at)
                > clock_timestamp() - warm_liveness
           )
         )
    into folder_total, folder_unindexed, file_total, thumbs_pending, thumbs_ready, warm_active
  from public.team_materials as material
  where material.team_id = p_team
    and material.connection_id = connection.id
    and material.lifecycle = 'active';

  scanning := connection.initial_sync_state in ('not_started', 'scanning', 'replaying')
              or folder_unindexed > 0;

  if scanning then
    -- Something has to be moving for "indexing" to be true. A leased job is
    -- being worked on right now; any other job counts only while it is fresh.
    select exists (
      select 1
      from private.catalog_sync_jobs as job
      where job.connection_id = connection.id
        and job.state in ('pending', 'leased', 'retry')
        and (
          (job.state = 'leased' and job.lease_expires_at > clock_timestamp())
          or job.updated_at > clock_timestamp() - interval '15 minutes'
        )
    ) into live_job;

    if not live_job then
      return jsonb_build_object('kind', 'attention', 'reason', 'sync_failed', 'fixer', 'manager');
    end if;

    return jsonb_build_object(
      'kind', 'indexing',
      'indexedFolders', folder_total - folder_unindexed,
      'totalFolders', case when connection.initial_sync_state = 'scanning' then null else folder_total end,
      'files', file_total
    );
  end if;

  -- A render pass is live when one of its rows was touched inside the watchdog
  -- window. Outside it, `rendering` is a render that stopped and `stale` is a
  -- queue nobody is working through — neither is progress to report.
  select exists (
    select 1
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id and material.team_id = render.team_id
    where render.team_id = p_team
      and material.lifecycle = 'active'
      and render.render_state = 'rendering'
      and render.updated_at > clock_timestamp() - render_liveness
  ) into render_active;

  renders_pending := 0;
  if render_active then
    select count(*)::integer into renders_pending
    from public.team_landing_renders as render
    join public.team_materials as material
      on material.id = render.material_id and material.team_id = render.team_id
    where render.team_id = p_team
      and material.lifecycle = 'active'
      and render.render_state in ('rendering', 'stale')
      and render.updated_at > clock_timestamp() - preview_window;
  end if;

  if not coalesce(warm_active, false) then
    thumbs_pending := 0;
  end if;

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


-- Keep it true from here on. The one-off above clears what is stuck today; this
-- clears what stops tomorrow, on the same five-minute tick the warm pass uses.
create or replace function private.expire_stopped_landing_renders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_count integer;
begin
  with expired as (
    update public.team_landing_renders as render
    set render_state = 'failed',
        failure_reason = 'render_error',
        artifact_root = null,
        segment_count = 0,
        updated_at = pg_catalog.clock_timestamp()
    where render.render_state = 'rendering'
      and render.updated_at < pg_catalog.clock_timestamp() - interval '4 minutes'
    returning render.team_id, render.material_id
  ), announced as (
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    select expired.team_id, expired.material_id, 'upserted'
    from expired
    returning 1
  )
  select count(*)::integer into expired_count from announced;
  return expired_count;
end;
$$;

revoke all on function private.expire_stopped_landing_renders()
from public, anon, authenticated, service_role;

select cron.unschedule(job.jobid)
from cron.job as job
where job.jobname = 'wishly-landing-render-expiry';

select cron.schedule(
  'wishly-landing-render-expiry',
  '*/5 * * * *',
  $cron$select private.expire_stopped_landing_renders()$cron$
);
