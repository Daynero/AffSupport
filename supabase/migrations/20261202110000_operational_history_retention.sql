-- Owner-approved seven-day retention for invalidation signals and cron history.
-- No audit, material, operation, file or active cron-run data is deleted.
create index team_catalog_events_retention_idx
  on public.team_catalog_events (occurred_at, id);

create or replace function private.cleanup_team_catalog_events(p_limit integer default 50)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  removed integer;
  cutoff timestamptz := pg_catalog.clock_timestamp() - interval '7 days';
begin
  with victims as (
    select e.id from public.team_catalog_events e
    where e.occurred_at < cutoff
    order by e.occurred_at, e.id
    limit least(greatest(coalesce(p_limit, 50), 1), 50)
    for update skip locked
  )
  delete from public.team_catalog_events e using victims v where e.id = v.id;
  get diagnostics removed = row_count;
  return removed;
end;
$$;

create or replace function private.cleanup_cron_history(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  removed integer;
  cutoff timestamptz := pg_catalog.clock_timestamp() - interval '7 days';
begin
  if pg_catalog.to_regclass('cron.job_run_details') is null then return 0; end if;
  -- Managed cron history may permit SELECT/DELETE without UPDATE, which
  -- SELECT FOR UPDATE would require. Serialize this cleaner without that grant.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('soty:cron-history-retention', 0)
  ) then return 0; end if;
  with victims as (
    select d.runid from cron.job_run_details d
    where d.end_time < cutoff
      and d.status in ('succeeded', 'failed')
    -- pg_cron owns this managed table. Reuse its runid primary key rather
    -- than requiring ownership to create an additional extension-table index.
    order by d.runid
    limit least(greatest(coalesce(p_limit, 500), 1), 500)
  )
  delete from cron.job_run_details d using victims v
  where d.runid = v.runid and d.end_time < cutoff and d.status in ('succeeded', 'failed');
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function private.cleanup_team_catalog_events(integer),
  private.cleanup_cron_history(integer) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-catalog-event-retention', '*/5 * * * *',
      $cron$select private.cleanup_team_catalog_events()$cron$);
    perform cron.schedule('soty-cron-history-retention', '2-57/5 * * * *',
      $cron$select private.cleanup_cron_history()$cron$);
  end if;
end;
$$;
