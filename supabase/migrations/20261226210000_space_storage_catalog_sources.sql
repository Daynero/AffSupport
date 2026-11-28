-- 057 T041: catalogs of an R2 space take their sources from the space, never from Drive.
--
-- 1. A catalog video copy (050) whose source is a file of an R2 space is claimed with the
--    object's content id as its file id and no Drive fields (`sourceKind: 'space'`). The worker
--    reads it from the space bucket (`catalog-video-r2/space-reader.ts`).
-- 2. Such a copy of a multipart object has no whole-file MD5. Its `source_md5` is the MD5 in R2's
--    ETag (MD5 over the binary part MD5s), and readback verification keeps the part MD5s it has
--    proven (`space-1` state) instead of an MD5 state; the last part must give back both that
--    ETag and the content id. A Drive copy is verified exactly as before.
-- 3. The catalog updater claims a feed catalog (an R2 space's catalog, no Drive file) with its
--    feed id and revision; Drive catalogs are claimed as before, with two more null columns.
-- 4. Removing a feed catalog for good queues its CSV for deletion from the public bucket; the
--    catalog video sweep deletes it and purges its address.
--
-- Every Drive path keeps its body: the claim and the verification step keep the Drive branch
-- verbatim, and the updater predicate is the old one OR'ed with the feed case.

-- 1. Copy claim ---------------------------------------------------------------------------

create function private.catalog_video_r2_space_source(p_material uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.team_materials m where m.id = p_material and m.space_object_id is not null)
$$;
revoke all on function private.catalog_video_r2_space_source(uuid) from public, anon, authenticated, service_role;

create or replace function public.service_catalog_video_r2_claim(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; cfg private.catalog_video_r2_config%rowtype; m public.team_materials%rowtype; conn public.team_drive_connections%rowtype; so public.space_objects%rowtype; at timestamptz:=clock_timestamp(); skipped integer:=0;
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
 if found and m.space_object_id is not null then
  -- 057: a file of an R2 space. Its object must be this space's committed original.
  select o.* into so from public.space_objects o join public.teams t on t.id=o.team_id
   where o.id=m.space_object_id and o.team_id=c.team_id and o.kind='original' and o.state='committed'
     and t.storage_backend='r2';
 elsif found then select * into conn from public.team_drive_connections where id=m.connection_id and state='connected'; end if;
 if m.id is null or (so.id is null and (conn.id is null or m.drive_file_id is null)) then
  update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_SOURCE_UNAVAILABLE',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_SOURCE_UNAVAILABLE');
  if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
  return null;
 end if;
 update private.catalog_video_r2_copies set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1,attempts=attempts+1 where id=c.id returning * into c;
 if so.id is not null then
  return jsonb_build_object(
   'copyId',c.id,'teamId',c.team_id,'fence',c.fence,'state',c.state,'objectKey',c.object_key,'sizeBytes',c.size_bytes,'mime',c.mime,'partBytes',c.part_bytes,
   'sourceMd5',c.source_md5,'uploadId',c.upload_id,'sourceVersion',c.source_version,'attempts',c.attempts,
   'catalogMaterialId',c.requested_by_catalog,'sourceMaterialId',c.source_material_id,'connectionId',null,'credentialId',null,
   'rootFolderId',null,'fileId',so.content_id,'resourceKey',null,'publicOrigin',cfg.public_origin,'sourceKind','space',
   'parts',coalesce((select jsonb_agg(jsonb_build_object('partNumber',p.part_number,'sizeBytes',p.size_bytes,'sha256',p.sha256,'etag',p.etag,'verifiedBy',p.verified_by) order by p.part_number) from private.catalog_video_r2_parts p where p.copy_id=c.id),'[]'::jsonb));
 end if;
 return jsonb_build_object(
  'copyId',c.id,'teamId',c.team_id,'fence',c.fence,'state',c.state,'objectKey',c.object_key,'sizeBytes',c.size_bytes,'mime',c.mime,'partBytes',c.part_bytes,
  'sourceMd5',c.source_md5,'uploadId',c.upload_id,'sourceVersion',c.source_version,'attempts',c.attempts,
  'catalogMaterialId',c.requested_by_catalog,'sourceMaterialId',c.source_material_id,'connectionId',conn.id,'credentialId',conn.credential_id,
  'rootFolderId',conn.root_folder_id,'fileId',m.drive_file_id,'resourceKey',m.resource_key,'publicOrigin',cfg.public_origin,
  'parts',coalesce((select jsonb_agg(jsonb_build_object('partNumber',p.part_number,'sizeBytes',p.size_bytes,'sha256',p.sha256,'etag',p.etag,'verifiedBy',p.verified_by) order by p.part_number) from private.catalog_video_r2_parts p where p.copy_id=c.id),'[]'::jsonb));
end $$;
revoke all on function public.service_catalog_video_r2_claim(text) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_claim(text) to service_role;

-- 2. Readback verification ----------------------------------------------------------------

create or replace function public.service_catalog_video_r2_verification_advance(p_copy uuid,p_worker text,p_fence bigint,p_etag text,p_manifest jsonb,p_previous_parts integer,p_hash_state jsonb,p_final_md5 text default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; v private.catalog_video_r2_verification%rowtype; expected_bytes bigint; last_part boolean; digests bytea;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='verifying' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 select * into v from private.catalog_video_r2_verification where copy_id=p_copy for update;
 if not found or v.parts_checked is distinct from p_previous_parts or v.staging_etag is distinct from p_etag or v.manifest is distinct from p_manifest or v.manifest<>private.catalog_video_r2_manifest(p_copy) or v.source_md5 is distinct from c.source_md5 or v.final_md5 is not null then raise exception 'LEASE_MISMATCH'; end if;
 select coalesce(sum(size_bytes),0) into expected_bytes from private.catalog_video_r2_parts where copy_id=p_copy and part_number<=p_previous_parts+1;
 last_part:=p_previous_parts+1=jsonb_array_length(v.manifest);
 if p_hash_state is not null and jsonb_typeof(p_hash_state)='object' and (p_hash_state->>'version')='space-1' then
  -- 057: a multipart space source: the MD5 of each source part proven so far, 16 bytes each.
  if not private.catalog_video_r2_space_source(c.source_material_id) or expected_bytes<=v.bytes_checked
     or (p_hash_state->>'bytes') is distinct from expected_bytes::text or jsonb_typeof(p_hash_state->'digests') is distinct from 'string'
     or length(p_hash_state->>'digests')>4*ceil(16.0*(p_previous_parts+1)/3) or pg_column_size(p_hash_state)>8192
     or (select count(*) from jsonb_object_keys(p_hash_state))<>3 then raise exception 'INVALID_INPUT'; end if;
  begin
   digests:=decode(p_hash_state->>'digests','base64');
  exception when others then raise exception 'INVALID_INPUT';
  end;
  if length(digests)<>16*(p_previous_parts+1) then raise exception 'INVALID_INPUT'; end if;
 else
  if expected_bytes<=v.bytes_checked or p_hash_state is null or jsonb_typeof(p_hash_state)<>'object' or (p_hash_state->>'version') is distinct from '1' or (p_hash_state->>'bytes') is distinct from expected_bytes::text or jsonb_typeof(p_hash_state->'state') is distinct from 'array' or jsonb_typeof(p_hash_state->'tail') is distinct from 'array' then raise exception 'INVALID_INPUT'; end if;
  if jsonb_array_length(p_hash_state->'state')<>4 or jsonb_array_length(p_hash_state->'tail')<>mod(expected_bytes,64) or pg_column_size(p_hash_state)>4096 then raise exception 'INVALID_INPUT'; end if;
  if exists(select 1 from jsonb_array_elements(p_hash_state->'state') x where jsonb_typeof(x)<>'number' or x::text !~ '^[0-9]+$' or (x::text)::numeric>4294967295) or exists(select 1 from jsonb_array_elements(p_hash_state->'tail') x where jsonb_typeof(x)<>'number' or x::text !~ '^[0-9]+$' or (x::text)::numeric>255) then raise exception 'INVALID_INPUT'; end if;
 end if;
 if (last_part and p_final_md5 is distinct from v.source_md5) or (not last_part and p_final_md5 is not null) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_verification set parts_checked=p_previous_parts+1,bytes_checked=expected_bytes,hash_state=p_hash_state,final_md5=p_final_md5,updated_at=clock_timestamp() where copy_id=p_copy;
 update private.catalog_video_r2_copies set attempts=0,lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy;
end $$;
revoke all on function public.service_catalog_video_r2_verification_advance(uuid,text,bigint,text,jsonb,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.service_catalog_video_r2_verification_advance(uuid,text,bigint,text,jsonb,integer,jsonb,text) to service_role;

-- 3. Updater claim for feed catalogs -------------------------------------------------------

-- What the updater may claim: a catalog on a usable Drive connection (unchanged), or a feed
-- catalog of an active R2 space, which has no connection at all.
create function private.catalog_update_target_usable(p_catalog uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private.catalog_connection_usable(p_catalog) or exists(
  select 1 from public.team_materials sheet
  join public.team_product_catalogs record on record.material_id=sheet.id
  join public.teams team on team.id=sheet.team_id
  where sheet.id=p_catalog and sheet.connection_id is null and record.feed_id is not null
    and team.storage_backend='r2')
$$;
revoke all on function private.catalog_update_target_usable(uuid) from public,anon,authenticated,service_role;

do $claim$
declare d text;
begin
 select pg_get_functiondef('private.claim_catalog_updater_items(text,integer,integer)'::regprocedure) into d;
 if strpos(d,'and private.catalog_connection_usable(item.catalog_material_id)')=0 then
  raise exception 'CATALOG_CLAIM_FEED_PATCH_MISSING';
 end if;
 d:=replace(d,'and private.catalog_connection_usable(item.catalog_material_id)',
  'and private.catalog_update_target_usable(item.catalog_material_id)');
 execute d;
end $claim$;

drop function public.service_claim_catalog_updater_items(text, integer, integer);
create function public.service_claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns table (
  catalog_material_id uuid, team_id uuid, attempts integer, update_count integer,
  product_count smallint, source_link text, video_link text, settings_snapshot jsonb,
  drive_file_id text, resource_key text, credential_id uuid, current_video_link text,
  spare_material_id uuid, spare_link text, refresh_images boolean, refresh_texts boolean,
  price_min integer, price_max integer, grow_products boolean, random_link_variation boolean,
  feed_id text, feed_revision bigint
)
language sql security definer set search_path = '' as $$
  select item.catalog_material_id, item.team_id, item.attempts,
         record.update_count, record.product_count, record.source_link, record.video_link,
         record.settings_snapshot, sheet.drive_file_id, sheet.resource_key,
         connection.credential_id, record.current_video_link, spare.material_id, spare.shared_link,
         coalesce((attempt.profile_snapshot ->> 'refreshImages')::boolean, profile.refresh_images),
         coalesce((attempt.profile_snapshot ->> 'refreshTexts')::boolean, profile.refresh_texts),
         settings.price_min, settings.price_max,
         coalesce((attempt.profile_snapshot ->> 'growProducts')::boolean, profile.grow_products),
         coalesce((attempt.profile_snapshot ->> 'randomLinkVariation')::boolean,
                  profile.random_link_variation),
         case when connection.id is null then record.feed_id end,
         case when connection.id is null then record.feed_revision end
  from private.claim_catalog_updater_items(p_worker, p_limit, p_lease_seconds) as item
  join public.team_product_catalogs as record on record.material_id = item.catalog_material_id
  join public.team_catalog_update_profiles as profile
    on profile.catalog_material_id = item.catalog_material_id
  left join public.team_catalog_update_attempts as attempt
    on attempt.catalog_material_id = item.catalog_material_id
   and attempt.round_due_at = item.round_due_at
  join public.team_materials as sheet on sheet.id = item.catalog_material_id
  left join public.team_drive_connections as connection on connection.id = sheet.connection_id
  left join public.team_product_catalog_settings as settings on settings.team_id = item.team_id
  left join lateral (
    select copy.material_id, copy.shared_link
    from public.team_catalog_restitch_copies as copy
    join public.team_materials as file on file.id = copy.material_id
    where coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
      and copy.catalog_material_id = item.catalog_material_id
      and copy.role = 'spare' and file.lifecycle = 'active'
  ) as spare on true
  where connection.state in ('connected', 'unavailable')
     or (sheet.connection_id is null and record.feed_id is not null);
$$;
revoke all on function public.service_claim_catalog_updater_items(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_claim_catalog_updater_items(text, integer, integer)
  to service_role;

-- 4. Feed removal -------------------------------------------------------------------------

-- A feed whose catalog is gone for good (the row deleted: the trash emptied, the space removed).
-- No FK: the queue must outlive the catalog and the space. Sending a catalog to the trash keeps
-- its feed, so a restored catalog still updates; the trash is where «deleted» means nothing yet.
create table private.catalog_feed_removals (
  feed_id text primary key check (feed_id ~ '^[0-9a-f]{32}$'),
  team_ref uuid,
  queued_at timestamptz not null default clock_timestamp(),
  fence bigint not null default 0,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz,
  last_error text check (last_error is null or last_error ~ '^[A-Z0-9_]{1,64}$')
);
create index catalog_feed_removals_due on private.catalog_feed_removals (next_attempt_at)
  where removed_at is null;
alter table private.catalog_feed_removals enable row level security;
alter table private.catalog_feed_removals force row level security;
revoke all on private.catalog_feed_removals from public, anon, authenticated, service_role;
-- Every catalog_* table takes part in the shared cleanup admission fence.
create trigger task_cleanup_reference_fence before insert or update on private.catalog_feed_removals
for each row execute function private.guard_task_cleanup_reference();

create function private.catalog_feed_queue_removal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.catalog_feed_removals (feed_id, team_ref) values (old.feed_id, old.team_id)
  on conflict (feed_id) do update set removed_at = null, next_attempt_at = clock_timestamp(),
    attempts = 0, last_error = null;
  -- Never let the follow-up stop the delete itself; the sweep is the safety net.
  begin
    perform private.invoke_catalog_video_r2_worker('sweep');
  exception when others then null;
  end;
  return old;
end;
$$;
revoke all on function private.catalog_feed_queue_removal() from public, anon, authenticated;
create trigger catalog_feed_queue_removal
after delete on public.team_product_catalogs
for each row when (old.feed_id is not null)
execute function private.catalog_feed_queue_removal();

create function public.service_catalog_feed_claim_removal(p_worker text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.catalog_feed_removals%rowtype; at timestamptz := clock_timestamp();
begin
  if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
  select * into r from private.catalog_feed_removals
   where removed_at is null and next_attempt_at <= at and (lease_until is null or lease_until <= at)
   order by next_attempt_at, queued_at limit 1 for update skip locked;
  if not found then return null; end if;
  -- A catalog that took the same feed id back (it cannot: ids are random) keeps it.
  if exists (select 1 from public.team_product_catalogs where feed_id = r.feed_id) then
    update private.catalog_feed_removals set removed_at = at, last_error = 'FEED_IN_USE'
     where feed_id = r.feed_id;
    return null;
  end if;
  update private.catalog_feed_removals set fence = fence + 1, lease_until = at + interval '60 seconds',
    attempts = attempts + 1 where feed_id = r.feed_id returning * into r;
  return jsonb_build_object('feedId', r.feed_id, 'fence', r.fence);
end;
$$;

create function public.service_catalog_feed_finish_removal(
  p_feed_id text, p_fence bigint, p_success boolean, p_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r private.catalog_feed_removals%rowtype;
begin
  select * into r from private.catalog_feed_removals where feed_id = p_feed_id for update;
  if not found or r.fence <> p_fence or r.removed_at is not null then raise exception 'LEASE_MISMATCH'; end if;
  if p_success then
    update private.catalog_feed_removals set removed_at = clock_timestamp(), lease_until = null,
      last_error = null where feed_id = p_feed_id;
  else
    update private.catalog_feed_removals set lease_until = null,
      last_error = case when p_code ~ '^[A-Z0-9_]{1,64}$' then p_code else 'FEED_REMOVAL_FAILED' end,
      next_attempt_at = clock_timestamp() + least(interval '1 hour', interval '30 seconds' * power(2, least(r.attempts, 7)))
     where feed_id = p_feed_id;
  end if;
end;
$$;
revoke all on function public.service_catalog_feed_claim_removal(text) from public, anon, authenticated;
revoke all on function public.service_catalog_feed_finish_removal(text, bigint, boolean, text)
  from public, anon, authenticated;
grant execute on function public.service_catalog_feed_claim_removal(text) to service_role;
grant execute on function public.service_catalog_feed_finish_removal(text, bigint, boolean, text)
  to service_role;

-- The sweep counts a due feed removal as work (the wake-up above may be lost).
do $patch$
declare d text;
begin
  select pg_get_functiondef('private.catalog_video_r2_has_work(text)'::regprocedure) into d;
  if strpos(d, $find$else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())$find$) = 0
  then raise exception 'R2_SWEEP_FEED_PATCH_MISSING'; end if;
  d := replace(d, $find$else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())$find$,
    $replace$else exists(select 1 from private.catalog_feed_removals where removed_at is null and next_attempt_at<=clock_timestamp())
   or exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())$replace$);
  execute d;
end $patch$;
