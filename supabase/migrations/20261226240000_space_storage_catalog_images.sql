-- 057 T041: the catalog picture pool imports from the files of an R2 space (`sourceKind: 'space'`).
--
-- A Drive space imports from Drive (`sourceKind: 'drive'`), exactly as before; an R2 space has no
-- Drive, so its members pick the space's own files and folders instead. The job is the same job:
-- it enumerates (the worker reads the space's tree here instead of listing Drive), its entries are
-- staged with a `{kind: 'space'}` source, and each picture is read on the server from the space
-- bucket by its content id (catalog-images/space-sources.ts), then optimized, deduplicated and
-- published like every other picture.
--
-- * team_catalog_image_imports.source_kind admits 'space'.
-- * private.catalog_image_control_impl_v2 — patched in place: 'space' is accepted for an R2 space
--   only and 'drive' for a Drive space only ('local' for both); 'space' enumerates like 'drive',
--   and `continue` repeats the job's own source kind instead of naming 'drive'.
-- * service_catalog_image_claim_v2 — patched in place: an enumeration claim names its source kind.
-- * service_catalog_image_space_enumerate — one page of the pictures under the job's sources.
-- * service_catalog_image_space_source — the object a staged picture is read from, while the file
--   still holds the content it was staged with.

alter table public.team_catalog_image_imports drop constraint team_catalog_image_imports_source_kind_check;
alter table public.team_catalog_image_imports add constraint team_catalog_image_imports_source_kind_check
  check (source_kind in ('local', 'drive', 'space'));

do $control$
declare d text;
begin
  select pg_get_functiondef('private.catalog_image_control_impl_v2(text,uuid,jsonb)'::regprocedure) into d;
  if strpos(d, 'p_payload->>''sourceKind'' not in (''local'',''drive'')') = 0
     or strpos(d, 'case when p_payload->>''sourceKind''=''drive'' then ''enumerating'' else ''collecting'' end') = 0
     or strpos(d, '''sourceKind'',''drive'',''idempotencyKey''') = 0
     or strpos(d, 'case when source_kind=''drive'' and exists(') = 0
     or strpos(d, '  v_digest:=encode(extensions.digest((p_payload-''idempotencyKey'')::text,''sha256''),''hex'');') = 0 then
    raise exception 'CATALOG_IMAGE_SPACE_PATCH_MISSING';
  end if;
  d := replace(d, 'p_payload->>''sourceKind'' not in (''local'',''drive'')',
    'p_payload->>''sourceKind'' not in (''local'',''drive'',''space'')');
  -- Where the files come from must be where the space keeps them.
  d := replace(d, '  v_digest:=encode(extensions.digest((p_payload-''idempotencyKey'')::text,''sha256''),''hex'');',
    '  if p_payload->>''sourceKind''<>''local'' and (p_payload->>''sourceKind''=''space'') is distinct from private.space_is_r2(t) then raise exception ''STORAGE_BACKEND_MISMATCH'' using errcode=''55000''; end if;
  v_digest:=encode(extensions.digest((p_payload-''idempotencyKey'')::text,''sha256''),''hex'');');
  d := replace(d, 'case when p_payload->>''sourceKind''=''drive'' then ''enumerating'' else ''collecting'' end',
    'case when p_payload->>''sourceKind'' in (''drive'',''space'') then ''enumerating'' else ''collecting'' end');
  d := replace(d, '''sourceKind'',''drive'',''idempotencyKey''', '''sourceKind'',j.source_kind,''idempotencyKey''');
  d := replace(d, 'case when source_kind=''drive'' and exists(', 'case when source_kind in (''drive'',''space'') and exists(');
  execute d;
end;
$control$;

do $claim$
declare d text;
begin
  select pg_get_functiondef('public.service_catalog_image_claim_v2(text)'::regprocedure) into d;
  if strpos(d, '''kind'',''enumerate'',''jobId'',j.id') = 0 then
    raise exception 'CATALOG_IMAGE_SPACE_CLAIM_PATCH_MISSING';
  end if;
  d := replace(d, '''kind'',''enumerate'',''jobId'',j.id', '''kind'',''enumerate'',''sourceKind'',j.source_kind,''jobId'',j.id');
  execute d;
end;
$claim$;

-- One page of the job's pictures: every image file under its sources (a selected file itself, a
-- selected folder's whole subtree), in id order after `p_after`. A selected file that is not a
-- picture is refused, as the Drive enumeration refuses it.
create function public.service_catalog_image_space_enumerate(
  p_job uuid, p_worker text, p_fence bigint, p_after uuid, p_limit integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  j public.team_catalog_image_imports%rowtype;
  i private.catalog_image_import_intents%rowtype;
  page jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into j from public.team_catalog_image_imports where id = p_job;
  select * into i from private.catalog_image_import_intents intent
  where intent.job_id = p_job and intent.fence = p_fence and intent.lease_owner = p_worker
    and intent.lease_until > clock_timestamp();
  if j.id is null or i.job_id is null or j.state <> 'enumerating' or j.source_kind <> 'space' then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if not private.space_is_r2(j.team_id) then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  if not private.can(j.team_id, 'manage_metadata', j.actor_id) or not private.can(j.team_id, 'download', j.actor_id) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if jsonb_typeof(i.sources) <> 'array' or exists (
    select 1 from jsonb_array_elements_text(i.sources) source(id)
    where source.id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (
         select 1 from public.team_materials m
         where m.id = source.id::uuid and m.team_id = j.team_id and m.connection_id is null
           and m.lifecycle = 'active' and m.kind in ('file', 'folder'))
  ) then
    raise exception 'IMAGE_SOURCE_UNAVAILABLE' using errcode = '55000';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(i.sources) source(id)
    join public.team_materials m on m.id = source.id::uuid
    left join public.space_objects o on o.id = m.space_object_id
    where m.kind = 'file' and coalesce(m.mime_type, o.content_type, '') not like 'image/%'
  ) then
    raise exception 'IMAGE_UNSUPPORTED_FORMAT' using errcode = '55000';
  end if;
  with recursive tree(id, depth) as (
    select m.id, 0 from public.team_materials m
    join jsonb_array_elements_text(i.sources) source(id) on m.id = source.id::uuid
    where m.team_id = j.team_id and m.connection_id is null and m.lifecycle = 'active'
    union
    select child.id, tree.depth + 1 from tree
    join public.team_materials folder on folder.id = tree.id and folder.kind = 'folder'
    join public.team_materials child on child.team_id = j.team_id and child.connection_id is null
      and child.lifecycle = 'active' and child.parent_folder_id = tree.id::text
    where tree.depth < 64
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'materialId', picture.id, 'name', picture.name, 'size', picture.byte_size,
      'mime', picture.mime, 'contentId', picture.content_id) order by picture.id), '[]'::jsonb)
    into page
  from (
    select distinct m.id, m.name, o.byte_size, coalesce(m.mime_type, o.content_type) as mime, o.content_id
    from tree
    join public.team_materials m on m.id = tree.id and m.kind = 'file'
    join public.space_objects o on o.id = m.space_object_id and o.team_id = j.team_id
      and o.kind = 'original' and o.state = 'committed'
    where coalesce(m.mime_type, o.content_type) like 'image/%'
      and (p_after is null or m.id > p_after)
    order by m.id
    limit p_limit + 1) picture;
  return jsonb_build_object(
    'items', case when jsonb_array_length(page) > p_limit then page - p_limit else page end,
    'hasMore', jsonb_array_length(page) > p_limit);
end;
$$;

-- The object a staged picture is read from: the file is live in this R2 space, the person may
-- still download from it, and it still holds the content it was staged with.
create function public.service_catalog_image_space_source(
  p_team uuid, p_actor uuid, p_material uuid, p_content text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  o public.space_objects%rowtype;
begin
  if not private.space_is_r2(p_team) then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  if p_actor is null or not private.can(p_team, 'download', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  select object.* into o
  from public.team_materials m
  join public.space_objects object on object.id = m.space_object_id and object.team_id = m.team_id
  where m.id = p_material and m.team_id = p_team and m.connection_id is null and m.lifecycle = 'active'
    and object.kind = 'original' and object.state = 'committed' and object.content_id = p_content;
  if o.id is null then raise exception 'IMAGE_SOURCE_CHANGED' using errcode = '55000'; end if;
  return jsonb_build_object('key', o.r2_key, 'size', o.byte_size);
end;
$$;

revoke all on function public.service_catalog_image_space_enumerate(uuid, text, bigint, uuid, integer) from public, anon, authenticated;
revoke all on function public.service_catalog_image_space_source(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_catalog_image_space_enumerate(uuid, text, bigint, uuid, integer) to service_role;
grant execute on function public.service_catalog_image_space_source(uuid, uuid, uuid, text) to service_role;
