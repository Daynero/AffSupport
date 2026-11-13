--052 Retention is policy-owned and survives team deletion. Existing physical purge transport
--keeps its old reason vocabulary; policy_reason records the independent policy_retirement cause.
alter table private.catalog_image_purges add column policy_reason text;
create function private.catalog_global_purge_hold() returns trigger language plpgsql security definer set search_path='' as $$
declare deadline timestamptz;
begin
 select max(delete_after) into deadline from private.catalog_image_retirements where kind='object_purge' and object_key=new.object_key and state<>'verified_deleted';
 if deadline is not null then new.not_before:=greatest(new.not_before,deadline);end if;
 return new;
end $$;
revoke all on function private.catalog_global_purge_hold() from public,anon,authenticated,service_role;
create trigger catalog_global_purge_hold before insert or update on private.catalog_image_purges for each row execute function private.catalog_global_purge_hold();

create function public.service_catalog_global_retirement_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_global_policy%rowtype;r private.catalog_image_retirements%rowtype;q private.catalog_image_purges%rowtype;count_pending bigint;
begin
 select * into c from private.catalog_global_policy where singleton;
 if c.activated_at is null or clock_timestamp()<c.delete_after then return jsonb_build_object('retained',true);end if;
 if not pg_try_advisory_xact_lock(hashtextextended('catalog-global-retirement',520)) then return jsonb_build_object('busy',true);end if;
 update private.catalog_global_policy set state='cleanup_running' where singleton and state<>'cleanup_complete';
 select * into r from private.catalog_image_retirements where epoch=c.epoch and state not in('verified_deleted','metadata_unlinked') and next_attempt_at<=clock_timestamp()
  order by case when kind='metadata_unlink' then 0 else 1 end,id limit 1 for update skip locked;
 if found then
  if r.kind='metadata_unlink' then
   -- External originals/permissions are never touched; only private application references go.
   update public.team_product_catalog_settings set image_link=null where team_id=r.team_scope;
   delete from public.team_product_catalog_image_sources where team_id=r.team_scope;
   update private.catalog_image_retirements set state='metadata_unlinked',verified_at=clock_timestamp(),code=null where id=r.id;
   insert into private.catalog_global_journal(stage,counts) values('external_untouched',jsonb_build_object('metadata',1));
  else
   select * into q from private.catalog_image_purges where bucket_kind='public' and object_key=r.object_key;
   if q.id is not null and q.state='complete' and not q.uncertain_write then
    delete from public.team_catalog_image_pool_entries where publication_id=r.publication_id;
    update private.catalog_image_retirements set state='verified_deleted',verified_at=clock_timestamp(),code=null,purge_id=q.id where id=r.id;
    insert into private.catalog_global_journal(stage,counts) values('retirement_verified',jsonb_build_object('objects',1));
   else
    insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,policy_reason,not_before)
     values(r.publication_id,r.team_scope,'public',r.object_key,'explicit_revoke','policy_retirement',c.delete_after)
     on conflict(bucket_kind,object_key) do update set policy_reason='policy_retirement',not_before=greatest(catalog_image_purges.not_before,excluded.not_before)
     returning * into q;
    update private.catalog_image_publications set state='revoking' where id=r.publication_id and state='ready';
    update private.catalog_image_retirements set state=case when q.state='unknown' or q.attempts>=8 then 'unknown' else 'pending' end,purge_id=q.id,
     code=case when q.state='unknown' or q.attempts>=8 then 'GLOBAL_IMAGE_CLEANUP_UNKNOWN' else null end,next_attempt_at=clock_timestamp()+interval '15 minutes' where id=r.id;
   end if;
  end if;
 end if;
 select count(*) into count_pending from private.catalog_image_retirements where epoch=c.epoch and state not in('verified_deleted','metadata_unlinked');
 if count_pending=0 then update private.catalog_global_policy set state='cleanup_complete' where singleton;end if;
 return jsonb_build_object('pending',count_pending);
end $$;
revoke all on function public.service_catalog_global_retirement_tick() from public,anon,authenticated;
grant execute on function public.service_catalog_global_retirement_tick() to service_role;

