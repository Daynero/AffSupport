-- Resume only accepted work or interrupted transient/unknown outcomes, not terminal failures.
create function public.service_list_launch_catalog_recovery(p_limit integer default 3) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'generationId',x.id,'actorId',x.actor_id)) from (
  select g.id,g.team_id,g.actor_id from public.team_launch_generations g
  join public.team_launch_revisions r on r.id=g.revision_id
  join public.team_launches l on l.id=g.launch_id and l.archived_at is null
  where r.config->>'method'='catalog' and r.config->'catalog'->>'restitchEnabled'='false'
   and g.state in('accepted','running','interrupted')
   and (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and (g.safe_error_code is null or g.safe_error_code in('DRIVE_UNAVAILABLE','RATE_LIMITED','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','GROUP_RECONCILING','LEASE_MISMATCH','UNKNOWN'))
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
    and i.request_key='launch:'||g.id::text||':catalog' and i.lease_expires_at>clock_timestamp())
  order by coalesce(g.next_attempt_at,g.created_at),g.id limit p_limit
 ) x),'[]');
end $$;
create function private.launch_catalog_recovery_due() returns boolean language sql stable security definer set search_path='' as $$
 select jsonb_array_length(public.service_list_launch_catalog_recovery(1))>0
$$;
revoke all on function public.service_list_launch_catalog_recovery(integer),private.launch_catalog_recovery_due() from public,anon,authenticated;
grant execute on function public.service_list_launch_catalog_recovery(integer) to service_role;

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
  recovery_due boolean:=private.launch_catalog_recovery_due();
  recovery_endpoint text;
begin
  begin
    perform private.retire_unused_restitch_copies();
  exception when others then
    -- Housekeeping never stops a round from being dispatched.
    null;
  end;

  if not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.update_interval is not null
      and item.next_run_at <= clock_timestamp()
      and item.round_due_at is null
  ) and not exists (
    select 1 from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
  ) and not exists (
    select 1 from public.team_catalog_restitch_copies as copy
    where copy.role = 'retired' and copy.next_delete_at <= clock_timestamp()
  ) and not private.launch_settlement_due() and not private.launch_cleanup_due() and not recovery_due then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  and not private.launch_settlement_due() and not private.launch_cleanup_due() and not recovery_due then return null; end if;

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
    recovery_endpoint:=regexp_replace(endpoint,'/catalog-updater$','/drive-ops/launches/recover');
    if recovery_endpoint<>endpoint then
      perform net.http_post(url:=recovery_endpoint,headers:=jsonb_build_object('content-type','application/json','x-catalog-sync-secret',worker_secret),body:='{}'::jsonb,timeout_milliseconds:=60000);
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
