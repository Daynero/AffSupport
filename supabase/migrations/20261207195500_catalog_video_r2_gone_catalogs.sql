-- 050: a catalog with its video in R2 is deleted for good, and lets go of it.
--
-- Catalog materials are never hard-deleted: a sheet taken out of Drive becomes
-- `trashed` or `missing` (reason `removed`), and the row stays. The copy's use
-- rows cascade only from a deleted row, so a deleted catalog kept its R2 video
-- for ever: public, counted against the space limit, cleaned up only with the
-- whole space. Found during the final beta pass.
--
-- Owner decision (2026-11-11): somebody freeing the space limit deletes old
-- catalogs and must get the space back at once, not in Drive's 30 days. So a
-- catalog with the option on is deleted for good as far as Soty is concerned:
-- the interface warns that it cannot be restored, the Soty trash does not list
-- it (the sheet itself still goes to the Google Drive trash), and the sweep
-- releases its copies as soon as it is `trashed` or `missing`/`removed`. A
-- sheet merely moved out of the watched folder (`out_of_root`) is alive and
-- keeps its copy.
--
-- Releasing deletes the use rows; the existing `catalog_video_r2_use_removed`
-- trigger then retires a copy no other catalog uses. Its grace window is
-- dropped: it protects a replaced or switched-off copy while consumers that
-- read the sheet on a schedule still hold the old link; nothing reads a deleted
-- sheet. The same sweep then deletes the object, so the link stops working
-- within one sweep (5 minutes) instead of inviting somebody to reuse it.
-- A sheet restored from the Drive trash by hand is caught below: its dead R2
-- links are rewritten to Drive and a fresh copy brings them back to R2.

create or replace function public.service_catalog_video_r2_retire_orphans() returns integer language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype; n integer:=0; c record; released uuid[];
begin
 select * into cfg from private.catalog_video_r2_config where singleton;
 with gone as (
  delete from private.catalog_video_r2_uses u
   using public.team_materials m
   where m.id=u.catalog_material_id
    and ((m.lifecycle='missing' and m.missing_reason='removed')
     or m.lifecycle='trashed')
   returning u.copy_id)
 select coalesce(array_agg(distinct copy_id),'{}') into released from gone;
 -- Due now: the sweep that called this claims and deletes them right after.
 update private.catalog_video_r2_copies set retire_after=clock_timestamp()
  where id=any(released) and state='retiring'
   and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id);
 for c in select * from private.catalog_video_r2_copies where state='ready' and ready_at<clock_timestamp()-cfg.grace_interval and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id) for update skip locked loop
  update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason='replaced',fence=fence+1 where id=c.id;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_retire_orphans() from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_retire_orphans() to service_role;


-- Back from the trash: the sheet still holds R2 links of a copy that is gone.
-- The reconciliation rewrites them to Drive at once and prepares the copy again;
-- the copy-ready trigger then moves the cells back to R2. The minute sweep finds
-- such catalogs and is the only caller that plans for them.
create or replace function private.catalog_video_r2_reconcile(p_catalog uuid,p_plan boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare pref private.catalog_video_r2_preferences%rowtype; cfg private.catalog_video_r2_config%rowtype;
 p private.catalog_video_publication_policies%rowtype; last private.catalog_video_publication_jobs%rowtype;
 r record; to_r2 boolean; to_drive boolean; n integer:=0; all_ready boolean:=true; any_drive boolean:=false; any_r2 boolean:=false; planned boolean:=false; stale_r2 boolean:=false; command uuid;
begin
 select * into pref from private.catalog_video_r2_preferences where catalog_material_id=p_catalog;
 if not found then return 'none'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 to_r2:=pref.enabled and cfg.enabled and cfg.public_origin is not null and cfg.policy_confirmed_at is not null;
 to_drive:=not pref.enabled;
 if not to_r2 and not to_drive then return 'none'; end if;
 -- Same lock order as the publication settlement: catalog material, then policy.
 perform 1 from public.team_materials where id=p_catalog and lifecycle='active' for update;
 if not found then return 'none'; end if;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog for update;
 if not found or p.mode='held' or p.legacy_delivery_unverified then return 'none'; end if;
 select * into last from private.catalog_video_publication_jobs
  where catalog_material_id=p_catalog and state='published' and target_id=p.target_id and revision=p.revision
  order by verified_at desc nulls last limit 1;
 if not found then return 'none'; end if;
 for r in
  select cs.material_id,cs.source_version,cs.link_kind as kind,m.size_bytes,m.mime_type,m.checksum,m.lifecycle,
   exists(select 1 from private.catalog_video_r2_copies c where c.team_id=p.team_id and c.source_version=cs.source_version and c.state='ready') as ready
  from private.catalog_video_r2_cell_sources(last.id) cs
  left join public.team_materials m on m.id=cs.material_id and m.team_id=p.team_id
  where cs.source_version is not null
 loop
  n:=n+1;
  if r.kind='r2' then any_r2:=true; else any_drive:=true; end if;
  if not r.ready then
   all_ready:=false;
   -- The cell links a copy that is gone (the catalog came back from the trash).
   if r.kind='r2' then stale_r2:=true; end if;
   if to_r2 and p_plan and r.lifecycle='active' then
    perform public.service_catalog_video_r2_resolve(p_catalog,r.material_id,r.source_version,r.size_bytes,r.mime_type,r.checksum);
    planned:=true;
   end if;
  end if;
 end loop;
 if n=0 then return 'none'; end if;
 if to_r2 then
  -- A dead R2 link is rewritten at once: the job writes the Drive link while the
  -- copy is prepared again, and the ready copy brings the cells back to R2.
  if not all_ready and not stale_r2 then
   if planned then perform public.service_catalog_video_r2_kick('claim'); return 'planned'; end if;
   return 'none';
  end if;
  if not any_drive and not stale_r2 then return 'none'; end if;
 elsif not any_r2 then
  return 'none';
 end if;
 if exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and state not in('published','superseded')) then return 'busy'; end if;
 -- The job runs as the actor of the publication it repeats; if that actor may
 -- no longer publish, the catalog keeps the working link it has.
 if private.catalog_publication_job_actor_allowed(last.id) is not true then return 'none'; end if;
 -- A reconciliation job that already tried this direction and did not get there
 -- (the copy vanished under it, the option flipped twice) is not repeated at once.
 -- A dead R2 link is never left waiting: rewriting it cannot loop, the cells it
 -- leaves are Drive (copy not ready) or live R2.
 if not stale_r2 and last.created_at>clock_timestamp()-interval '10 minutes' and exists(select 1 from private.catalog_publication_commands c
  where c.request_id=last.command_id and c.team_id=last.team_id and c.actor_id=last.actor_id
   and c.payload->>'origin'='video_r2' and c.receipt->>'linkKind'=case when to_r2 then 'r2' else 'drive' end) then return 'busy'; end if;
 command:=gen_random_uuid();
 insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt)
 values(command,p.team_id,p.actor_id,
  jsonb_build_object('origin','video_r2','catalogId',p_catalog,'expectedRevision',p.revision,'mode','immediate','dueAt',null,'timeZone',null,'target',private.catalog_publication_target_json(p.target_id)),
  jsonb_build_object('origin','video_r2','linkKind',case when to_r2 then 'r2' else 'drive' end));
 update private.catalog_video_publication_policies set revision=p.revision+1,mode='immediate',due_at=null,time_zone=null,updated_at=clock_timestamp() where catalog_material_id=p_catalog;
 insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state)
 values(p_catalog,p.team_id,p.actor_id,p.revision+1,command,p.target_id,'waiting');
 return 'republished';
