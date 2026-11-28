-- 057 T103/T104: a Launch's catalog in an R2 space — one video, several videos (062) or pictures.
--
-- The Launch and its catalog generator are the Drive ones (research.md R15: the same machine over
-- the space's storage seam); what changes is where each creative's public link comes from and
-- what the space is charged for it. A Drive space answers exactly as before: every patched Drive
-- function keeps its body for a Drive space, and the new branches ask `private.space_is_r2` or a
-- material without a Drive connection first.
--
-- * service_reserve_space_creative_image — the reservation of a picture creative's public object
--   (062, `private.launch_creative_images`) keyed by the space object's content id instead of a
--   Drive version and checksum (`source_version` 'space-v1:<content id>', `source_checksum` its
--   first 32 hex digits: the content id names the bytes, so the pair is still unique); a new one
--   is refused STORAGE_QUOTA_EXCEEDED when the space has no room for the picture.
-- * private.launch_creative_images.space_counted + private.space_creative_image_ledger — a
--   published picture of an R2 space counts once in its `catalogs` (as T111 for video copies),
--   and its bytes come back when the object is purged.
-- * service_link_space_catalog_feed (replaced) — a catalog of several videos uses the copy of
--   every one (a missing copy refuses the link); a picture catalog has no video copy to use or
--   resolve.
-- * private.space_launch_material_version and private.launch_sources_from_config (patched) — a
--   Launch's source in an R2 space is named by its content ('space-v1:<content id>') and carries
--   no Drive file id; a Drive material keeps its Drive version, checksum and file id.
-- * service_attach_launch_catalog_before_catalog_sub (patched) — an R2 catalog has no Drive
--   publication read-back (`catalog_initial_publication_checks`): its feed is Soty's own output.

-- 1. Picture creatives ----------------------------------------------------------------------------

alter table private.launch_creative_images add column space_counted boolean not null default false;

-- {state:'ready', id, url, objectKey, mime, sizeBytes} | {state:'reserved', id, objectKey}
create function public.service_reserve_space_creative_image(
  p_team uuid, p_actor uuid, p_material uuid, p_content text, p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  i private.launch_creative_images%rowtype;
  o public.space_objects%rowtype;
  v_version text := 'space-v1:' || p_content;
  v_checksum text := left(p_content, 32);
begin
  if p_team is null or p_material is null or p_attempt is null or p_content is null or p_content !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not private.space_is_r2(p_team) then raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000'; end if;
  if p_actor is null or not private.can(p_team, 'download', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select object.* into o
  from public.team_materials m
  join public.space_objects object on object.id = m.space_object_id and object.team_id = m.team_id
  where m.id = p_material and m.team_id = p_team and m.connection_id is null and m.lifecycle = 'active'
    and m.kind = 'file' and m.category = 'image'
    and object.kind = 'original' and object.state = 'committed' and object.content_id = p_content;
  if o.id is null then raise exception 'SOURCE_CHANGED' using errcode = '55000'; end if;
  -- The same lock and the same reuse rules as the Drive reservation (20261221120000).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('launch-creative-image:' || p_team::text || p_material::text, 0));
  select * into i from private.launch_creative_images where team_id = p_team and material_id = p_material
     and source_version = v_version and source_checksum = v_checksum and state in ('reserved', 'ready', 'retiring') for update;
  if i.id is null then
    -- The optimized picture is at most the source and never above 8 MiB: that much must fit.
    if least(o.byte_size, 8388608) > private.space_free_bytes(p_team) then
      raise exception 'STORAGE_QUOTA_EXCEEDED' using errcode = '55000';
    end if;
    insert into private.launch_creative_images(team_id, material_id, source_version, source_checksum, object_key, attempt_id)
    values (p_team, p_material, v_version, v_checksum, 'c1/' || gen_random_uuid()::text, p_attempt) returning * into i;
  elsif i.state = 'retiring' then
    update private.launch_creative_images set state = 'ready', retire_after = null, sweep_lease_until = null, updated_at = clock_timestamp()
     where id = i.id and state = 'retiring' and (sweep_lease_until is null or sweep_lease_until <= clock_timestamp()) returning * into i;
    if i.id is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000'; end if;
  elsif i.state = 'reserved' and i.sweep_lease_until > clock_timestamp() then
    raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode = '55000';
  elsif i.state = 'reserved' and i.attempt_id <> p_attempt then
    update private.launch_creative_images set attempt_id = p_attempt, updated_at = clock_timestamp() where id = i.id returning * into i;
  end if;
  return private.launch_creative_image_json(i);
end $$;
revoke all on function public.service_reserve_space_creative_image(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.service_reserve_space_creative_image(uuid, uuid, uuid, text, uuid) to service_role;

-- A published picture of an R2 space counts once under `catalogs`; purged, its bytes come back.
create function private.space_creative_image_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.space_is_r2(case when tg_op = 'DELETE' then old.team_id else new.team_id end) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.space_counted then perform private.space_catalog_copy_uncount(old.team_id, old.size_bytes); end if;
    return old;
  end if;
  if new.state in ('ready', 'retiring') and not new.space_counted and new.size_bytes is not null then
    perform private.space_usage_add(new.team_id, 'catalogs', new.size_bytes, 1, 0);
    new.space_counted := true;
  elsif new.state in ('purged', 'failed') and new.space_counted then
    perform private.space_catalog_copy_uncount(new.team_id, old.size_bytes);
    new.space_counted := false;
  end if;
  return new;
end $$;
revoke all on function private.space_creative_image_ledger() from public, anon, authenticated;
create trigger space_creative_image_ledger_update before update of state on private.launch_creative_images
for each row when (old.state is distinct from new.state) execute function private.space_creative_image_ledger();
create trigger space_creative_image_ledger_delete before delete on private.launch_creative_images
for each row execute function private.space_creative_image_ledger();

-- 2. The link uses every creative's copy ---------------------------------------------------------

create or replace function public.service_link_space_catalog_feed(
  p_team uuid, p_video uuid, p_companion uuid, p_replaces uuid, p_record jsonb, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_feed text := p_record ->> 'feedId';
  v_bytes text := p_record ->> 'feedBytes';
  v_set_text text := p_record ->> 'spaceVariantSetId';
  v_publication text := p_record ->> 'spacePublicationKey';
  s private.space_catalog_variant_sets%rowtype;
  v_output uuid;
  v_creatives jsonb := p_record -> 'settingsSnapshot' -> '_catalogCreatives';
  v_image boolean := coalesce(p_record -> 'settingsSnapshot' ->> '_catalogCreativeKind', 'video') = 'image';
  result jsonb;
begin
  if p_record is null or jsonb_typeof(p_record) <> 'object'
     or v_feed is null or v_feed !~ '^[0-9a-f]{32}$' or v_bytes is null or v_bytes !~ '^[1-9][0-9]{0,8}$'
     or (v_set_text is not null and v_set_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (p_record ? 'spacePublicationKey' and (v_publication is null or char_length(v_publication) not between 8 and 200)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform private.require_space_actor(p_team, p_actor, 'upload');
  if not exists (
    select 1 from public.team_materials companion
    where companion.id = p_companion and companion.team_id = p_team and companion.connection_id is null
      and companion.mime_type = 'text/csv' and companion.companion_kind = 'product_catalog'
  ) then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  if v_set_text is not null then
    -- A catalog of variations: its set must be this video's, this member's and complete.
    select * into s from private.space_catalog_variant_sets
     where id = v_set_text::uuid and team_id = p_team and actor_id = p_actor and source_material_id = p_video
     for update;
    if s.id is null or s.state = 'canceled' or (s.catalog_material_id is not null and s.catalog_material_id <> p_companion)
       or private.space_catalog_variant_progress(s.id) ->> 'state' <> 'ready' then
      raise exception 'WRONG_STATE' using errcode = '55000';
    end if;
  end if;
  result := public.service_link_product_catalog_companion(
    p_team, p_video, p_companion, p_replaces,
    p_record - 'feedId' - 'feedBytes' - 'spaceVariantSetId' - 'spacePublicationKey');
  if coalesce((result ->> 'linked')::boolean, false) then
    perform public.service_record_catalog_feed(p_companion, v_feed, v_bytes::bigint, 0);
    -- The video of an R2 space's catalog is always its R2 copy: the preference is part of it,
    -- not a setting (050's set_preference asks for catalog settings rights; this does not).
    insert into private.catalog_video_r2_preferences(catalog_material_id, team_id, enabled, configured_by)
    values (p_companion, p_team, true, p_actor)
    on conflict (catalog_material_id) do update set
      enabled = true,
      revision = private.catalog_video_r2_preferences.revision + 1,
      configured_by = excluded.configured_by,
      updated_at = clock_timestamp();
    perform private.catalog_video_r2_journal_write(p_team, null, p_companion, null, p_actor, 'configured', null);
    if s.id is not null then
      update private.space_catalog_variant_sets
         set state = 'ready', catalog_material_id = p_companion, updated_at = clock_timestamp()
       where id = s.id;
      for v_output in
        select v.output_material_id from private.space_catalog_variants v where v.set_id = s.id order by v.ordinal
      loop
        perform private.space_catalog_use_copy(p_companion, p_team, v_output, true);
      end loop;
      -- The initial publication of a catalog of variations is its feed: nothing is owed to the
      -- Drive re-verification lane (service_list_initial_catalog_recovery), so it never lists it.
      if s.catalog_intent_id is not null then
        insert into private.catalog_initial_publication_reverify (intent_id, team_id, exhausted_at)
        values (s.catalog_intent_id, p_team, clock_timestamp())
        on conflict (intent_id) do update set exhausted_at = coalesce(private.catalog_initial_publication_reverify.exhausted_at, excluded.exhausted_at);
      end if;
    elsif not v_image then
      -- Best effort: the copy was planned before the feed was written; a missing one is the
      -- updater's to resolve again, as before.
      perform private.space_catalog_use_copy(p_companion, p_team, p_video, false);
      -- T104: every other video of a Launch's creatives is its own copy, planned before the
      -- feed named it; the catalog uses each one, so none is retired while the catalog lives.
      for v_output in
        select (creative ->> 'materialId')::uuid
        from jsonb_array_elements(case when jsonb_typeof(v_creatives) = 'array' then v_creatives else '[]'::jsonb end) creative
        where creative ->> 'materialId' is distinct from p_video::text
      loop
        perform private.space_catalog_use_copy(p_companion, p_team, v_output, true);
      end loop;
    end if;
    -- T102: a link published later is the publication lane's from now on, in this transaction:
    -- the updater keeps the empty video cells until its job writes them.
    if v_publication is not null then
      perform private.register_space_catalog_publication(p_team, p_actor, p_companion, v_publication);
    end if;
    perform private.catalog_video_r2_signal(p_companion);
    -- A picture catalog has no video to copy: its pictures are its creatives' own (c1/).
    if s.id is null and not v_image then
      perform public.service_catalog_video_r2_resolve_current(p_companion);
    end if;
  end if;
  return result;
end;
$$;


-- 3. A Launch's sources in an R2 space ------------------------------------------------------------

-- A space file's identity for a Launch: its content, as the catalog publication names it (T102).
create function private.space_launch_material_version(p_material uuid, p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select 'space-v1:' || object.content_id
  from public.team_materials material
  join public.space_objects object on object.id = material.space_object_id and object.team_id = material.team_id
  where material.id = p_material and material.team_id = p_team and material.connection_id is null
    and material.kind = 'file' and material.category in ('video', 'image')
    and object.kind = 'original' and object.state = 'committed' and object.content_id ~ '^[0-9a-f]{64}$';
$$;
revoke all on function private.space_launch_material_version(uuid, uuid) from public, anon, authenticated;

do $sources$
declare d text;
begin
  select pg_get_functiondef('private.launch_sources_from_config(uuid,jsonb,uuid)'::regprocedure) into d;
  if strpos(d, $f$'materialVersion',m.drive_version,$f$) = 0
     or strpos(d, $f$'type',x.category,'version',x.drive_version,$f$) = 0
     or strpos(d, $f$ if jsonb_typeof(p_config->'creatives')='array' and jsonb_array_length(p_config->'creatives')>0 then$f$) = 0 then
    raise exception 'SPACE_LAUNCH_SOURCES_PATCH_MISSING';
  end if;
  -- A Drive material always has its Drive version: coalesce leaves it as it was.
  d := replace(d, $f$'materialVersion',m.drive_version,$f$,
    $r$'materialVersion',coalesce(m.drive_version,private.space_launch_material_version(m.id,p_team)),$r$);
  d := replace(d, $f$'type',x.category,'version',x.drive_version,$f$,
    $r$'type',x.category,'version',coalesce(x.drive_version,private.space_launch_material_version(x.id,p_team)),$r$);
  -- A space file has no Drive file id to name (the snapshot's field is optional, never null).
  d := replace(d, $f$ if jsonb_typeof(p_config->'creatives')='array' and jsonb_array_length(p_config->'creatives')>0 then$f$,
    $r$ if m.connection_id is null then result:=result-'materialDriveFileId';end if;
 if jsonb_typeof(p_config->'creatives')='array' and jsonb_array_length(p_config->'creatives')>0 then$r$);
  execute d;
end;
$sources$;

-- 4. Attaching the catalog to its Launch ----------------------------------------------------------

do $attach$
declare
  d text;
  check_text constant text := $f$or not exists(select 1 from private.catalog_initial_publication_checks b where b.intent_id=i.id and b.team_id=p_team and b.actor_id=p_actor and b.catalog_material_id=c.material_id and b.state='verified')$f$;
begin
  select pg_get_functiondef('public.service_attach_launch_catalog_before_catalog_sub(uuid,uuid,uuid,text,text)'::regprocedure) into d;
  if strpos(d, check_text) = 0 then raise exception 'SPACE_LAUNCH_ATTACH_PATCH_MISSING'; end if;
  -- The feed of an R2 catalog is Soty's own output: there is no Drive sheet to read back.
  d := replace(d, check_text, 'or (not private.space_is_r2(p_team) and not exists(' || substr(check_text, length('or not exists(') + 1) || ')');
  execute d;
end;
$attach$;