-- Admission shares045's lock and counts both worker families, preventing8+8 concurrency.
do $patch$
declare definition text;old_source text;new_source text;
begin
 definition:=pg_get_functiondef('public.service_catalog_image_claim_v2(text)'::regprocedure);
 old_source:='if (select count(*) from private.catalog_image_import_entries where lease_until>at)+(select count(*) from private.catalog_image_import_intents where lease_until>at)>=8';
 new_source:='if (select count(*) from private.catalog_image_import_entries where lease_until>at)+(select count(*) from private.catalog_image_import_intents where lease_until>at)+(select count(*) from private.catalog_global_entries where lease_until>at)>=8';
 if position(old_source in definition)=0 then raise exception '052 expected045 admission seam';end if;
 definition:=replace(definition,old_source,new_source);
 definition:=replace(definition,'begin',E'begin\n if private.catalog_global_retired() then return null;end if;');
 execute definition;
 definition:=pg_get_functiondef('public.service_catalog_image_purge_claim_v2()'::regprocedure);
 definition:=replace(definition,'begin',E'begin\n if exists(select1 from private.catalog_global_policy where state=''draining'') then return null;end if;');
 definition:=replace(definition,'select1','select 1');execute definition;
end $patch$;

create function private.invoke_catalog_global_images_worker() returns bigint language plpgsql security definer set search_path='' as $$
declare endpoint text;secret text;rid bigint;
begin
 -- Absence of isolated provider configuration is idle, never auto-provisioning or T0.
 if not exists(select 1 from private.catalog_global_policy where environment is not null) then return null;end if;
 perform public.service_catalog_global_retirement_tick();
 select regexp_replace(decrypted_secret,'/catalog-sync/?$','/catalog-global-images/worker') into endpoint from vault.decrypted_secrets where name='wishly_catalog_sync_url' order by created_at desc limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='wishly_catalog_sync_secret' order by created_at desc limit 1;
 if endpoint is null or secret is null or length(secret)<32 or endpoint !~ '^https?://[^/]+/functions/v1/catalog-global-images/worker$' then return null;end if;
 select net.http_post(url:=endpoint,headers:=jsonb_build_object('content-type','application/json','x-catalog-sync-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=65000) into rid;
 return rid;
end $$;
revoke all on function private.invoke_catalog_global_images_worker() from public,anon,authenticated,service_role;
-- Chain only pending import work. Idle probes keep the bounded cron cadence.
create function public.service_catalog_global_kick() returns bigint language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.catalog_global_entries e join private.catalog_global_jobs j on j.id=e.job_id
  where j.state in('sealed','running','partial','unknown') and e.state in('staged','validating','publishing','verifying','unknown')
   and e.next_attempt_at<=clock_timestamp() and e.attempts<8 and (e.lease_until is null or e.lease_until<=clock_timestamp())) then return null;end if;
 return private.invoke_catalog_global_images_worker();
end $$;
revoke all on function public.service_catalog_global_kick() from public,anon,authenticated;
grant execute on function public.service_catalog_global_kick() to service_role;
select cron.schedule('soty-catalog-global-images','30 seconds',$cron$select private.invoke_catalog_global_images_worker()$cron$);
alter table private.catalog_image_retirements add column next_attempt_at timestamptz not null default now();

-- Narrow analytics projections: SELECT only, no private hashes/keys/tokens/owner associations.
create view public.analytics_catalog_global_images with(security_invoker=false) as
 select i.id image_id,i.environment,i.state,i.active,i.mime,i.classification,i.created_at,i.content_verified_at,i.content_expires_at,
 i.content_proof_revision,i.issued_seq::text issued_slots_total,i.confirmed_uses::text confirmed_uses_total,i.last_confirmed_at,
 (i.issued_seq/200+1)::text current_generation,(i.issued_seq%200)::int issued_in_generation,
 coalesce((select a.confirmed_uses from private.catalog_global_aliases a where a.image_id=i.id and a.generation=i.issued_seq/200+1),0) confirmed_in_generation,
 (select count(*)::int from private.catalog_global_aliases a where a.image_id=i.id and a.generation between i.issued_seq/200+2 and i.issued_seq/200+3 and a.state='ready' and a.key_version=any(p.accepted_key_versions)) next_aliases_ready,
 (select a.public_url from private.catalog_global_aliases a where a.image_id=i.id and a.state='ready' order by a.generation limit 1) public_preview_url,
 (select count(*)::int from private.catalog_global_recipes r where r.state='unknown' and r.images @> jsonb_build_array(jsonb_build_object('imageId',i.id))) unknown_operations
 from private.catalog_global_images i cross join private.catalog_global_policy p where p.singleton;
create view public.analytics_catalog_global_policy with(security_invoker=false) as
 select environment,epoch::text policy_epoch,state,activated_at,delete_after,routing_revision,serving_verified_at,serving_revision,manifest_digest,
  (select count(*)::int from private.catalog_global_recipes where state in('issued','unknown')) pending_operations,
  (select count(*)::int from private.catalog_global_jobs where state in('collecting','sealed','running','unknown')) pending_jobs
 from private.catalog_global_policy where singleton;
create view public.analytics_catalog_global_cleanup with(security_invoker=false) as
 select r.id,r.epoch::text epoch,r.kind,r.state,r.delete_after,r.verified_at,r.code,
 coalesce(q.attempts,0) attempts,q.state purge_state,
 case when r.kind='metadata_unlink' and r.state='metadata_unlinked' then true else false end external_untouched
 from private.catalog_image_retirements r left join private.catalog_image_purges q on q.id=r.purge_id;
create view public.analytics_catalog_global_journal with(security_invoker=false) as
 select 'global-image:'||seq::text evidence_id,flow_id,attempt_id,team_id,catalog_id,image_id,alias_id,stage,code,occurred_at,received_at,counts,actor_id
 from private.catalog_global_journal;
revoke all on public.analytics_catalog_global_images,public.analytics_catalog_global_policy,public.analytics_catalog_global_cleanup,public.analytics_catalog_global_journal from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_global_images,public.analytics_catalog_global_policy,public.analytics_catalog_global_cleanup,public.analytics_catalog_global_journal to wishly_analytics_ro;
 end if;
end $$;

create view public.analytics_catalog_global_coverage with(security_invoker=false) as
 select 1 schema_version,
 exists(select 1 from pg_trigger where tgrelid='private.catalog_global_jobs'::regclass and tgname='catalog_global_job_journal' and tgenabled in('O','A'))
 and exists(select 1 from pg_trigger where tgrelid='private.catalog_global_entries'::regclass and tgname='catalog_global_entry_journal' and tgenabled in('O','A'))
 and exists(select 1 from pg_trigger where tgrelid='public.team_catalog_update_attempts'::regclass and tgname='catalog_global_attempt_completed' and tgenabled in('O','A'))
 and exists(select 1 from pg_trigger where tgrelid='private.catalog_generation_intents'::regclass and tgname='catalog_global_catalog_registered' and tgenabled in('O','A')) capture_enabled;
revoke all on public.analytics_catalog_global_coverage from public,anon,authenticated,service_role;
do $$ begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_catalog_global_coverage to wishly_analytics_ro;end if;end $$;
create function private.prune_catalog_global_journal() returns bigint language plpgsql security definer set search_path='' as $$
declare n bigint;
begin
 with expired as(select seq from private.catalog_global_journal where received_at<clock_timestamp()-interval '30 days' order by seq limit 1000)
 delete from private.catalog_global_journal j using expired e where j.seq=e.seq;
 get diagnostics n=row_count;return n;
end $$;
revoke all on function private.prune_catalog_global_journal() from public,anon,authenticated,service_role;
select cron.schedule('soty-catalog-global-journal','*/10 * * * *',$cron$select private.prune_catalog_global_journal()$cron$);
-- Register every new consumer with the existing conservative material-reference fence.
-- No table is exempted from the platform's coverage inventory.
do $fence$ declare t record;begin
 for t in select * from private.task_cleanup_reference_tables() where table_name like 'catalog_global_%' or table_name='catalog_image_retirements' loop
  if not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and g.tgname='task_cleanup_reference_fence') then
   execute format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
  end if;
 end loop;
end $fence$;
