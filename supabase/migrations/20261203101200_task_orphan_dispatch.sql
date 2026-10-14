-- The Launches source reference inventory is not yet in this branch. Due
-- intents settle visibly as unverified instead of waiting forever or making
-- an unsafe provider call. The scheduled catalog updater invokes this sweep.
create function private.sweep_task_orphan_uncertainty(p_limit integer default 50)
returns integer language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  with due as (
    select id from private.team_task_orphan_intents
    where cleanup_not_before <= clock_timestamp()
      and (state='waiting' or (state='claimed' and lease_until < clock_timestamp()))
    order by cleanup_not_before, id
    for update skip locked
    limit least(greatest(p_limit,1),100)
  )
  update private.team_task_orphan_intents i
    set state='cleanup_unverified', reason_code='LAUNCH_REFERENCE_UNVERIFIED',
        lease_until=null, updated_at=clock_timestamp()
    from due where i.id=due.id;
  get diagnostics changed = row_count;
  return changed;
end $$;
revoke all on function private.sweep_task_orphan_uncertainty(integer)
  from public, anon, authenticated;

-- The existing minute cron calls this function even when no updater round is
-- due. Settle task intents before its early return, without a second scheduler.
create or replace function private.invoke_catalog_updater_worker()
returns bigint language plpgsql security definer set search_path = '' as $$
declare endpoint text; worker_secret text; request_id bigint;
begin
  perform private.sweep_task_orphan_uncertainty();
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
  ) then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12 then return null; end if;
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
