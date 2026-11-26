-- A picture that cannot be a re-stitch screen is offered once, never again (2026-11-26).
--
-- One space keeps 135 macOS AppleDouble companions («._photo.png», 180-641 bytes) beside its
-- pictures. Drive names their type by extension, so they were indexed as images and admitted to
-- the space's screen pools. Every re-stitch drew them, the agent failed to decode them, said so
-- (`reject`, defect `unsupported`) and took the next candidate - and the next video drew the same
-- files again: 528 rejections of 38 files in two weeks. The agent remembers a refusal for a day
-- and per pool configuration; the server remembered nothing, and a catalog video set freezes its
-- candidates at admission, so a file known to be useless stayed in every list.
--
-- Three kinds of evidence now decide whether a picture may be a screen, read wherever a screen
-- is chosen (private.restitch_screen_defect):
--
--   1. The name. «._*», «.DS_Store», «Thumbs.db» and «desktop.ini» are files an operating system
--      leaves behind, never pictures. A new row with such a name is indexed as `other`.
--   2. The agent's verdict (private.restitch_screen_verdicts), written by drive-ops when the
--      agent rejects a candidate as `unsupported` or accepts one. Keyed by the bytes within a
--      space (md5 and MIME type), so a new version of a file starts clean and a second copy of
--      the same bytes is covered by the first refusal. The ledger is the proof: a verdict is
--      recorded only for a candidate the slot's budget shows rejected or accepted.
--   3. What Drive says of the file (private.drive_image_probes): the dimensions it read, or that
--      it read none. No dimensions on a file under one kibibyte is not a picture. No dimensions
--      alone decides nothing - such a file stays usable until an agent has tried it.
--
-- So a screen is drawn from what is proven usable and what nothing is known about; only what is
-- proven unusable is passed over. A pool cannot starve while Drive has not described its files.
--
-- What does NOT change, on purpose: private.restitch_image_ok and private.restitch_pool_images,
-- the pool as the space declared it. private.launch_restitch_settings_version hashes that pool
-- into every accepted launch and refuses the launch (SOURCE_CHANGED) when it moves; a verdict
-- arriving in the middle of a batch of launches must not be such a move. The evidence is applied
-- one layer above, in private.restitch_pool_usable_images and in the functions that freeze or
-- draw candidates. The one thing a verdict can move is whether a slot has a picture of its own
-- left at all, which is the moment Soty's standard picture takes over (section 5).
--
-- Nothing here deletes or changes a file in anybody's Drive. Additive: two tables, one trigger,
-- new functions, four replaced functions whose results gain fields and lose only unusable
-- pictures, and one function patched in two places. Reverse steps are in ROLLBACK.md.
begin;

-- A statement that needs a lock on a table written many times a second must not queue behind
-- it for ever: five seconds, then the file fails cleanly and is applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Files an operating system writes for itself.
-- ---------------------------------------------------------------------------------------------

create or replace function private.os_service_file_name(p_name text)
returns boolean language sql immutable set search_path = '' as $$
  select p_name is not null and (
    left(p_name, 2) = '._'
    or lower(p_name) in ('.ds_store', 'thumbs.db', 'desktop.ini')
  );
$$;
revoke all on function private.os_service_file_name(text)
  from public, anon, authenticated, service_role;

-- A service file is never indexed as a picture, a video or a transcript. Rows that were indexed
-- before this rule keep their category here, because two proofs still name them as images: a
-- catalog video set freezes its candidates by material, and
-- private.restitch_selection_freeze_candidate refuses the whole variant (SOURCE_CHANGED) when one
-- of them stops being an image; and a launch is refused the same way when the declared pool it
-- was accepted with has moved. The data migration that follows moves only the rows nothing names.
create or replace function private.team_material_os_service_file()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'file' and new.category is distinct from 'other'
     and private.os_service_file_name(new.name)
     and (tg_op = 'INSERT' or old.category = 'other'
          or not private.os_service_file_name(old.name)) then
    new.category := 'other';
    new.classification_source := 'fallback';
  end if;
  return new;
end;
$$;
revoke all on function private.team_material_os_service_file()
  from public, anon, authenticated, service_role;

