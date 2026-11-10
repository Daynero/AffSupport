-- 050: move a catalog's video cells to R2 (and back to Drive) through the
-- existing publication jobs.
--
-- Since 047 the regular update never writes the video column of a catalog that
-- has a publication policy: only a publication job does, and a job is created
-- when the videos change. A catalog whose option was ticked would therefore
-- keep its Drive link for ever, and a catalog with re-stitch would publish the
-- Drive link of each new video before its copy could possibly be ready.
--
-- The reconciliation below closes that gap without a second writer: when the
-- cells of the last published job disagree with what the option asks for, it
-- queues one more job for the same target. That job resolves every link through
-- the one resolver (publication-io), writes the cells with the existing
-- compare-and-swap, and confirms the uses. Catalogs without a preference row
-- are never touched (SC-001); catalogs without a policy keep the whole-file
-- path, where the update itself resolves the link.

-- The videos a published job put into the cells. A job written by the targeted
-- cell writer leaves link receipts; the first publication of a new catalog does
-- not, so its videos come from the job's target (one source, or the registered
-- outputs of a video set) and its links are Drive links.
create function private.catalog_video_r2_cell_sources(p_job uuid)
returns table(material_id uuid, source_version text, link_kind text)
language sql stable security definer set search_path='' as $$
 select rc.material_id, rc.source_version, coalesce(rc.link_kind,'drive')
 from private.catalog_publication_link_receipts rc where rc.job_id=p_job
 union all
 select t.source_material_id, t.source_version, 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_targets t on t.id=j.target_id and t.team_id=j.team_id
 where j.id=p_job and t.kind='source' and t.source_material_id is not null
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
 union all
 select distinct v.output_material_id, private.catalog_publication_source_version(v.output_material_id,j.team_id), 'drive'
 from private.catalog_video_publication_jobs j
 join private.catalog_publication_targets t on t.id=j.target_id and t.team_id=j.team_id
 join private.catalog_video_variants v on v.video_set_id=t.video_set_id and v.state='registered' and v.output_material_id is not null
 where j.id=p_job and t.kind='video_set'
  and not exists(select 1 from private.catalog_publication_link_receipts rc where rc.job_id=p_job)
$$;
revoke all on function private.catalog_video_r2_cell_sources(uuid) from public,anon,authenticated;

create function private.catalog_video_r2_reconcile(p_catalog uuid,p_plan boolean default false) returns text
language plpgsql security definer set search_path='' as $$
declare pref private.catalog_video_r2_preferences%rowtype; cfg private.catalog_video_r2_config%rowtype;
 p private.catalog_video_publication_policies%rowtype; last private.catalog_video_publication_jobs%rowtype;
 r record; to_r2 boolean; to_drive boolean; n integer:=0; all_ready boolean:=true; any_drive boolean:=false; any_r2 boolean:=false; planned boolean:=false; command uuid;
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
   if to_r2 and p_plan and r.lifecycle='active' then
    perform public.service_catalog_video_r2_resolve(p_catalog,r.material_id,r.source_version,r.size_bytes,r.mime_type,r.checksum);
    planned:=true;
   end if;
  end if;
 end loop;
 if n=0 then return 'none'; end if;
 if to_r2 then
  if not all_ready then
   if planned then perform public.service_catalog_video_r2_kick('claim'); return 'planned'; end if;
   return 'none';
  end if;
  if not any_drive then return 'none'; end if;
 elsif not any_r2 then
  return 'none';
 end if;
 if exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and state not in('published','superseded')) then return 'busy'; end if;
 -- The job runs as the actor of the publication it repeats; if that actor may
 -- no longer publish, the catalog keeps the working link it has.
 if private.catalog_publication_job_actor_allowed(last.id) is not true then return 'none'; end if;
 -- A reconciliation job that already tried this direction and did not get there
 -- (the copy vanished under it, the option flipped twice) is not repeated at once.
 if last.created_at>clock_timestamp()-interval '10 minutes' and exists(select 1 from private.catalog_publication_commands c
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

-- A publication settled: its cells may hold Drive links of videos that have no
-- copy yet (the first publication of a new catalog, a re-stitch), of a copy that
-- became ready meanwhile, or an R2 link after the option was turned off. This is
-- the only place a catalog being created gets its copies planned: nothing is
-- copied for a creation that never reached a verified publication, so an
-- abandoned or failed creation leaves nothing on R2.
-- Never let this follow-up break the settlement itself.
create function private.catalog_video_r2_after_publication() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_video_r2_preferences where catalog_material_id=new.catalog_material_id) then
  begin
   perform private.catalog_video_r2_reconcile(new.catalog_material_id,true);
  exception when others then null;
  end;
 end if;
 return null;
