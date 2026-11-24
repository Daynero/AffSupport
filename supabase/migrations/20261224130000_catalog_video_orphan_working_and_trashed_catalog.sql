-- Production 2026-11-24 (onemedia): a catalog created with five re-stitched videos stopped at
-- «Готово відео 1 з 5» for good, and deleting the catalog did not stop its videos either.
--
-- 1) The second variant was marked 'working', and its admission was lost before the process
--    operation existed. release_silent_catalog_video_variants judged silence only through that
--    operation, so the variant was skipped for ever; every takeover was then refused as
--    PROCESS_RESULT_UNCERTAIN and the agent gave up after its hour of retries.
--    A 'working' variant with no operation, no heartbeat and no execution fence is now released
--    like any silent one: its silence is observed first, and once it has lasted the caller's
--    silence window it goes back to the queue (retry_failed_catalog_video_variant requeues an
--    operation-less 'unknown' variant).
-- 2) Moving a catalog to the trash (or losing it from Drive) now stops its unfinished video sets
--    — the creation's and the update rounds' — the same way «Скасувати створення відео» does:
--    'cancel_requested' while a variant may still run, 'canceled' otherwise. A ready set keeps
--    its registered videos. The trash itself never waits on this.
-- 3) Unfinished sets of catalogs already in the trash are stopped once.

do $patch$
declare d text;
begin
 select pg_get_functiondef('private.release_silent_catalog_video_variants(uuid,interval)'::regprocedure) into d;
 if strpos(d,$find$  select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
$find$)=0 then raise exception 'CATALOG_ORPHAN_WORKING_PATCH_MISSING';end if;
 d:=replace(d,$find$  select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
$find$,$replace$  select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
  -- A 'working' variant whose admission was lost before its operation existed: nothing can
  -- still run it, so after an observed silence it is requeued instead of skipped for ever.
  if o.id is null and v.state='working' and v.operation_id is null and v.heartbeat_at is null
   and not exists(select 1 from private.team_recovery_execution_fences f where f.team_id=s.team_id and f.job_id=v.request_id) then
   if v.silence_observed_at is null or v.silence_observed_at>clock_timestamp() then
    update private.catalog_video_variants set silence_observed_at=clock_timestamp()
     where video_set_id=p_set and video_variant_index=v.video_variant_index;
    continue;
   end if;
   if v.silence_observed_at>clock_timestamp()-p_silence then continue;end if;
   update private.catalog_video_variants set state='unknown'
    where video_set_id=p_set and video_variant_index=v.video_variant_index and state='working';
   answer:=private.retry_failed_catalog_video_variant(p_set,v.video_variant_index);
   if answer->>'kind' in('requeued','retry','registered') then n:=n+1;end if;
   continue;
  end if;
$replace$);
 execute d;
end $patch$;

create function private.cancel_unfinished_video_sets_of_catalog(p_team uuid, p_catalog uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 update private.catalog_video_sets x
  set state=case when exists(select 1 from private.catalog_video_variants v where v.video_set_id=x.id and v.state in('working','unknown'))
                 then 'cancel_requested' else 'canceled' end,
      revision=revision+1,updated_at=clock_timestamp()
  where x.team_id=p_team and x.state in('accepted','preparing','unknown')
   and (x.catalog_material_id=p_catalog
    or x.catalog_intent_id in(select g.id from private.catalog_generation_intents g where g.team_id=p_team
     and (g.checkpoint->>'materialId'=p_catalog::text or g.result#>>'{catalog,materialId}'=p_catalog::text)));
 get diagnostics n=row_count;
 return n;
end $$;
revoke all on function private.cancel_unfinished_video_sets_of_catalog(uuid,uuid) from public,anon,authenticated,service_role;

create function private.catalog_removed_cancels_video_sets()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Only a product catalog has video sets; a folder trashed with thousands of files pays one
 -- primary-key probe per file. Never let stopping the videos stop the trash itself.
 if not exists(select 1 from public.team_product_catalogs where material_id=new.id) then return null;end if;
 begin
  perform private.cancel_unfinished_video_sets_of_catalog(new.team_id,new.id);
 exception when others then null;
 end;
 return null;
end $$;
revoke all on function private.catalog_removed_cancels_video_sets() from public,anon,authenticated,service_role;
create trigger catalog_removed_cancels_video_sets
 after update of lifecycle, missing_reason on public.team_materials
 for each row
 when ((new.lifecycle='trashed' or (new.lifecycle='missing' and new.missing_reason='removed'))
  and (old.lifecycle is distinct from new.lifecycle or old.missing_reason is distinct from new.missing_reason))
 execute function private.catalog_removed_cancels_video_sets();

-- Catalogs already in the trash: stop their unfinished videos once.
do $heal$
declare m record;
begin
 for m in select distinct t.team_id, t.id from public.team_materials t
  where (t.lifecycle='trashed' or (t.lifecycle='missing' and t.missing_reason='removed'))
   and (exists(select 1 from private.catalog_video_sets x where x.catalog_material_id=t.id and x.state in('accepted','preparing','unknown'))
    or exists(select 1 from private.catalog_generation_intents g join private.catalog_video_sets x on x.catalog_intent_id=g.id
      where g.team_id=t.team_id and x.state in('accepted','preparing','unknown')
       and (g.checkpoint->>'materialId'=t.id::text or g.result#>>'{catalog,materialId}'=t.id::text)))
 loop
  perform private.cancel_unfinished_video_sets_of_catalog(m.team_id,m.id);
 end loop;
end $heal$;