-- Named to run before team_materials_thumbnail_state, which reads the category.
drop trigger if exists team_materials_os_service_file on public.team_materials;
create trigger team_materials_os_service_file
  before insert or update of name, category on public.team_materials
  for each row execute function private.team_material_os_service_file();

-- ---------------------------------------------------------------------------------------------
-- 2. The evidence.
-- ---------------------------------------------------------------------------------------------

-- What agents found when they decoded these bytes. One row per content within a space.
create table if not exists private.restitch_screen_verdicts (
  team_id uuid not null references public.teams(id) on delete cascade,
  checksum text not null check (checksum ~ '^[0-9a-f]{32}$'),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  verdict text not null check (verdict in ('usable', 'unusable')),
  rejections integer not null default 0 check (rejections >= 0),
  first_rejected_at timestamptz,
  last_rejected_at timestamptz,
  last_accepted_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (team_id, checksum, mime_type)
);
alter table private.restitch_screen_verdicts enable row level security;
alter table private.restitch_screen_verdicts force row level security;
revoke all on private.restitch_screen_verdicts from public, anon, authenticated, service_role;

-- What Drive read of an image file, for the content it was asked about. Null dimensions mean
-- Drive had time to read the file and found no picture in it.
create table if not exists private.drive_image_probes (
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  drive_file_id text not null check (length(drive_file_id) between 1 and 1024),
  checksum text not null check (checksum ~ '^[0-9a-f]{32}$'),
  width integer check (width is null or width between 1 and 1000000),
  height integer check (height is null or height between 1 and 1000000),
  probed_at timestamptz not null default clock_timestamp(),
  primary key (connection_id, drive_file_id),
  check ((width is null) = (height is null))
);
alter table private.drive_image_probes enable row level security;
alter table private.drive_image_probes force row level security;
revoke all on private.drive_image_probes from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. One answer for every reader: null when the picture may be a screen, otherwise why not.
--    `service_file`  - the name of an operating system's own file;
--    `undecodable`   - an agent could not decode these bytes, and none has since;
--    `not_an_image`  - Drive read no picture in a file too small to hold one.
--    An agent that decoded the bytes outranks what Drive did not see.
-- ---------------------------------------------------------------------------------------------

create or replace function private.restitch_screen_defect(
  p_team uuid, p_connection uuid, p_drive_file_id text, p_name text,
  p_mime text, p_size bigint, p_checksum text
)
returns text language sql stable set search_path = '' cost 200 as $$
  select case
    when private.os_service_file_name(p_name) then 'service_file'
    else (
      select case
        when verdict.verdict = 'unusable' then 'undecodable'
        when verdict.verdict = 'usable' then null
        when probe.connection_id is not null and probe.width is null and p_size < 1024
          then 'not_an_image'
        else null end
      from (select 1) as one
      left join private.restitch_screen_verdicts as verdict
        on verdict.team_id = p_team and verdict.checksum = p_checksum
       and verdict.mime_type = p_mime
      left join private.drive_image_probes as probe
        on probe.connection_id = p_connection and probe.drive_file_id = p_drive_file_id
       and probe.checksum = p_checksum
    )
  end;
