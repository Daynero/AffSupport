-- 264000 made a creation due the moment its last video registered, but the
-- pickup still waited for the next one-minute recovery pass when the dialog was
-- closed (beta 2026-11-11: set 7d448756 ready 10:46:24, catalog 10:49:14).
--
-- When a set becoming ready wakes its creation, the recovery route is now
-- dispatched at once through pg_net (sent after the set's transaction commits),
-- with the same endpoint and worker secret the per-minute dispatcher uses. The
-- dispatch is best-effort: a missing secret or any pg_net error never blocks
-- the set update, and the per-minute pass remains the fallback.
begin;
create or replace function private.catalog_ready_set_wakes_creation() returns trigger language plpgsql security definer set search_path='' as $$
declare woke integer;endpoint text;worker_secret text;recovery_endpoint text;
begin
 if new.state='ready' and old.state is distinct from 'ready' and new.catalog_intent_id is not null then
  update private.catalog_generation_intents set next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=new.catalog_intent_id and team_id=new.team_id
   and state in('interrupted','create_started','created','finalized')
   and (lease_expires_at is null or lease_expires_at<=clock_timestamp())
   and next_attempt_at>clock_timestamp();
  get diagnostics woke=row_count;
  if woke>0 then
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
    -- The per-minute pass picks the creation up; a dispatch failure never
    -- rolls back the video set becoming ready.
    null;
   end;
  end if;
 end if;
 return null;
end $$;
revoke all on function private.catalog_ready_set_wakes_creation() from public,anon,authenticated,service_role;
commit;