end $$;
create trigger catalog_video_r2_after_publication after update of state on private.catalog_video_publication_jobs
 for each row when (new.state='published' and old.state is distinct from 'published')
 execute function private.catalog_video_r2_after_publication();

-- A copy became ready: every catalog of the team that asked for R2 and whose
-- published cells point at this source version gets its links replaced.
create function private.catalog_video_r2_copy_became_ready() returns trigger language plpgsql security definer set search_path='' as $$
declare cat uuid;
begin
 for cat in
  select pref.catalog_material_id from private.catalog_video_r2_preferences pref
  where pref.team_id=new.team_id and pref.enabled and exists(
   select 1 from private.catalog_video_publication_policies p
   join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.state='published'
   cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
   where p.catalog_material_id=pref.catalog_material_id and cs.source_version=new.source_version)
  limit 100
 loop
  begin
   perform private.catalog_video_r2_reconcile(cat,false);
  exception when others then null;
  end;
 end loop;
 return null;
end $$;
create trigger catalog_video_r2_copy_became_ready after update of state on private.catalog_video_r2_copies
 for each row when (new.state='ready' and old.state is distinct from 'ready')
 execute function private.catalog_video_r2_copy_became_ready();

-- Safety net for a follow-up that lost a lock race: every minute, catalogs whose
-- option and published cells disagree. Never plans a copy (a refused copy must
-- not be retried by a timer); planning belongs to the option and to the jobs.
create function public.service_catalog_video_r2_reconcile_pending(p_limit integer default 50) returns integer
language plpgsql security definer set search_path='' as $$
declare cat uuid; n integer:=0; outcome text;
begin
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'INVALID_INPUT'; end if;
 for cat in
  select pref.catalog_material_id from private.catalog_video_r2_preferences pref
  where exists(select 1 from private.catalog_video_publication_policies p where p.catalog_material_id=pref.catalog_material_id)
   and ((not pref.enabled and exists(select 1 from private.catalog_video_r2_uses u where u.catalog_material_id=pref.catalog_material_id))
    or (pref.enabled and exists(select 1 from private.catalog_video_publication_policies p
      join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id and j.target_id=p.target_id and j.revision=p.revision and j.state='published'
      cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
      where p.catalog_material_id=pref.catalog_material_id and cs.link_kind<>'r2')))
  order by pref.updated_at limit p_limit
 loop
  begin
   outcome:=private.catalog_video_r2_reconcile(cat,false);
   if outcome='republished' then n:=n+1; end if;
  exception when others then null;
  end;
 end loop;
 return n;
end $$;
revoke all on function public.service_catalog_video_r2_reconcile_pending(integer) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_reconcile_pending(integer) to service_role;

