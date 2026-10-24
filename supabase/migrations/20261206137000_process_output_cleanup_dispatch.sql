begin;
create function private.process_output_cleanup_due()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from private.process_upload_ownership u join public.team_operations o on o.id=u.operation_id
  where o.kind='process' and o.result_material_id is null and u.upload_state<>'published' and (
   (o.state in('failed','canceled') and u.upload_state='started' and u.cleanup_state in('pending','waiting','claimed')
    and (u.next_attempt_at is null or u.next_attempt_at<=clock_timestamp())
    and (u.lease_expires_at is null or u.lease_expires_at<=clock_timestamp()))
   or (o.state in('pending','running') and u.handoff_expires_at<=clock_timestamp()
    and not exists(select 1 from private.team_transfer_grants g where g.operation_id=o.id and g.actor_id=o.actor_id
     and g.team_id=o.team_id and g.purpose='finalize' and g.revoked_at is null and g.expires_at>clock_timestamp()))
  )
 )
$$;
revoke all on function private.process_output_cleanup_due() from public,anon,authenticated,service_role;

-- Retain catalog, task and Launch dispatch; process cleanup also runs without a browser.
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
  process_work_due boolean := private.process_output_cleanup_due();
  launch_work_due boolean := private.launch_settlement_due() or private.launch_cleanup_due() or recovery_due or process_work_due or exists(select 1 from private.task_attachment_cleanup where state in ('waiting','claimed') and not_before<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()));
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

commit;
