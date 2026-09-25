-- Keep durable scan evidence only while it can affect a live result. One call
-- deletes at most 500 rows, so each cron invocation stays bounded.
create function private.cleanup_catalog_sync_retention(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  remaining integer := least(greatest(coalesce(p_limit, 500), 1), 500);
  removed integer;
  seen_count integer := 0;
  generation_count integer := 0;
  frontier_count integer := 0;
  job_count integer := 0;
begin
  -- A completed generation no longer needs its page-level observations.
  -- Abandoned generations get a 24-hour grace period, and only when no
  -- worker still owns a live lease for that job.
  with victims as (
    select s.ctid from private.catalog_scan_seen s
    join private.catalog_scan_generations g on g.id = s.generation
    join private.catalog_sync_jobs j on j.id = g.job_id
    where g.state = 'done' or (g.state = 'abandoned'
      and g.updated_at < pg_catalog.clock_timestamp() - interval '24 hours'
      and not (j.state = 'leased' and j.lease_expires_at > pg_catalog.clock_timestamp()))
      or (j.job_kind <> 'incremental' and j.state in ('succeeded', 'failed', 'canceled')
        and j.completed_at < pg_catalog.clock_timestamp() - interval '7 days')
    limit remaining
  )
  delete from private.catalog_scan_seen s using victims v where s.ctid = v.ctid;
  get diagnostics removed = row_count;
  seen_count := removed;
  remaining := remaining - removed;

  if remaining > 0 then
    -- Old finite jobs no longer have a status consumer. Drain their frontier
    -- before deleting generations or jobs; never select an incremental job.
    with victims as (
      select f.ctid from private.catalog_scan_frontier f
      join private.catalog_sync_jobs j on j.id = f.job_id
      where j.job_kind <> 'incremental' and j.state in ('succeeded', 'failed', 'canceled')
        and j.completed_at < pg_catalog.clock_timestamp() - interval '7 days'
      limit remaining
    )
    delete from private.catalog_scan_frontier f using victims v where f.ctid = v.ctid;
    get diagnostics removed = row_count;
    frontier_count := removed;
    remaining := remaining - removed;
  end if;

  if remaining > 0 then
    with victims as (
      select g.id from private.catalog_scan_generations g
      join private.catalog_sync_jobs j on j.id = g.job_id
      where not exists (select 1 from private.catalog_scan_frontier f where f.generation = g.id)
        and not exists (select 1 from private.catalog_scan_seen s where s.generation = g.id)
        and ((g.state = 'abandoned'
          and g.updated_at < pg_catalog.clock_timestamp() - interval '24 hours'
          and not (j.state = 'leased' and j.lease_expires_at > pg_catalog.clock_timestamp()))
          or (j.job_kind <> 'incremental' and j.state in ('succeeded', 'failed', 'canceled')
            and j.completed_at < pg_catalog.clock_timestamp() - interval '7 days'))
      limit remaining
    )
    delete from private.catalog_scan_generations g using victims v where g.id = v.id;
    get diagnostics removed = row_count;
    generation_count := removed;
    remaining := remaining - removed;
  end if;

  if remaining > 0 then
    with victims as (
      select j.id from private.catalog_sync_jobs j
      where j.job_kind <> 'incremental' and j.state in ('succeeded', 'failed', 'canceled')
        and j.completed_at < pg_catalog.clock_timestamp() - interval '7 days'
        and not exists (select 1 from private.catalog_scan_frontier f where f.job_id = j.id)
        and not exists (select 1 from private.catalog_scan_generations g where g.job_id = j.id)
      limit remaining
    )
    delete from private.catalog_sync_jobs j using victims v where j.id = v.id;
    get diagnostics removed = row_count;
    job_count := removed;
  end if;

  return pg_catalog.jsonb_build_object('seen', seen_count, 'frontier', frontier_count,
    'generations', generation_count, 'jobs', job_count);
end;
$$;

revoke all on function private.cleanup_catalog_sync_retention(integer)
  from public, anon, authenticated, service_role;

select cron.schedule('wishly-catalog-sync-retention', '*/5 * * * *',
  $cron$select private.cleanup_catalog_sync_retention()$cron$);