-- The option itself starts the work: with a published policy the copies of the
-- videos in the cells are planned at once (and the links replaced when they are
-- ready); without a policy the catalog's current video is planned so the next
-- update can already point at the copy. Turning the option off queues the
-- return to Drive links the same way.
create or replace function public.service_catalog_video_r2_set_preference(p_actor uuid,p_catalog uuid,p_enabled boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; pref private.catalog_video_r2_preferences%rowtype; cfg private.catalog_video_r2_config%rowtype;
begin
 if p_actor is null or p_catalog is null or p_enabled is null then raise exception 'INVALID_INPUT'; end if;
 select * into m from public.team_materials where id=p_catalog;
 if not found or not exists(select 1 from public.team_product_catalogs where material_id=p_catalog) then raise exception 'NOT_FOUND'; end if;
 if not private.can(m.team_id,'manage_metadata',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 if p_enabled and (not cfg.enabled or cfg.public_origin is null) then raise exception 'VIDEO_R2_DISABLED'; end if;
 if p_enabled and cfg.policy_confirmed_at is null then raise exception 'VIDEO_R2_POLICY_PENDING'; end if;
 insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled,configured_by) values(p_catalog,m.team_id,p_enabled,p_actor)
 on conflict(catalog_material_id) do update set enabled=excluded.enabled,revision=private.catalog_video_r2_preferences.revision+1,configured_by=excluded.configured_by,updated_at=clock_timestamp()
 returning * into pref;
 perform private.catalog_video_r2_journal_write(m.team_id,null,p_catalog,null,p_actor,'configured',case when p_enabled then null else 'VIDEO_R2_DISABLED' end);
 -- The signal first: planning below may record why R2 was refused (quota, format),
 -- and a later plain refresh would erase that reason (found on beta).
 perform private.catalog_video_r2_signal(p_catalog);
 if exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=p_catalog) then
  perform private.catalog_video_r2_reconcile(p_catalog,true);
 elsif p_enabled then
  perform public.service_catalog_video_r2_resolve_current(p_catalog);
  perform public.service_catalog_video_r2_kick('claim');
 end if;
 return jsonb_build_object('enabled',pref.enabled,'revision',pref.revision,'updatedAt',pref.updated_at);
end $$;

select cron.schedule('soty-catalog-video-r2-reconcile','* * * * *',$cron$select public.service_catalog_video_r2_reconcile_pending(50)$cron$);

-- A copy nobody waits for any more is not uploaded (or finished): its catalog was
-- deleted or trashed, the option was turned off, or it was planned without a
-- catalog (creation before this migration) and no catalog took it within an hour.
-- It fails as VIDEO_R2_CANCELED and its tombstone aborts the multipart upload.
create function private.catalog_video_r2_unwanted(c private.catalog_video_r2_copies) returns boolean
language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=c.id)
  and not exists(select 1 from private.catalog_video_r2_preferences pref
   join public.team_materials m on m.id=pref.catalog_material_id and m.lifecycle='active'
   join private.catalog_video_publication_jobs j on j.catalog_material_id=pref.catalog_material_id and j.state not in('superseded')
   cross join lateral private.catalog_video_r2_cell_sources(j.id) cs
   where pref.team_id=c.team_id and pref.enabled and cs.source_version=c.source_version)
  and case
   when c.requested_by_catalog is not null then not exists(select 1 from private.catalog_video_r2_preferences pref
     join public.team_materials m on m.id=pref.catalog_material_id and m.lifecycle='active'
     where pref.catalog_material_id=c.requested_by_catalog and pref.enabled)
   else c.created_at<clock_timestamp()-interval '1 hour'
  end
$$;
revoke all on function private.catalog_video_r2_unwanted(private.catalog_video_r2_copies) from public,anon,authenticated;

create function private.catalog_video_r2_cancel(c private.catalog_video_r2_copies) returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_CANCELED',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
 insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_CANCELED');
 if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
end $$;
revoke all on function private.catalog_video_r2_cancel(private.catalog_video_r2_copies) from public,anon,authenticated;

