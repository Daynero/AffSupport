-- Beta 2026-11-11 (QA round 9): a catalog launch interrupted while its video set
-- was still preparing sat in 'interrupted' from 19:51:01 to 19:57:00, although
-- the videos were ready at 19:52:25: its catalog step waited on the
-- generation's next_attempt_at backoff, while the dialog said it would
-- continue «за мить».
--
-- When a video set becomes ready, a catalog launch generation that is waiting
-- on its own backoff is made due at once, and the launch recovery route is
-- dispatched through pg_net, exactly like a creation (20261207281000). The
-- dispatch is best-effort: a missing secret or any pg_net error never blocks the
-- set update, and the per-minute recovery pass remains the fallback.
begin;

create function private.catalog_ready_set_wakes_launch() returns trigger language plpgsql security definer set search_path='' as $$
declare woke integer;endpoint text;worker_secret text;recovery_endpoint text;
begin
 if new.state='ready' and old.state is distinct from 'ready' then
  update public.team_launch_generations g set next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
  from private.launch_catalog_video_contexts c
  where c.video_set_id=new.id and c.team_id=new.team_id and g.id=c.generation_id and g.team_id=new.team_id
   and g.state in('accepted','running','interrupted')
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and g.next_attempt_at>clock_timestamp();
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
    -- The per-minute pass picks the launch up; a dispatch failure never rolls
    -- back the video set becoming ready.
    null;
   end;
  end if;
 end if;
 return null;
end $$;
revoke all on function private.catalog_ready_set_wakes_launch() from public,anon,authenticated,service_role;

create trigger catalog_ready_set_wakes_launch after update of state on private.catalog_video_sets
 for each row execute function private.catalog_ready_set_wakes_launch();

commit;
