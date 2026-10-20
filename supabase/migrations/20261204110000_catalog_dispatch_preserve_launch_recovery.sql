-- Profile-aware catalog scheduling must retain the existing Launch settlement,
-- cleanup and authenticated recovery wake-ups sharing this dispatcher.
-- Only the function body changes; no profiles, schedules or credentials change.
create or replace function private.invoke_catalog_updater_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  worker_secret text;
  request_id bigint;
  recovery_due boolean := private.launch_catalog_recovery_due();
  launch_work_due boolean := private.launch_settlement_due() or private.launch_cleanup_due() or recovery_due;
  recovery_endpoint text;
begin
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then
    -- Housekeeping must not prevent dispatch of accepted work.
    null;
  end;

  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null and not item.reconciliation_required
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null and item.next_attempt_at <= clock_timestamp()
      and not item.reconciliation_required
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from private.catalog_update_reconciliations as pending
    where pending.next_check_at <= clock_timestamp()
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) and not launch_work_due then
    return null;
  end if;

  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
      and not launch_work_due then
    return null;
  end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
  end if;

  if recovery_due then
    recovery_endpoint := regexp_replace(endpoint, '/catalog-updater$', '/drive-ops/launches/recover');
    if recovery_endpoint <> endpoint then
      perform net.http_post(
        url := recovery_endpoint,
        headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
          'x-catalog-sync-secret', worker_secret),
        body := '{}'::jsonb, timeout_milliseconds := 60000
      );
    end if;
  end if;

  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type', 'application/json',
      'x-catalog-sync-secret', worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end;
$$;