-- The claim skips (and cancels) unwanted copies before spending any transfer on them.
create or replace function public.service_catalog_video_r2_claim(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; cfg private.catalog_video_r2_config%rowtype; m public.team_materials%rowtype; conn public.team_drive_connections%rowtype; at timestamptz:=clock_timestamp(); skipped integer:=0;
begin
 if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 if not cfg.enabled then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2-claim',0));
 loop
  select * into c from private.catalog_video_r2_copies where state in ('planned','uploading','verifying') and next_attempt_at<=at and (lease_until is null or lease_until<=at)
   order by next_attempt_at,created_at limit 1 for update skip locked;
  if not found then return null; end if;
  exit when not private.catalog_video_r2_unwanted(c) or skipped>=50;
  perform private.catalog_video_r2_cancel(c);
  skipped:=skipped+1;
 end loop;
 if private.catalog_video_r2_unwanted(c) then return null; end if;
 if c.attempts>=cfg.max_claim_attempts then
  update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_INTERRUPTED',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_INTERRUPTED');
  if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
  return null;
 end if;
 select * into m from public.team_materials where id=c.source_material_id and lifecycle='active';
 if found then select * into conn from public.team_drive_connections where id=m.connection_id and state='connected'; end if;
 if m.id is null or conn.id is null or m.drive_file_id is null then
  update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_SOURCE_UNAVAILABLE',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_SOURCE_UNAVAILABLE');
  if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
  return null;
 end if;
 update private.catalog_video_r2_copies set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1,attempts=attempts+1 where id=c.id returning * into c;
 return jsonb_build_object(
  'copyId',c.id,'teamId',c.team_id,'fence',c.fence,'state',c.state,'objectKey',c.object_key,'sizeBytes',c.size_bytes,'mime',c.mime,'partBytes',c.part_bytes,
  'sourceMd5',c.source_md5,'uploadId',c.upload_id,'sourceVersion',c.source_version,'attempts',c.attempts,
  'catalogMaterialId',c.requested_by_catalog,'sourceMaterialId',c.source_material_id,'connectionId',conn.id,'credentialId',conn.credential_id,
  'rootFolderId',conn.root_folder_id,'fileId',m.drive_file_id,'resourceKey',m.resource_key,'publicOrigin',cfg.public_origin,
  'parts',coalesce((select jsonb_agg(jsonb_build_object('partNumber',p.part_number,'sizeBytes',p.size_bytes,'sha256',p.sha256,'etag',p.etag,'verifiedBy',p.verified_by) order by p.part_number) from private.catalog_video_r2_parts p where p.copy_id=c.id),'[]'::jsonb));
end $$;
revoke all on function public.service_catalog_video_r2_claim(text) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_claim(text) to service_role;

