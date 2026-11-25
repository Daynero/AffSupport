-- Prod 2026-11-25 (generation 42f6e719, 20 PNG image creatives): every recovery invocation
-- was killed by the edge runtime's CPU limit after 3-6 images (HTTP 546), and the lease it
-- held kept the generation still for its full 180 s before the next minute's pass took it
-- again: ~4 minutes per ~4 images, ~20 minutes for twenty.
--
-- The image step now stops between images within its invocation's budget and hands the
-- generation on at once: this call releases the generation's lease and its catalog intent's
-- lease, makes it due now (state and stage unchanged — it is still running), and wakes the
-- recovery route through pg_net like 20261207399910 does. The dispatch is best-effort; the
-- per-minute pass remains the fallback, now without a lease to wait out.
begin;

create function public.service_yield_launch_generation(
 p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text
) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;
 endpoint text;worker_secret text;recovery_endpoint text;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id<>p_actor or g.state<>'running' or g.lease_owner<>p_owner or g.fence::text<>p_fence or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 update private.catalog_generation_intents set lease_expires_at=clock_timestamp(),updated_at=clock_timestamp()
  where team_id=p_team and request_key='launch:'||g.id::text||':catalog' and lease_expires_at>clock_timestamp()
   and state not in('registered','canceled');
 update public.team_launch_generations set lease_expires_at=clock_timestamp(),next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where id=g.id;
 begin
  select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
  from vault.decrypted_secrets as secret where secret.name='wishly_catalog_sync_url'
  order by secret.created_at desc limit 1;
  select secret.decrypted_secret into worker_secret
  from vault.decrypted_secrets as secret where secret.name='wishly_catalog_sync_secret'
  order by secret.created_at desc limit 1;
  if endpoint is not null and worker_secret is not null and char_length(worker_secret)>=32 then
   recovery_endpoint:=regexp_replace(endpoint,'/catalog-updater$','/drive-ops/launches/recover');
   if recovery_endpoint<>endpoint then
    perform net.http_post(
     url:=recovery_endpoint,
     headers:=pg_catalog.jsonb_build_object('content-type','application/json','x-catalog-sync-secret',worker_secret),
     body:='{}'::jsonb,timeout_milliseconds:=60000
    );
   end if;
  end if;
 exception when others then
  -- The per-minute pass takes the generation up; a dispatch failure never undoes the hand-off.
  null;
 end;
end $$;
revoke all on function public.service_yield_launch_generation(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_yield_launch_generation(uuid,uuid,uuid,text,text) to service_role;

commit;
