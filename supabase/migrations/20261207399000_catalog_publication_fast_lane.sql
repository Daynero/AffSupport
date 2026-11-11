-- Deferred video-link publication was published 2–4 minutes after its due time
-- on beta (QA 1.4.3): the publication scheduler only ran inside the per-minute
-- catalog-updater pass, a due job whose videos became ready waited for the next
-- such pass, and the per-minute invoker did not even look at publication jobs, so
-- on an otherwise quiet system a due link waited until some other catalog work
-- happened to be due.
--
-- This adds a publication-only lane: a ten-second cron that calls the
-- catalog-updater with {"publicationsOnly":true} while a publication is due, and a
-- trigger that wakes it at once when a catalog's video set becomes ready. The
-- lane runs the existing bounded scheduler; fences, leases and idempotency are
-- unchanged. The fast lane only covers recently due work, so a job that stays
-- waiting or uncertain falls back to the per-minute pass instead of costing
-- provider reads every ten seconds; that pass now also starts for any due
-- publication.
begin;

-- p_recent=true: only work that became due recently (the ten-second lane).
create function private.catalog_publication_work_due(p_recent boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from private.catalog_video_publication_jobs q
  join private.catalog_video_publication_policies p on p.catalog_material_id=q.catalog_material_id and p.revision=q.revision
  where q.next_attempt_at<=clock_timestamp()
   and (q.lease_until is null or q.lease_until<=clock_timestamp())
   and (p.mode='immediate' or (p.mode='scheduled' and p.due_at<=clock_timestamp()))
   and (
    (q.state in('waiting','preparing','retry_wait') and q.dispatched_at is null
     and (not p_recent or coalesce(p.due_at,q.created_at)>clock_timestamp()-interval '30 minutes'))
    or (q.state in('applying','verifying','unknown') and q.dispatched_at is not null and q.writer_fence is not null
     and (not p_recent or q.dispatched_at>clock_timestamp()-interval '5 minutes'))
   )
   and private.catalog_connection_usable(q.catalog_material_id)
 )
$$;
revoke all on function private.catalog_publication_work_due(boolean) from public,anon,authenticated,service_role;

-- p_force: dispatch even when the gate sees nothing (the ready-set wake, whose
-- job may have become due long ago). The function itself claims only due work.
create function private.invoke_catalog_publication_worker(p_force boolean default false) returns bigint
language plpgsql security definer set search_path='' as $$
declare endpoint text;worker_secret text;request_id bigint;
begin
 if not p_force and not private.catalog_publication_work_due(true) then return null;end if;
 select private.catalog_updater_endpoint(secret.decrypted_secret) into endpoint
 from vault.decrypted_secrets as secret where secret.name='wishly_catalog_sync_url'
 order by secret.created_at desc limit 1;
 select secret.decrypted_secret into worker_secret
 from vault.decrypted_secrets as secret where secret.name='wishly_catalog_sync_secret'
 order by secret.created_at desc limit 1;
 if endpoint is null or worker_secret is null or char_length(worker_secret)<32 then return null;end if;
 select net.http_post(
  url:=endpoint,
  headers:=pg_catalog.jsonb_build_object('content-type','application/json','x-catalog-sync-secret',worker_secret),
  body:='{"publicationsOnly":true}'::jsonb,timeout_milliseconds:=60000
 ) into request_id;
 return request_id;
end $$;
revoke all on function private.invoke_catalog_publication_worker(boolean) from public,anon,authenticated,service_role;

-- A video set becoming ready wakes the publication of its catalog at once.
create function private.catalog_ready_set_wakes_publication() returns trigger
language plpgsql security definer set search_path='' as $$
declare woke integer;
begin
 if new.state='ready' and old.state is distinct from 'ready' and new.catalog_material_id is not null then
  update private.catalog_video_publication_jobs q set next_attempt_at=clock_timestamp()
  from private.catalog_video_publication_policies p
  where q.catalog_material_id=new.catalog_material_id and p.catalog_material_id=q.catalog_material_id and p.revision=q.revision
   and q.dispatched_at is null and q.writer_fence is null and q.state in('waiting','preparing','retry_wait')
   and q.next_attempt_at>clock_timestamp()
   and (p.mode='immediate' or (p.mode='scheduled' and p.due_at<=clock_timestamp()));
  get diagnostics woke=row_count;
  if woke>0 or exists(
   select 1 from private.catalog_video_publication_jobs q
   join private.catalog_video_publication_policies p on p.catalog_material_id=q.catalog_material_id and p.revision=q.revision
   where q.catalog_material_id=new.catalog_material_id and q.dispatched_at is null and q.state in('waiting','preparing','retry_wait')
    and (p.mode='immediate' or (p.mode='scheduled' and p.due_at<=clock_timestamp()))
  ) then
   begin
    perform private.invoke_catalog_publication_worker(true);
   exception when others then
    -- The ten-second lane picks it up; a dispatch failure never rolls back the
    -- video set becoming ready.
    null;
   end;
  end if;
 end if;
 return null;
end $$;
revoke all on function private.catalog_ready_set_wakes_publication() from public,anon,authenticated,service_role;
create trigger catalog_ready_set_wakes_publication after update of state on private.catalog_video_sets
 for each row execute function private.catalog_ready_set_wakes_publication();

-- The per-minute invoker also starts for any due publication, however old.
do $invoker$
declare d text;
begin
 select pg_get_functiondef('private.invoke_catalog_updater_worker()'::regprocedure) into d;
 if strpos(d,$find$  ) and not launch_work_due then$find$)=0 then raise exception 'PUBLICATION_INVOKER_PATCH_MISSING';end if;
 d:=replace(d,$find$  ) and not launch_work_due then$find$,$replace$  ) and not launch_work_due and not private.catalog_publication_work_due(false) then$replace$);
 execute d;
end $invoker$;

select cron.schedule('soty-catalog-publication','10 seconds',$cron$select private.invoke_catalog_publication_worker()$cron$);

commit;
