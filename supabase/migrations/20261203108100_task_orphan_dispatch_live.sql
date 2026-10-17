-- The existing minute cron now wakes its catalog worker for due task orphans.
-- Missing worker configuration leaves the intent waiting for the next minute.
-- An exhausted claim whose worker died must become an explicit failure.
create function private.settle_exhausted_task_orphans()
returns integer language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update private.team_task_orphan_intents i set state='failed',
    reason_code='RETRY_EXHAUSTED',lease_owner=null,lease_until=null,
    updated_at=clock_timestamp()
    where i.state='claimed' and i.attempt_count>=20
      and (i.lease_until is null or i.lease_until<=clock_timestamp());
  get diagnostics changed=row_count;
  return changed;
end $$;
revoke all on function private.settle_exhausted_task_orphans()
  from public, anon, authenticated;

create or replace function private.invoke_catalog_updater_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare endpoint text; worker_secret text; request_id bigint;
begin
  perform private.settle_exhausted_task_orphans();
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then null;
  end;
  if not exists (
    select 1 from public.team_catalog_updater_items item
    where item.update_interval is not null and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  ) and not exists (
    select 1 from public.team_catalog_updater_items item
    where item.round_due_at is not null and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies copy
    where copy.role='retired' and copy.next_delete_at <= clock_timestamp()
  ) and not exists (
    select 1 from private.team_task_orphan_intents intent
    where intent.cleanup_not_before <= clock_timestamp() and intent.attempt_count < 20
      and (intent.state='waiting' or
        (intent.state='claimed' and
          (intent.lease_until is null or intent.lease_until <= clock_timestamp())))
  ) then return null; end if;
  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets secret where secret.name='wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets secret where secret.name='wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret)<32 then return null; end if;
  select net.http_post(
    url := endpoint,
    headers := pg_catalog.jsonb_build_object('content-type','application/json',
      'x-catalog-sync-secret',worker_secret),
    body := '{"scheduled":true}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end $$;
