-- Make a stopped catalog worker visible and make "the current connection"
-- unambiguous. The 2026-09-15 outage kept returning success from pg_cron
-- while the worker itself returned 503, leaving first scans spinning forever.
--
-- Forward-only. Reverse steps are in ROLLBACK.md.

create or replace function private.invoke_catalog_sync_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1
    from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection on connection.id = job.connection_id
    where connection.state <> 'detached'
      and job.next_attempt_at <= pg_catalog.clock_timestamp()
      and (
        job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= pg_catalog.clock_timestamp())
      )
  ) then
    return null;
  end if;

  if (
    select count(*)
    from private.catalog_sync_jobs
    where state = 'leased' and lease_expires_at > pg_catalog.clock_timestamp()
  ) >= 3 then
    return null;
  end if;

  select secret.decrypted_secret into endpoint
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc
  limit 1;

  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc
  limit 1;

  if endpoint is null or endpoint !~ '^https?://' then
    raise exception 'CATALOG_SYNC_CONFIG_INVALID: wishly_catalog_sync_url is missing or invalid'
      using errcode = 'P0001';
  end if;
  if worker_secret is null or char_length(worker_secret) < 32 then
    raise exception 'CATALOG_SYNC_CONFIG_INVALID: wishly_catalog_sync_secret is missing or too short'
      using errcode = 'P0001';
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret
    ),
    body := '{"scheduled":true}'::jsonb,
    timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

create or replace function public.get_drive_connection_status(p_team uuid)
returns table (
  connection_id uuid,
  state text,
  root_folder_name text,
  drive_kind text,
  initial_sync_state text,
  last_synced_at timestamptz,
  last_error_code text,
  connected_account_email text,
  capabilities_checked_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller_role text := private.team_role(p_team, auth.uid());
begin
  if caller_role is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  return query
  select connection.id,
         coalesce(connection.state, 'none'),
         connection.root_folder_name,
         connection.drive_kind,
         coalesce(connection.initial_sync_state, 'not_started'),
         connection.last_synced_at,
         connection.last_error_code,
         case when caller_role in ('owner', 'admin') then credential.google_account_email end,
         case when caller_role in ('owner', 'admin') then connection.capabilities_checked_at end
  from (select 1) as singleton
  left join lateral (
    select drive.*
    from public.team_drive_connections as drive
    where drive.team_id = p_team and drive.state <> 'detached'
    order by drive.connected_at desc nulls last
    limit 1
  ) as connection on true
  left join private.google_drive_credentials as credential
    on credential.id = connection.credential_id;
end;
$$;

revoke all on function public.get_drive_connection_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.get_drive_connection_status(uuid) to authenticated;