-- Launch defaults («Зберегти налаштування») may carry the R2 choice of the catalog:
-- the whole catalog object is saved, and the validator refused the unknown key,
-- so saving defaults with the box ticked failed with INVALID_INPUT. Body is the
-- 20261206145300 validator verbatim plus one optional boolean key.
create or replace function private.validate_launch_defaults_row() returns trigger language plpgsql security definer set search_path='' as $$
declare k text;v jsonb;limit_value numeric;c jsonb;begin
 if not private.launch_profile_details_valid(new.config) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if jsonb_typeof(new.config) is distinct from 'object' or jsonb_typeof(new.sub_config) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(new.config) loop
  if k not in('buyerId','campaignCount','minBudget','maxBudget','adsCount','age','gender','method','advantagePlus','catalog','budgetMode','budgets','launchDate','timezone','originalUrl','notes') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if k in('campaignCount','minBudget','maxBudget','adsCount','age') then
   limit_value:=case k when 'campaignCount' then 100 when 'maxBudget' then 999999 when 'minBudget' then 999999 when 'adsCount' then 1000 else 9007199254740991 end;
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (v::text)::numeric not between 1 and limit_value then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif k='gender' and v#>>'{}' not in('M','W','ALL') or k='method' and v#>>'{}' not in('catalog','other') or k='advantagePlus' and jsonb_typeof(v) is distinct from 'boolean' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 if new.config ? 'gender' and jsonb_typeof(new.config->'gender') is distinct from 'string' or new.config ? 'method' and jsonb_typeof(new.config->'method') is distinct from 'string' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'buyerId' and (jsonb_typeof(new.config->'buyerId') is distinct from 'string' or not exists(select 1 from public.team_launch_buyers where team_id=new.team_id and id::text=new.config->>'buyerId' and archived_at is null)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'minBudget' and new.config ? 'maxBudget' and (new.config->>'minBudget')::numeric>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config ? 'budgetMode' and (jsonb_typeof(new.config->'budgetMode') is distinct from 'string' or new.config->>'budgetMode' not in('auto','manual')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if new.config->>'budgetMode'='manual' then
  if jsonb_typeof(new.config->'budgets') is distinct from 'array' or not (new.config ? 'campaignCount' and new.config ? 'maxBudget') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.config->'budgets')<>(new.config->>'campaignCount')::integer then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  limit_value:=0;
  for v in select value from jsonb_array_elements(new.config->'budgets') loop
   if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if v::text::numeric<=limit_value or v::text::numeric<coalesce((new.config->>'minBudget')::numeric,1) or v::text::numeric>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   limit_value:=v::text::numeric;
  end loop;
  if limit_value<>(new.config->>'maxBudget')::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 elsif new.config ? 'budgets' and new.config->'budgets'<>'null'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';
 end if;
 if new.config->>'budgetMode'='auto' and new.config ? 'campaignCount' and new.config ? 'maxBudget' and (new.config->>'campaignCount')::integer>(new.config->>'maxBudget')::integer-coalesce((new.config->>'minBudget')::integer,1)+1 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if octet_length(new.config::text)>65536 or octet_length(new.sub_config::text)>1024 or exists(select 1 from jsonb_object_keys(new.sub_config) allowed_key where allowed_key not in('schemaVersion','sub1','sub2','sub3')) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 c:=new.config->'catalog';
 if c is not null then
  if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'productCount') is distinct from 'number' or c->>'productCount' !~ '^[0-9]+$' or jsonb_typeof(c->'restitchEnabled') is distinct from 'boolean' or jsonb_typeof(c->'finalDurationMode') is distinct from 'string' or c->>'finalDurationMode' not in('random-30-40','random-40-50','random-50-60','random-centered','custom') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if exists(select 1 from jsonb_object_keys(c) allowed_key where allowed_key not in('productCount','restitchEnabled','finalDurationMode','customFinalDurationSeconds','finalDurationRangeSeconds','copyVideoToR2')) or (c ? 'copyVideoToR2' and jsonb_typeof(c->'copyVideoToR2') is distinct from 'boolean') then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c ? 'finalDurationRangeSeconds' then
   if jsonb_typeof(c->'finalDurationRangeSeconds') is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if jsonb_array_length(c->'finalDurationRangeSeconds')<>2 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   for v in select value from jsonb_array_elements(c->'finalDurationRangeSeconds') loop
    if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
    if (v::text)::numeric not between 60 and 3600 or mod((v::text)::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   end loop;
   if (c->'finalDurationRangeSeconds'->>0)::numeric>(c->'finalDurationRangeSeconds'->>1)::numeric then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  end if;
  if (c->>'productCount')::numeric not between 1 and 400 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if c->'customFinalDurationSeconds' is distinct from 'null'::jsonb then
   if jsonb_typeof(c->'customFinalDurationSeconds') is distinct from 'number' or c->>'customFinalDurationSeconds' !~ '^[0-9]+$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
   if (c->>'customFinalDurationSeconds')::numeric not between 60 and 3600 or mod((c->>'customFinalDurationSeconds')::numeric,60)<>0 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif c->>'finalDurationMode' in('custom','random-centered') and c->>'restitchEnabled'='true' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end if;
 if new.sub_config->'schemaVersion' is distinct from '1'::jsonb then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for k in select unnest(array['sub1','sub2','sub3']) loop
  if jsonb_typeof(new.sub_config->k) is distinct from 'array' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if jsonb_array_length(new.sub_config->k)>5 or exists(select 1 from jsonb_array_elements(new.sub_config->k) x where jsonb_typeof(x) is distinct from 'string' or x#>>'{}' not in('buyer','social','adAccountSuffix','creative','catalogName')) or (select count(*)<>count(distinct x) from jsonb_array_elements(new.sub_config->k) x) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 end loop;
 return new;
end $$;

-- One read for the whole catalog manager: each catalog's R2 option and link state,
-- so the toolbar icon does not cost one request per row.
create function public.service_catalog_video_r2_signals(p_actor uuid,p_team uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_actor is null or p_team is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'catalogMaterialId',s.catalog_material_id,'enabled',s.enabled,'link',s.link_kind,'copyState',s.copy_state,
   'reason',s.reason,'lastSuccessfulUpdateAt',s.last_successful_update_at,'revision',s.revision) order by s.catalog_material_id)
  from public.team_catalog_video_r2_signals s join public.team_materials m on m.id=s.catalog_material_id and m.lifecycle='active'
  where s.team_id=p_team),'[]'::jsonb);
end $$;
revoke all on function public.service_catalog_video_r2_signals(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_signals(uuid,uuid) to service_role;