$$;
revoke all on function private.restitch_screen_defect(uuid, uuid, text, text, text, bigint, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Writing the evidence. Service role only.
-- ---------------------------------------------------------------------------------------------

-- The agent's own words about a candidate, bound to the ledger of the operation it holds: the
-- control ticket proves the operation, the slot's budget proves the outcome. `unsupported` is
-- the only defect that is a property of the bytes; a missing or changed file says nothing
-- about the picture and is not remembered.
create or replace function public.service_record_restitch_screen_verdict(
  p_control uuid, p_control_hash bytea, p_slot text, p_version uuid, p_outcome text
)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  scope jsonb;
  v_budget jsonb;
  v_entry jsonb;
  v_version private.restitch_candidate_versions%rowtype;
  v_now constant timestamptz := clock_timestamp();
begin
  if p_slot is null or p_slot not in ('start', 'end') or p_version is null
     or p_outcome is null or p_outcome not in ('unsupported', 'accepted') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  scope := private.restitch_control_screen_scope(p_control, p_control_hash, true);
  select budget into v_budget from private.restitch_selection_slots
   where root_operation_id = (scope ->> 'rootOperationId')::uuid and slot = p_slot;
  select value into v_entry from jsonb_array_elements(coalesce(v_budget -> 'candidates', '[]'::jsonb))
   where value ->> 'versionId' = p_version::text;
  if v_entry is null then return false; end if;
  if p_outcome = 'unsupported' and v_entry ->> 'rejected' is distinct from 'true' then
    return false;
  end if;
  if p_outcome = 'accepted' and (
       v_entry ->> 'rejected' is distinct from 'false'
       or v_budget ->> 'acceptedVersionId' is distinct from p_version::text) then
    return false;
  end if;
  select * into v_version from private.restitch_candidate_versions
   where id = p_version and team_id = (scope ->> 'teamId')::uuid;
  if v_version.id is null then return false; end if;
  if p_outcome = 'unsupported' then
    insert into private.restitch_screen_verdicts as verdict (
      team_id, checksum, mime_type, verdict, rejections, first_rejected_at, last_rejected_at,
      updated_at
    ) values (
      v_version.team_id, v_version.checksum, v_version.mime_type, 'unusable', 1, v_now, v_now,
      v_now
    ) on conflict (team_id, checksum, mime_type) do update set
      verdict = 'unusable', rejections = verdict.rejections + 1,
      first_rejected_at = coalesce(verdict.first_rejected_at, v_now),
      last_rejected_at = v_now, updated_at = v_now;
  else
    insert into private.restitch_screen_verdicts as verdict (
      team_id, checksum, mime_type, verdict, last_accepted_at, updated_at
    ) values (
      v_version.team_id, v_version.checksum, v_version.mime_type, 'usable', v_now, v_now
    ) on conflict (team_id, checksum, mime_type) do update set
      verdict = 'usable', last_accepted_at = v_now, updated_at = v_now
      where verdict.verdict <> 'usable';
  end if;
  return true;
end
$fn$;
revoke all on function public.service_record_restitch_screen_verdict(uuid, bytea, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_restitch_screen_verdict(uuid, bytea, text, uuid, text)
  to service_role;

-- What a catalog scan saw of its image files: [{driveFileId, checksum, width, height, settled}].
-- Dimensions are recorded as Drive gave them. Their absence is recorded only when the file is
-- `settled` (old enough for Drive to have read it) and never over dimensions already known for
-- the same bytes: Drive fills them in after an upload, it does not take them back.
create or replace function public.service_record_drive_image_probes(p_connection uuid, p_probes jsonb)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare
  recorded integer;
begin
  if p_connection is null or p_probes is null or jsonb_typeof(p_probes) <> 'array'
     or jsonb_array_length(p_probes) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.team_drive_connections where id = p_connection) then
    return 0;
  end if;
  with seen as (
    select distinct on (probe ->> 'driveFileId')
           probe ->> 'driveFileId' as drive_file_id,
           probe ->> 'checksum' as checksum,
           case when probe ->> 'width' ~ '^[0-9]{1,7}$' and probe ->> 'height' ~ '^[0-9]{1,7}$'
                  and (probe ->> 'width')::integer between 1 and 1000000
                  and (probe ->> 'height')::integer between 1 and 1000000
                then (probe ->> 'width')::integer end as width,
           case when probe ->> 'width' ~ '^[0-9]{1,7}$' and probe ->> 'height' ~ '^[0-9]{1,7}$'
                  and (probe ->> 'width')::integer between 1 and 1000000
                  and (probe ->> 'height')::integer between 1 and 1000000
                then (probe ->> 'height')::integer end as height,
           probe -> 'settled' = 'true'::jsonb as settled
    from jsonb_array_elements(p_probes) as probe
    where jsonb_typeof(probe) = 'object'
      and length(coalesce(probe ->> 'driveFileId', '')) between 1 and 1024
      and coalesce(probe ->> 'checksum', '') ~ '^[0-9a-f]{32}$'
    order by probe ->> 'driveFileId'
  ), written as (
    insert into private.drive_image_probes as probe (
      connection_id, drive_file_id, checksum, width, height, probed_at
    )
    select p_connection, seen.drive_file_id, seen.checksum, seen.width, seen.height,
           clock_timestamp()
    from seen
    where seen.width is not null or seen.settled
    on conflict (connection_id, drive_file_id) do update set
      checksum = excluded.checksum, width = excluded.width, height = excluded.height,
      probed_at = excluded.probed_at
      where probe.checksum is distinct from excluded.checksum
         or (excluded.width is not null
             and (probe.width, probe.height) is distinct from (excluded.width, excluded.height))
    returning 1
  )
  select count(*)::integer into recorded from written;
  return recorded;
end
$fn$;
revoke all on function public.service_record_drive_image_probes(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.service_record_drive_image_probes(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Choosing a screen. Same shapes as 030 and 047; a picture with a defect is not chosen.
-- ---------------------------------------------------------------------------------------------

-- The declared pool (private.restitch_pool_images, untouched) without what cannot be a screen.
create or replace function private.restitch_pool_usable_images(p_team uuid, p_user uuid, p_slot text)
returns table (
  material_id uuid, drive_file_id text, resource_key text, name text,
  checksum text, mime_type text, size_bytes bigint, drive_version text
)
language sql stable security definer set search_path = '' as $$
  select image.material_id, image.drive_file_id, image.resource_key, image.name,
         image.checksum, image.mime_type, image.size_bytes, image.drive_version
  from private.restitch_pool_images(p_team, p_user, p_slot) as image
  join public.team_materials as material
    on material.id = image.material_id and material.team_id = p_team
  where private.restitch_screen_defect(
          p_team, material.connection_id, image.drive_file_id, image.name,
          image.mime_type, image.size_bytes, image.checksum) is null
  order by lower(image.name), image.material_id;
$$;
revoke all on function private.restitch_pool_usable_images(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- What the settings panel shows under a pool: the files that look like pictures and cannot be
-- screens, with the reason, so their owner can find them in Drive. Read by name and format, not
-- by category: a service file indexed as `other` is still in the folder the person chose.
create or replace function private.restitch_pool_unusable_json(p_team uuid, p_user uuid, p_slot text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with recursive connection as (
    select id from public.team_drive_connections
    where team_id = p_team and state = 'connected'
  ), folders as (
    select folder.drive_file_id
    from public.team_restitch_sources as source
    join public.team_materials as folder
      on folder.id = source.material_id and folder.team_id = source.team_id
    where source.team_id = p_team and source.slot = p_slot and source.kind = 'folder'
      and source.user_id is not distinct from p_user
      and folder.lifecycle = 'active' and folder.connection_id in (select id from connection)
    union
    select child.drive_file_id
    from public.team_materials as child
    join folders on child.parent_folder_id = folders.drive_file_id
    where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
  ), files as (
    select file.id, file.name, file.size_bytes, file.parent_folder_id, file.connection_id,
           private.restitch_screen_defect(
             file.team_id, file.connection_id, file.drive_file_id, file.name,
             file.mime_type, file.size_bytes, file.checksum) as reason
    from public.team_materials as file
    where file.team_id = p_team and file.lifecycle = 'active' and file.kind = 'file'
      and file.connection_id in (select id from connection)
      and private.restitch_image_ok(file.mime_type, file.size_bytes, file.name, file.checksum)
      and (
        file.parent_folder_id in (select drive_file_id from folders)
        or exists (
          select 1 from public.team_restitch_sources as source
          where source.team_id = p_team and source.slot = p_slot and source.kind = 'file'
            and source.material_id = file.id and source.user_id is not distinct from p_user
        )
      )
  ), unusable as (
    select files.id, files.name, files.size_bytes, files.reason,
           coalesce(folder.name, '') as folder_name,
           row_number() over (order by lower(coalesce(folder.name, '')), lower(files.name), files.id)
             as position
    from files
    left join public.team_materials as folder
      on folder.team_id = p_team and folder.connection_id = files.connection_id
     and folder.drive_file_id = files.parent_folder_id and folder.kind = 'folder'
    where files.reason is not null
  )
  select jsonb_build_object(
    'count', count(*),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'materialId', id, 'name', name, 'folderName', folder_name,
      'sizeBytes', size_bytes, 'reason', reason) order by position)
      filter (where position <= 200), '[]'::jsonb))
  from unusable;
$$;
revoke all on function private.restitch_pool_unusable_json(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function private.restitch_pool_json(p_team uuid, p_user uuid, p_slot text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_connection uuid;
  v_sources jsonb;
  v_eligible integer;
  v_total integer;
  v_all_available boolean;
begin
  select id into v_connection from public.team_drive_connections
   where team_id = p_team and state = 'connected';
  select count(*) into v_total from private.restitch_pool_usable_images(p_team, p_user, p_slot);
  v_eligible := least(v_total, 500);

  select coalesce(jsonb_agg(entry.item order by entry.sort_order, entry.added_at), '[]'::jsonb),
         coalesce(bool_and(entry.item ->> 'availability' = 'available'), true)
    into v_sources, v_all_available
  from (
    select source.sort_order, source.added_at, jsonb_build_object(
      'materialId', source.material_id,
      'driveFileId', source.drive_file_id,
      'kind', source.kind,
      'name', coalesce(material.name, source.drive_file_id, ''),
      'availability', case
        when source.drive_file_id is not null then 'pending'
        when v_connection is null then 'disconnected'
        when material.connection_id <> v_connection then 'out_of_root'
        when material.lifecycle = 'trashed' then 'trashed'
        when material.lifecycle = 'missing' and material.missing_reason = 'out_of_root' then 'out_of_root'
        when material.lifecycle = 'missing' then 'missing'
        when source.kind = 'file' and (not private.restitch_image_ok(
          material.mime_type, material.size_bytes, material.name, material.checksum)
          or private.restitch_screen_defect(
            material.team_id, material.connection_id, material.drive_file_id, material.name,
            material.mime_type, material.size_bytes, material.checksum) is not null)
          then 'unsupported'
        else 'available' end,
      'imageCount', case
        when source.drive_file_id is not null or v_connection is null
          or material.lifecycle <> 'active' or material.connection_id <> v_connection then 0
        when source.kind = 'file' then case when private.restitch_image_ok(
          material.mime_type, material.size_bytes, material.name, material.checksum)
          and private.restitch_screen_defect(
            material.team_id, material.connection_id, material.drive_file_id, material.name,
            material.mime_type, material.size_bytes, material.checksum) is null then 1 else 0 end
        else (
          with recursive folders as (
            select material.drive_file_id
            union
            select child.drive_file_id from public.team_materials as child
            join folders on child.parent_folder_id = folders.drive_file_id
            where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
          )
          select count(*) from public.team_materials as image
          where image.team_id = p_team and image.lifecycle = 'active' and image.kind = 'file'
            and image.category = 'image' and image.parent_folder_id in (select drive_file_id from folders)
            and private.restitch_image_ok(image.mime_type, image.size_bytes, image.name, image.checksum)
            and private.restitch_screen_defect(
              image.team_id, image.connection_id, image.drive_file_id, image.name,
              image.mime_type, image.size_bytes, image.checksum) is null
        ) end,
      'skipped', case
        when source.drive_file_id is not null or v_connection is null
          or material.lifecycle <> 'active' or material.connection_id <> v_connection
          then jsonb_build_object('format', 0, 'size', 0, 'animated', 0)
        when source.kind = 'file' then jsonb_build_object(
          'format', case when material.mime_type not in ('image/png', 'image/jpeg', 'image/webp')
            or lower(material.name) !~ '\.(png|jpe?g|webp)$' then 1 else 0 end,
          'size', case when material.size_bytes is null or material.size_bytes not between 1 and 52428800
            then 1 else 0 end,
          'animated', case when material.mime_type in ('image/gif', 'image/apng') then 1 else 0 end)
        else (
          with recursive folders as (
            select material.drive_file_id
            union
            select child.drive_file_id from public.team_materials as child
            join folders on child.parent_folder_id = folders.drive_file_id
            where child.team_id = p_team and child.kind = 'folder' and child.lifecycle = 'active'
          ), images as (
            select image.* from public.team_materials as image
            where image.team_id = p_team and image.lifecycle = 'active' and image.kind = 'file'
              and image.category = 'image' and image.parent_folder_id in (select drive_file_id from folders)
          )
          select jsonb_build_object(
            'format', count(*) filter (where mime_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/apng')
              or (mime_type in ('image/png', 'image/jpeg', 'image/webp') and lower(name) !~ '\.(png|jpe?g|webp)$')),
            'size', count(*) filter (where mime_type in ('image/png', 'image/jpeg', 'image/webp')
              and lower(name) ~ '\.(png|jpe?g|webp)$'
              and (size_bytes is null or size_bytes not between 1 and 52428800)),
            'animated', count(*) filter (where mime_type in ('image/gif', 'image/apng')))
          from images
        ) end
    ) as item
    from public.team_restitch_sources as source
    left join public.team_materials as material
      on material.id = source.material_id and material.team_id = source.team_id
    where source.team_id = p_team and source.slot = p_slot
      and source.user_id is not distinct from p_user
  ) as entry;

  return jsonb_build_object(
    'state', case
      when v_eligible = 0 then 'empty'
      when v_all_available then 'ready'
      else 'partial' end,
    'overLimit', v_total > 500,
    'eligibleCount', v_eligible,
    'sources', v_sources,
    -- Pictures the pool would have held and cannot use (2026-11-26). A browser from before this
    -- field reads the rest of the listing as it always did.
    'unusable', private.restitch_pool_unusable_json(p_team, p_user, p_slot)
  );
end;
$$;
revoke all on function private.restitch_pool_json(uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- The 030 draw, one picture per enabled slot: from the usable pictures of the pool.
create or replace function private.draw_restitch_screens_for(
  p_team uuid, p_user uuid, p_settings jsonb, p_exclude uuid[]
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_operation text := coalesce(p_settings ->> 'operation', 'restitch');
  v_screens jsonb := '[]'::jsonb;
  v_pool jsonb := '{}'::jsonb;
  v_slot text;
  v_enabled boolean;
  v_pick record;
  v_state text;
begin
  if p_settings is null then
    raise exception 'RESTITCH_INVALID' using errcode = '22023';
  end if;
  if coalesce(p_settings ->> 'sourceMode', 'legacy') <> 'drive' then
    return jsonb_build_object(
      'sourceMode', 'legacy',
      'pool', jsonb_build_object('start', 'empty', 'end', 'empty'),
      'screens', '[]'::jsonb);
  end if;
  perform private.resolve_restitch_pending(p_team);
  foreach v_slot in array array['start', 'end'] loop
    v_enabled := coalesce((p_settings ->> (v_slot || 'Enabled'))::boolean, true);
    v_state := (private.restitch_pool_json(p_team, p_user, v_slot)) ->> 'state';
    v_pool := v_pool || jsonb_build_object(v_slot, v_state);
    if v_operation = 'unstitch' or not v_enabled or v_state = 'empty' then
      continue;
    end if;
    select * into v_pick from (
      select * from private.restitch_pool_usable_images(p_team, p_user, v_slot) limit 500
    ) as pool
    where not (pool.material_id = any (coalesce(p_exclude, '{}')))
    order by random() limit 1;
    if v_pick.material_id is not null then
      v_screens := v_screens || jsonb_build_array(jsonb_build_object(
        'slot', v_slot,
        'materialId', v_pick.material_id,
        'checksum', v_pick.checksum,
        'name', v_pick.name,
        'fileName', v_pick.name,
        'mimeType', v_pick.mime_type,
        'sizeBytes', v_pick.size_bytes,
        'driveVersion', v_pick.drive_version
      ));
    end if;
  end loop;
  if v_operation <> 'unstitch' and jsonb_array_length(v_screens) = 0
     and (coalesce((p_settings ->> 'startEnabled')::boolean, true)
          or coalesce((p_settings ->> 'endEnabled')::boolean, true)) then
    raise exception 'RESTITCH_POOL_EMPTY' using errcode = '22023';
  end if;
  return jsonb_build_object('sourceMode', 'drive', 'pool', v_pool, 'screens', v_screens);
end;
$$;
revoke all on function private.draw_restitch_screens_for(uuid, uuid, jsonb, uuid[])
  from public, anon, authenticated, service_role;

-- «Switched-on re-stitching never fails» (20261224170000): an enabled slot without pictures of
-- its own gets Soty's standard picture. A slot whose every picture is unusable has none of its
-- own either - and without this it would be frozen with no candidate at all (RESTITCH_NO_SCREENS)
-- while the panel, which counts usable pictures, already showed the standard one. The two reads
-- of the declared pool in private.effective_restitch_defaults_json become reads of the usable
-- one; nothing else in that function changes, so it is patched in place rather than restated.
-- The settings move only when a slot's last usable picture is refused - a launch accepted just
-- before that would have failed for want of a screen anyway.
do $patch$
declare
  fn constant regprocedure := 'private.effective_restitch_defaults_json(uuid,uuid)'::regprocedure;
  d text := pg_catalog.pg_get_functiondef(fn);
  slot text;
  declared text;
begin
  foreach slot in array array['start', 'end'] loop
    declared := pg_catalog.format(
      'private.restitch_pool_images(p_team, pool_user, %L)', slot);
    if strpos(d, pg_catalog.format(
         'private.restitch_pool_usable_images(p_team, pool_user, %L)', slot)) > 0 then
      continue;
    end if;
    if strpos(d, declared) = 0 then
      raise exception 'RESTITCH_USABLE_POOL_PATCH_MISSING';
    end if;
    d := replace(d, declared, pg_catalog.format(
      'private.restitch_pool_usable_images(p_team, pool_user, %L)', slot));
  end loop;
  execute d;
end
$patch$;

-- The bounded observation a new operation or catalog set freezes (047). A picture with a defect
-- is `ineligible`, never `unknown`: it is known, and it must not make the pool incomplete. A
-- service file is judged by its name before anything else for the same reason, and one that was
-- chosen as a source by itself is a known source that gives nothing.
create or replace function private.restitch_selection_pool_snapshot(p_team uuid,p_user uuid,p_slot text)
returns jsonb language sql stable security definer set search_path='' as $fn$
 with recursive source as (
  select s.material_id,s.kind,m.connection_id,m.drive_file_id,
   (m.id is null or m.lifecycle<>'active' or m.kind is distinct from s.kind
    or (s.kind='file' and m.category is distinct from 'image' and not private.os_service_file_name(m.name))
    or d.id is null or d.state<>'connected') as unknown_source
  from public.team_restitch_sources s
  left join public.team_materials m on m.id=s.material_id and m.team_id=s.team_id
  left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=s.team_id
  where s.team_id=p_team and s.user_id is not distinct from p_user and s.slot=p_slot
 ), folders as (
  select connection_id,drive_file_id from source where kind='folder' and not unknown_source
  union
  select m.connection_id,m.drive_file_id from public.team_materials m join folders f
   on m.connection_id=f.connection_id and m.parent_folder_id=f.drive_file_id
   where m.team_id=p_team and m.kind='folder' and m.lifecycle='active'
 ), bounded_folders as materialized (
  select connection_id,drive_file_id from folders limit 5001
 ), folder_counts as (
  select count(*) as observed from bounded_folders
 ), observed as (
  select m.id,m.connection_id,m.drive_file_id,m.resource_key,m.parent_folder_id,
   m.checksum,m.mime_type,m.size_bytes,m.drive_version,d.root_folder_id,
   case when private.os_service_file_name(m.name) then 'ineligible'
    when m.checksum is null or m.checksum!~'^[0-9a-f]{32}$' or m.mime_type is null
      or m.size_bytes is null or m.drive_version is null or m.parent_folder_id is null
      or length(m.drive_file_id) not between 1 and 1024 or length(m.parent_folder_id) not between 1 and 1024
      or length(d.root_folder_id) not between 1 and 1024
      or (m.resource_key is not null and length(m.resource_key) not between 1 and 4096) then 'unknown'
    when private.restitch_image_ok(m.mime_type,m.size_bytes,m.name,m.checksum)
     and private.restitch_screen_defect(m.team_id,m.connection_id,m.drive_file_id,m.name,
      m.mime_type,m.size_bytes,m.checksum) is null then 'eligible'
    else 'ineligible' end as eligibility
  from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id
  where m.team_id=p_team and m.kind='file' and m.category='image' and m.lifecycle='active' and d.state='connected'
   and (exists(select 1 from bounded_folders f where f.connection_id=m.connection_id and f.drive_file_id=m.parent_folder_id)
    or exists(select 1 from source s where not s.unknown_source and s.kind='file' and s.material_id=m.id))
  order by m.id limit 5001
 ), counts as (
  select count(*) as observed,count(*) filter(where eligibility='eligible') as eligible,
   count(*) filter(where eligibility='unknown') as unknown,
   count(*) filter(where eligibility='ineligible') as ineligible from observed
 ), admitted as (
  select * from observed where eligibility='eligible' order by id limit 501
 ), source_counts as (
  select count(*) as total,count(*) filter(where unknown_source) as unknown from source
 )
 select jsonb_build_object(
  'candidates',coalesce((select jsonb_agg(jsonb_build_object('materialId',id,'connectionId',connection_id,
   'fileId',drive_file_id,'resourceKey',resource_key,'parentFolderId',parent_folder_id,
   'rootFolderId',root_folder_id,'checksum',checksum,'mimeType',mime_type,'sizeBytes',size_bytes,
   'driveVersion',drive_version) order by id) from admitted),'[]'::jsonb),
  'complete',c.observed<=5000 and f.observed<=5000 and c.eligible<=500 and c.unknown=0 and s.unknown=0,
  'eligibleObserved',c.eligible,'ineligibleObserved',c.ineligible,'unknownObserved',c.unknown,
  'sourceCount',s.total,'unknownSourceCount',s.unknown,'truncated',c.observed>5000 or f.observed>5000 or c.eligible>500)
 from counts c cross join source_counts s cross join folder_counts f;
$fn$;
revoke all on function private.restitch_selection_pool_snapshot(uuid,uuid,text) from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. A list frozen before the evidence existed. Candidates are immutable and a catalog set
--    hands the same list to every variant, so the reader says which of them are known to be
--    useless (`unusable`) and which an agent has already decoded (`proven`); drive-ops skips
--    the first and need not record the second again. Nothing else in the answer changes.
-- ---------------------------------------------------------------------------------------------

create or replace function public.service_read_restitch_control_selection(
 p_control uuid,p_control_hash bytea,p_slot text,p_active boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare scope jsonb;r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;candidates jsonb;
begin
 if p_active is null or p_slot is null or p_slot not in('start','end') then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 scope:=private.restitch_control_screen_scope(p_control,p_control_hash,p_active);
 select * into r from private.restitch_selection_roots where root_operation_id=(scope->>'rootOperationId')::uuid;
 select * into s from private.restitch_selection_slots where root_operation_id=r.root_operation_id and slot=p_slot;
 if r.root_operation_id is null or s.root_operation_id is null or s.snapshot_complete is null then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 candidates:='[]'::jsonb;
 if p_active then
  select coalesce(jsonb_agg(jsonb_build_object('versionId',c.version_id,'materialId',c.material_id,
   'sizeBytes',c.size_bytes,'mimeType',c.mime_type,'checksum',c.checksum,
   'unusable',private.restitch_screen_defect(r.team_id,c.connection_id,c.drive_file_id,m.name,
    c.mime_type,c.size_bytes,c.checksum) is not null,
   'proven',exists(select 1 from private.restitch_screen_verdicts v where v.team_id=r.team_id
    and v.checksum=c.checksum and v.mime_type=c.mime_type and v.verdict='usable')) order by c.ordinal),'[]'::jsonb)
   into candidates from private.restitch_selection_candidates c
   left join public.team_materials m on m.id=c.material_id and m.team_id=r.team_id
   where c.root_operation_id=r.root_operation_id and c.slot=p_slot;
 end if;
 return scope||jsonb_build_object('slot',p_slot,'poolNamespaceId',r.pool_namespace_id,
  'defaults',r.recipe->'defaults','source',jsonb_build_object('materialId',r.source_material_id,'version',r.source_version,
   'checksum',r.recipe->'sourceIdentity'->'checksum','sizeBytes',r.recipe->'sourceIdentity'->'sizeBytes','mimeType',r.recipe->'sourceIdentity'->'mimeType'),
  'budget',s.budget,'complete',s.snapshot_complete,'poolObservation',r.recipe->'poolObservations'->p_slot,'candidates',candidates);
end $fn$;
revoke all on function public.service_read_restitch_control_selection(uuid,bytea,text,boolean) from public,anon,authenticated;
grant execute on function public.service_read_restitch_control_selection(uuid,bytea,text,boolean) to service_role;

commit;
