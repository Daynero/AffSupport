-- A full Drive resync scans the root AND every separately selected folder.
-- Never mistake an active subtree scan for a full one, or reuse a scan that
-- may already have passed the file uploaded immediately before the click.
create or replace function public.request_team_catalog_resync(p_team uuid)
returns table(sync_job_id uuid, initial_sync_state text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); resolved_connection uuid; queued_job uuid;
begin
  if actor is null or not coalesce(private.team_role(p_team, actor) in ('owner', 'admin'), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select c.id into resolved_connection from public.team_drive_connections c
  where c.team_id = p_team and c.state = 'connected' for update;
  if resolved_connection is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select j.id into queued_job from private.catalog_sync_jobs j
  where j.connection_id = resolved_connection
    and j.job_kind in ('initial', 'reconcile')
    and j.requested_folder_id is null
    and j.phase = 'initial_scan'
    and not j.scan_initialized
    and j.state in ('pending', 'leased', 'retry')
  order by j.created_at desc limit 1;
  if queued_job is null then
    queued_job := public.service_enqueue_catalog_reconciliation(resolved_connection);
  end if;
  update public.team_drive_connections
  set initial_sync_state = 'scanning', last_synced_at = null, last_error_code = null
  where id = resolved_connection;
  perform private.record_team_audit(p_team, actor, 'drive.resynced',
    jsonb_build_object('connection_id', resolved_connection, 'state', 'scanning'),
    'succeeded', null);
  insert into public.team_catalog_events(team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
  return query select queued_job, 'scanning'::text;
end;
$$;

-- Expose the finite full-scan job to the same browser monitor as folder resyncs.
create or replace function public.get_team_folder_resync_status(p_team uuid, p_job uuid)
returns table(status text) language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not coalesce(private.can(p_team, 'view', auth.uid()), false) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query select case
    when c.state = 'detached' or j.state in ('failed', 'canceled') then 'failed'
    when j.state = 'succeeded' then 'succeeded'
    else 'running'
  end
  from private.catalog_sync_jobs j
  join public.team_drive_connections c on c.id = j.connection_id
  where j.id = p_job and c.team_id = p_team
    and (j.requested_folder_id is not null or j.job_kind in ('initial', 'reconcile'));
end;
$$;
notify pgrst, 'reload schema';
