-- Hosted recovery's provider-free settlement path. Incomplete/uncertain provider work
-- is deliberately excluded: it needs ownership-aware recovery, never blind recreation.
create function private.launch_settlement_due() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_generations g
 join public.team_launch_revisions r on r.id=g.revision_id
 join public.team_launches l on l.id=g.launch_id and l.archived_at is null
 where (g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
 and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
 and ((g.state in('accepted','running','interrupted') and
   (r.config->>'method'='other' or exists(select 1 from private.catalog_generation_intents i
     where i.team_id=g.team_id and i.actor_id=g.actor_id and i.state='registered'
     and i.request_key='launch:'||g.id::text||':catalog')))
 or (g.state='cancel_requested' and
   not exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id
     and i.request_key='launch:'||g.id::text||':catalog') and
   not exists(select 1 from public.team_launch_generation_steps s where s.generation_id=g.id
     and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null)))))
$$;
create function public.service_settle_launch_batch(p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 claimed jsonb;owner text:=gen_random_uuid()::text;n integer:=0;done integer:=0;canceled integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id,x.team_id from public.team_launch_generations x
  join public.team_launch_revisions r on r.id=x.revision_id
  where (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and ((x.state in('accepted','running','interrupted') and
    (r.config->>'method'='other' or exists(select 1 from private.catalog_generation_intents i
     where i.team_id=x.team_id and i.actor_id=x.actor_id and i.state='registered'
      and i.request_key='launch:'||x.id::text||':catalog')))
    or (x.state='cancel_requested' and
      not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
      and not exists(select 1 from public.team_launch_generation_steps s where s.generation_id=x.id
       and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null))))
  order by coalesce(x.next_attempt_at,x.created_at),x.id limit p_limit*4
 loop
  exit when n>=p_limit;
  -- Every Launch mutation takes aggregate before generation.
  select * into l from public.team_launches where id=candidate.launch_id and archived_at is null for update skip locked;
  if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state in('succeeded','canceled','failed','partial','waiting_dependency','canceled_with_cleanup_pending')
    or g.lease_expires_at>clock_timestamp() or g.next_attempt_at>clock_timestamp() then continue;end if;
  if g.state='cancel_requested' then
   if exists(select 1 from private.catalog_generation_intents i where i.team_id=g.team_id and i.request_key='launch:'||g.id::text||':catalog')
    or exists(select 1 from public.team_launch_generation_steps s where s.generation_id=g.id
      and (s.team_operation_id is not null or s.provider_file_id is not null or s.result_material_id is not null)) then continue;end if;
   n:=n+1;
   update public.team_launch_generations set state='canceled',stage='cancel',state_version=state_version+1,
    lease_owner=null,lease_expires_at=null,next_attempt_at=null,fence=fence+1,updated_at=clock_timestamp() where id=g.id;
   update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp()
    where generation_id=g.id and state in('pending','running');
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
   canceled:=canceled+1;continue;
  end if;
  n:=n+1;
  if not private.can(g.team_id,'edit',g.actor_id) then
   update public.team_launch_generations set state='failed',safe_error_code='PERMISSION_DENIED',retryable=false,
    state_version=state_version+1,next_attempt_at=null,updated_at=clock_timestamp() where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);continue;
  end if;
  claimed:=public.service_claim_launch_generation(g.team_id,g.id,g.actor_id,owner);
  if (select config->>'method' from public.team_launch_revisions where id=g.revision_id)='other'
    or public.service_restore_registered_launch_catalog(g.team_id,g.id,g.actor_id,owner,claimed->>'fence') then
   perform public.service_publish_launch_generation(g.team_id,g.id,g.actor_id,claimed->>'fence');done:=done+1;
  end if;
 end loop;
 return jsonb_build_object('examined',n,'completed',done,'canceled',canceled);
end $$;
revoke all on function private.launch_settlement_due(),public.service_settle_launch_batch(integer) from public,anon,authenticated;
grant execute on function public.service_settle_launch_batch(integer) to service_role;

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
  ) and not private.launch_settlement_due() then return null; end if;
  if (select count(*) from public.team_catalog_updater_items
      where lease_expires_at > clock_timestamp()) >= 12
  and not private.launch_settlement_due() then return null; end if;

  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name = 'wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is null or worker_secret is null or char_length(worker_secret) < 32 then
    return null;
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
