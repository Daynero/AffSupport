-- Keep the legacy checkpoint for workers in flight during rollout. New workers
-- save every page under the same lease, then explicitly yield at their budget.
create or replace function public.service_save_catalog_sync_progress(
  p_job uuid, p_worker text, p_phase text, p_page_token text,
  p_change_token text, p_folder_queue jsonb,
  p_discovered_folders jsonb default '[]'::jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_phase not in ('initial_scan', 'change_replay', 'incremental', 'reconcile')
     or pg_catalog.jsonb_typeof(p_folder_queue) <> 'array'
     or pg_catalog.jsonb_typeof(p_discovered_folders) <> 'array' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update private.catalog_sync_jobs
  set phase = p_phase,
      cursor = pg_catalog.jsonb_build_object(
        'pageToken', p_page_token, 'changePageToken', p_change_token,
        'discoveredFolders', p_discovered_folders
      ),
      folder_queue = p_folder_queue,
      attempts = 0,
      last_error_code = null,
      updated_at = clock_timestamp()
  where id = p_job and state = 'leased' and lease_owner = p_worker
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;
revoke all on function public.service_save_catalog_sync_progress(uuid, text, text, text, text, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function public.service_save_catalog_sync_progress(uuid, text, text, text, text, jsonb, jsonb)
to service_role;

create or replace function public.service_release_catalog_sync_job(p_job uuid, p_worker text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update private.catalog_sync_jobs
  set state = 'pending', lease_owner = null, lease_expires_at = null,
      next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_job and state = 'leased' and lease_owner = p_worker
    and lease_expires_at > clock_timestamp();
  return found;
end;
$$;
revoke all on function public.service_release_catalog_sync_job(uuid, text)
from public, anon, authenticated;
grant execute on function public.service_release_catalog_sync_job(uuid, text) to service_role;

-- Serialize claims, not work. At most three live leases globally; each HTTP
-- worker still takes only one job, so slow Drive calls cannot lease a batch.
create or replace function private.claim_catalog_sync_jobs(
  p_worker text, p_limit integer default 5, p_lease_seconds integer default 60
)
returns setof private.catalog_sync_jobs
language plpgsql security definer set search_path = ''
as $$
declare
  slots integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(71101400) then return; end if;
  select greatest(0, 3 - count(*)::integer) into slots
  from private.catalog_sync_jobs
  where state = 'leased' and lease_expires_at > clock_timestamp();
  if slots = 0 then return; end if;
  return query
  with candidates as (
    select job.id
    from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection on connection.id = job.connection_id
    where (job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= clock_timestamp()))
      and job.next_attempt_at <= clock_timestamp()
      and connection.state <> 'detached'
    order by job.next_attempt_at, job.created_at
    for update of job skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update private.catalog_sync_jobs as job
  set state = 'leased', lease_owner = p_worker,
      lease_expires_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      next_attempt_at = clock_timestamp() + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
      attempts = job.attempts + 1, updated_at = clock_timestamp()
  from candidates where job.id = candidates.id
  returning job.*;
end;
$$;

-- Fast ticks do not produce HTTP requests when no connection has work due.
create or replace function private.invoke_catalog_sync_worker()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
begin
  if not exists (
    select 1 from private.catalog_sync_jobs as job
    join public.team_drive_connections as connection on connection.id = job.connection_id
    where connection.state <> 'detached' and job.next_attempt_at <= clock_timestamp()
      and (job.state in ('pending', 'retry')
        or (job.state = 'leased' and job.lease_expires_at <= clock_timestamp()))
  ) then return null; end if;
  if (select count(*) from private.catalog_sync_jobs
      where state = 'leased' and lease_expires_at > clock_timestamp()) >= 3
  then return null; end if;
  select secret.decrypted_secret into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or endpoint !~ '^https?://' or worker_secret is null
     or char_length(worker_secret) < 32 then return null; end if;
  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;

select cron.unschedule(job.jobid) from cron.job as job
where job.jobname = 'wishly-catalog-sync';
select cron.schedule('wishly-catalog-sync', '10 seconds',
  $cron$select private.invoke_catalog_sync_worker()$cron$);