end $$;
revoke all on function private.catalog_video_r2_reconcile(uuid,boolean) from public,anon,authenticated;

create or replace function public.service_catalog_video_r2_reconcile_pending(p_limit integer default 50) returns integer
language plpgsql security definer set search_path='' as $$
declare cat uuid; stale boolean; n integer:=0; outcome text;
begin
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'INVALID_INPUT'; end if;
 for cat,stale in
  select pref.catalog_material_id,
   -- An R2 link whose copy is no longer ready: the catalog came back from the trash.
   (pref.enabled and exists(select 1 from private.catalog_video_publication_policies p
     join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
     cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
     where p.catalog_material_id=pref.catalog_material_id and cs.link_kind='r2'
      and not exists(select 1 from private.catalog_video_r2_copies c where c.team_id=pref.team_id and c.source_version=cs.source_version and c.state='ready'))) as stale
  from private.catalog_video_r2_preferences pref
  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id)
   and ((not pref.enabled and exists(select 1 from private.catalog_video_r2_uses u where u.catalog_material_id=pref.catalog_material_id))
    or (pref.enabled and exists(select 1 from private.catalog_video_publication_policies p
      join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
      cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
      where p.catalog_material_id=pref.catalog_material_id and (cs.link_kind<>'r2'
       or not exists(select 1 from private.catalog_video_r2_copies c where c.team_id=pref.team_id and c.source_version=cs.source_version and c.state='ready')))))
  order by pref.updated_at limit p_limit
 loop
  begin
   -- Plans only for a dead R2 link; anything else was planned when it was published.
   outcome:=private.catalog_video_r2_reconcile(cat,stale);
   if outcome='republished' then n:=n+1; end if;
  exception when others then null;
  end;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_reconcile_pending(integer) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_reconcile_pending(integer) to service_role;

-- A retiring copy under a delete lease may already be gone from the bucket: a
-- catalog that wants it back gets a Drive link now and a fresh copy later,
-- never the link of an object being deleted.
do $resolve$
declare d text;
begin
 select pg_get_functiondef('public.service_catalog_video_r2_resolve(uuid,uuid,text,bigint,text,text,uuid,uuid,boolean)'::regprocedure) into d;
 if strpos(d,$find$  if c.state='retiring' then$find$)=0 then raise exception 'VIDEO_R2_RESOLVE_PATCH_MISSING'; end if;
 d:=replace(d,$find$  if c.state='retiring' then$find$,$replace$  if c.state='retiring' and (c.lease_until is null or c.lease_until<=clock_timestamp()) then$replace$);
 execute d;
end $resolve$;

-- The Soty trash does not list a catalog with the option on: it is gone for good.
do $trash$
declare d text;
begin
 select pg_get_functiondef('public.list_team_trashed_materials_v2(uuid,integer,timestamptz,uuid)'::regprocedure) into d;
 if strpos(d,$find$  where material.team_id = p_team and material.lifecycle = 'trashed'$find$)=0 then raise exception 'VIDEO_R2_TRASH_PATCH_MISSING'; end if;
 d:=replace(d,$find$  where material.team_id = p_team and material.lifecycle = 'trashed'$find$,$replace$  where material.team_id = p_team and material.lifecycle = 'trashed'
    and not exists (select 1 from private.catalog_video_r2_preferences as pref
                    where pref.catalog_material_id = material.id and pref.enabled)$replace$);
 execute d;
end $trash$;
