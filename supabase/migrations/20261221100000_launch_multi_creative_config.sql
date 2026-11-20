-- 062: a catalog Launch carries an ordered list of creatives of one kind.
--
-- The config keeps `materialId` / `creativeAlias` as a mirror of the first
-- creative, so every reader of `config->>'materialId'` stays correct for the
-- primary creative. This migration teaches the boundary about the list:
--   * save_launch_draft refuses a draft list that can never become valid
--     (bad ids, duplicates, mixed kinds, more creatives than products, the
--     "other" method with several creatives, a broken mirror);
--   * generation admission applies the full shared rule set
--     (packages/shared/src/team/launches/validation.ts parseLaunchCreatives);
--   * the source snapshot lists every creative material in creative order,
--     and its identity/equivalence covers all of them;
--   * the Launch list reports creativeCount / creativeKind;
--   * the pending catalog name reads "<stem>+N_v<n>_catalog".
-- Forward compatible: a config without `creatives` produces exactly the
-- snapshot, identity and name it produced before.
begin;

-- A positive JSON integer (JS Number.isSafeInteger semantics, 3.0 counts as 3).
create function private.launch_json_positive(p_value jsonb, p_max numeric)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value) = 'number'
    and (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
    and (p_value #>> '{}')::numeric between 1 and p_max, false);
$$;
revoke all on function private.launch_json_positive(jsonb, numeric) from public, anon, authenticated;

-- normalizeLaunchSub: NFC, trim Unicode space separators, inner runs -> '_',
-- at most 160 characters of [A-Za-z0-9_-]. The Zs class is spelled with chr()
-- so no tool or editor can silently turn an escape into an invisible literal.
create function private.launch_normalize_sub(p_value jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  zs constant text := '[' || chr(32) || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
    || chr(8239) || chr(8287) || chr(12288) || ']';
  t text;
begin
  if jsonb_typeof(p_value) is distinct from 'string' then return null; end if;
  t := normalize(p_value #>> '{}', NFC);
  t := regexp_replace(t, '^' || zs || '+|' || zs || '+$', '', 'g');
  t := regexp_replace(t, zs || '+', '_', 'g');
  if char_length(t) <= 160 and t ~ '^[A-Za-z0-9_-]+$' then return t; end if;
  return null;
end $$;
revoke all on function private.launch_normalize_sub(jsonb) from public, anon, authenticated;

-- The first failing rule of the creative list, or null. With p_draft the list
-- may be mid-edit: aliases, copies and the exact sum are checked at admission.
create function private.launch_creatives_error(p_config jsonb, p_draft boolean default false)
returns text language plpgsql immutable set search_path = '' as $$
declare
  raw jsonb; kind jsonb; item jsonb; ord bigint; seen text[] := '{}'; id text;
  k integer; total numeric := 0; n jsonb; v jsonb; catalog jsonb;
  alias text; first_id text; first_alias text;
begin
  if jsonb_typeof(p_config) is distinct from 'object' then return 'INVALID_INPUT'; end if;
  raw := p_config->'creatives'; kind := p_config->'creativeKind';
  if raw is null then
    return case when kind is null or p_draft then null else 'INVALID_INPUT' end;
  end if;
  if (kind is null and not p_draft) or (kind is not null and kind not in ('"video"'::jsonb, '"image"'::jsonb)) then
    return 'INVALID_INPUT';
  end if;
  if jsonb_typeof(raw) <> 'array' then return 'INVALID_INPUT'; end if;
  k := jsonb_array_length(raw);
  if k = 0 then return case when p_draft then null else 'INVALID_INPUT' end; end if;
  if k > 400 then return 'CREATIVES_LIMIT'; end if;
  if p_config->>'method' = 'other' and k <> 1 then return 'CREATIVES_LIMIT'; end if;
  for item, ord in select x.value, x.ordinality from jsonb_array_elements(raw) with ordinality x loop
    if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'materialId') is distinct from 'string'
       or item->>'materialId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return 'INVALID_INPUT';
    end if;
    if not p_draft then
      alias := private.launch_normalize_sub(item->'alias');
      if alias is null then return 'LAUNCH_SUB_INVALID'; end if;
      if not private.launch_json_positive(item->'copies', 400) then return 'DISTRIBUTION_INVALID'; end if;
      if item->'pinned' is distinct from 'null'::jsonb and not private.launch_json_positive(item->'pinned', 9007199254740991) then
        return 'INVALID_INPUT';
      end if;
      total := total + (item->>'copies')::numeric;
    end if;
    id := lower(item->>'materialId');
    if id = any(seen) then return 'CREATIVE_DUPLICATE'; end if;
    seen := seen || id;
    if ord = 1 then first_id := id; first_alias := alias; end if;
  end loop;
  if jsonb_typeof(p_config->'materialId') is distinct from 'string' or lower(p_config->>'materialId') <> first_id
     or (not p_draft and first_alias is distinct from private.launch_normalize_sub(p_config->'creativeAlias')) then
    return 'INVALID_INPUT';
  end if;
  if p_config->>'method' = 'catalog' then
    catalog := case when jsonb_typeof(p_config->'catalog') = 'object' then p_config->'catalog' else null end;
    n := catalog->'productCount';
    if p_draft then
      if jsonb_typeof(n) = 'number' and (n #>> '{}')::numeric < k then return 'DISTRIBUTION_INVALID'; end if;
      return null;
    end if;
    if jsonb_typeof(n) is distinct from 'number' or total <> (n #>> '{}')::numeric or (n #>> '{}')::numeric < k then
      return 'DISTRIBUTION_INVALID';
    end if;
    if kind = '"image"'::jsonb and catalog->'restitchEnabled' = 'true'::jsonb then return 'INVALID_INPUT'; end if;
    v := catalog->'videoVariationCount';
    if kind = '"video"'::jsonb and catalog->'restitchEnabled' = 'true'::jsonb
       and catalog->'catalogVideoProtocolVersion' = '1'::jsonb
       and (jsonb_typeof(v) is distinct from 'number' or (v #>> '{}')::numeric < k or (v #>> '{}')::numeric > (n #>> '{}')::numeric) then
      return 'VARIATIONS_RANGE';
    end if;
  end if;
  return null;
end $$;
revoke all on function private.launch_creatives_error(jsonb, boolean) from public, anon, authenticated;

-- Every creative material this space knows must be of the declared kind; with
-- no declared kind the known ones must agree. Call after launch_creatives_error.
create function private.launch_creatives_kind_error(p_team uuid, p_config jsonb)
returns text language sql stable security definer set search_path = '' as $$
  select case when count(distinct k) > 1 or bool_or(k not in ('video', 'image')) then 'CREATIVES_MIXED' end
  from (
    select m.category k
      from jsonb_array_elements(case when jsonb_typeof(p_config->'creatives') = 'array' then p_config->'creatives' else '[]'::jsonb end) c
      join public.team_materials m on m.team_id = p_team and m.id = (c->>'materialId')::uuid
    union all
    select p_config->>'creativeKind' where p_config->>'creativeKind' is not null
      and jsonb_typeof(p_config->'creatives') = 'array' and jsonb_array_length(p_config->'creatives') > 0
  ) kinds;
$$;
revoke all on function private.launch_creatives_kind_error(uuid, jsonb) from public, anon, authenticated;

-- The draft boundary.
do $draft$
declare d text;
  anchor constant text := $find$ if nullif(p_config->>'launchDate','') is not null then d:=(p_config->>'launchDate')::date;end if;$find$;
begin
  select pg_get_functiondef('public.save_launch_draft(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure) into d;
  if strpos(d, anchor) = 0 then raise exception 'LAUNCH_DRAFT_CREATIVES_PATCH_MISSING'; end if;
  d := replace(d, anchor,
    $add$ result:=to_jsonb(coalesce(private.launch_creatives_error(p_config,true),private.launch_creatives_kind_error(p_team,p_config)));
 if result<>'null'::jsonb then raise exception '%',result#>>'{}' using errcode='22023';end if;
$add$ || anchor);
  execute d;
end $draft$;

-- The admission boundary: the full shared rule set on the exact draft being admitted.
do $admit$
declare d text;
  anchor constant text := $find$ if exists(select 1 from public.team_launch_generations where launch_id=p_launch and state not in('succeeded','canceled')) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;$find$;
begin
  select pg_get_functiondef('public.service_accept_launch_generation_unfenced(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) into d;
  if strpos(d, anchor) = 0 then raise exception 'LAUNCH_ADMISSION_CREATIVES_PATCH_MISSING'; end if;
  d := replace(d, anchor, anchor || $add$
 if private.launch_creatives_error(p_config,false) is not null then raise exception '%',private.launch_creatives_error(p_config,false) using errcode='22023';end if;
 if private.launch_creatives_kind_error(p_team,p_config) is not null then raise exception 'CREATIVES_MIXED' using errcode='22023';end if;$add$);
  execute d;
end $admit$;

-- Source snapshot: + materials[] in creative order when the config lists creatives.
create or replace function private.launch_sources_from_config(p_team uuid, p_config jsonb, p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.team_account_agents%rowtype;s public.team_accounts%rowtype;m public.team_materials%rowtype;o public.team_launch_offers%rowtype;b public.team_launch_buyers%rowtype;
 result jsonb;materials jsonb;found_count integer;same_kind boolean;err text;declared text;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into a from public.team_account_agents where id=(p_config->>'agentRowId')::uuid and team_id=p_team;
 select * into s from public.team_accounts where id=a.account_id and team_id=p_team;
 select * into m from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team and lifecycle='active' and kind='file' and category in('video','image');
 select * into o from public.team_launch_offers where id=(p_config->>'offerId')::uuid and team_id=p_team and archived_at is null;
 select * into b from public.team_launch_buyers where id=(p_config->>'buyerId')::uuid and team_id=p_team and archived_at is null;
 if a.id is null or s.id is null or m.id is null or o.id is null or b.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 result:=jsonb_build_object('schemaVersion',1,'agentRowId',a.id,'accountId',s.id,'social',s.name,'agentId',a.agent_id,'offerId',o.id,'offer',o.name,'buyerId',b.id,'buyer',b.value,'materialId',m.id,'materialType',m.category,'materialVersion',m.drive_version,'materialChecksum',case when m.checksum ~* '^[0-9a-f]{32}$' then lower(m.checksum) else null end,'materialDriveFileId',m.drive_file_id,'catalogSettingsVersion',case when p_config->>'method'='catalog' then private.launch_catalog_settings_version(p_team) else null end,'restitchSettingsVersion',case when p_config->>'method'='catalog' and p_config->'catalog'->>'restitchEnabled'='true' then private.launch_restitch_settings_version(p_team,p_actor) else null end);
 if jsonb_typeof(p_config->'creatives')='array' and jsonb_array_length(p_config->'creatives')>0 then
  err:=private.launch_creatives_error(p_config,true);
  if err is not null then raise exception '%',err using errcode='22023';end if;
  declared:=coalesce(p_config->>'creativeKind',m.category);
  select jsonb_agg(jsonb_build_object('materialId',x.id,'type',x.category,'version',x.drive_version,
           'checksum',case when x.checksum ~* '^[0-9a-f]{32}$' then lower(x.checksum) else null end)
           ||case when x.drive_file_id is null then '{}'::jsonb else jsonb_build_object('driveFileId',x.drive_file_id) end
         order by c.ord),
         count(x.id),coalesce(bool_and(x.category=declared),false)
    into materials,found_count,same_kind
    from jsonb_array_elements(p_config->'creatives') with ordinality c(item,ord)
    left join public.team_materials x on x.id=(c.item->>'materialId')::uuid and x.team_id=p_team
     and x.lifecycle='active' and x.kind='file' and x.category in('video','image');
  if found_count<>jsonb_array_length(p_config->'creatives') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  if not same_kind then raise exception 'CREATIVES_MIXED' using errcode='22023';end if;
  result:=result||jsonb_build_object('materials',materials);
 end if;
 return result;
end $$;
revoke all on function private.launch_sources_from_config(uuid, jsonb, uuid) from public, anon, authenticated;

-- Identity of one material entry of materials[] in the shape of the top-level identity.
create function private.launch_material_entry_identity(p_entry jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select private.launch_material_identity(jsonb_build_object('materialChecksum',p_entry->'checksum',
    'materialDriveFileId',p_entry->'driveFileId','materialVersion',p_entry->'version'));
$$;
revoke all on function private.launch_material_entry_identity(jsonb) from public, anon, authenticated;

-- One creative keeps the identity it always had (reuse of restitched videos compares
-- it with single-material identities). Several creatives: the list of identities, so
-- a retry notices a change of any creative and reuse never matches a single video.
do $identity$
declare d text;
  body_old constant text := $find$ select case when p_sources->>'materialChecksum' ~* '^[0-9a-f]{32}$' then jsonb_build_array(p_sources->>'materialDriveFileId','md5:'||lower(p_sources->>'materialChecksum')) when p_sources->>'materialVersion' is not null then jsonb_build_array(p_sources->>'materialDriveFileId','version:'||(p_sources->>'materialVersion')) else null end;$find$;
begin
  select prosrc into d from pg_proc where oid = 'private.launch_material_identity(jsonb)'::regprocedure;
  if strpos(d, body_old) = 0 then raise exception 'LAUNCH_MATERIAL_IDENTITY_PATCH_MISSING'; end if;
end $identity$;
create or replace function private.launch_material_identity(p_sources jsonb)
returns jsonb language sql immutable set search_path = '' as $$
 select case
  when jsonb_typeof(p_sources->'materials')='array' and jsonb_array_length(p_sources->'materials')>1 then
   (select case when bool_and(private.launch_material_entry_identity(e.value) is not null)
     then jsonb_agg(private.launch_material_entry_identity(e.value) order by e.ordinality) end
     from jsonb_array_elements(p_sources->'materials') with ordinality e)
  when p_sources->>'materialChecksum' ~* '^[0-9a-f]{32}$' then jsonb_build_array(p_sources->>'materialDriveFileId','md5:'||lower(p_sources->>'materialChecksum'))
  when p_sources->>'materialVersion' is not null then jsonb_build_array(p_sources->>'materialDriveFileId','version:'||(p_sources->>'materialVersion'))
  else null end;
$$;

-- materials[] without the Drive version of entries whose content checksum is known.
create function private.launch_materials_versionless(p_materials jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_materials)='array' then
    (select coalesce(jsonb_agg(case when e.value->>'checksum' ~* '^[0-9a-f]{32}$' then e.value-'version' else e.value end order by e.ordinality),'[]'::jsonb)
       from jsonb_array_elements(p_materials) with ordinality e)
  else p_materials end;
$$;
revoke all on function private.launch_materials_versionless(jsonb) from public, anon, authenticated;

create or replace function private.launch_sources_equivalent(p_before jsonb, p_after jsonb)
returns boolean language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(p_before)='object' and jsonb_typeof(p_after)='object' and
  (p_before=p_after or (p_before->>'materialChecksum' ~* '^[0-9a-f]{32}$'
   and p_after->>'materialChecksum' ~* '^[0-9a-f]{32}$'
   and private.launch_material_identity(p_before)=private.launch_material_identity(p_after)
   and (p_before-'materialVersion'-'materials')=(p_after-'materialVersion'-'materials')
   and private.launch_materials_versionless(p_before->'materials') is not distinct from private.launch_materials_versionless(p_after->'materials'))),false);
$$;

-- The Launch list: how many creatives and of which kind.
do $list$
declare d text;
  anchor constant text := $find$'creativeAlias', coalesce(r.config->>'creativeAlias', l.draft_config->>'creativeAlias', ''),$find$;
begin
  select pg_get_functiondef('private.list_launches_pre_assignment(uuid,jsonb,integer)'::regprocedure) into d;
  if strpos(d, anchor) = 0 then raise exception 'LAUNCH_LIST_CREATIVES_PATCH_MISSING'; end if;
  d := replace(d, anchor, anchor || $add$
        'creativeCount', greatest(1, case when r.id is not null then
            case when jsonb_typeof(r.config->'creatives') = 'array' then jsonb_array_length(r.config->'creatives') else 1 end
          when jsonb_typeof(l.draft_config->'creatives') = 'array' then jsonb_array_length(l.draft_config->'creatives') else 1 end),
        'creativeKind', case when coalesce(r.config->>'creativeKind', l.draft_config->>'creativeKind', r.sources->>'materialType') in ('video', 'image')
            then coalesce(r.config->>'creativeKind', l.draft_config->>'creativeKind', r.sources->>'materialType') else null end,$add$);
  execute d;
end $list$;

-- The creative count of a generation's admitted config (1 for configs without a list).
create function private.launch_generation_creative_count(p_team uuid, p_generation uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select case when jsonb_typeof(r.config->'creatives') = 'array' and jsonb_array_length(r.config->'creatives') > 0
                    then jsonb_array_length(r.config->'creatives') else 1 end
     from public.team_launch_generations g
     join public.team_launch_revisions r on r.id = g.revision_id and r.team_id = g.team_id
    where g.id = p_generation and g.team_id = p_team), 1);
$$;
revoke all on function private.launch_generation_creative_count(uuid, uuid) from public, anon, authenticated;

-- The name from the reservation until the catalog's own name plan exists:
-- "<stem of the first creative>+N_v<n>_catalog" when there are N more creatives.
create or replace function public.get_launch(p_team uuid, p_launch uuid, p_revision uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare detail_value jsonb; reserved text; generation uuid; v integer; video_name text; k integer;
begin
  detail_value := private.get_launch_before_bulk(p_team, p_launch, p_revision);
  if p_revision is null then
    generation := nullif(detail_value#>>'{generation,id}', '')::uuid;
    select i.checkpoint#>>'{namePlan,name}' into reserved from private.catalog_generation_intents i
     where i.team_id = p_team and i.request_key = 'launch:' || generation::text || ':catalog';
    if reserved is null and generation is not null then
      select coalesce(i.variant, r.variant), m.name into v, video_name
        from private.launch_catalog_name_reservations r
        join public.team_materials m on m.team_id = r.team_id and m.id = r.video_material_id
        left join private.catalog_generation_intents i
          on i.team_id = r.team_id and i.request_key = 'launch:' || r.generation_id::text || ':catalog'
         and i.state <> 'canceled'
       where r.generation_id = generation and r.team_id = p_team;
      if v is not null and video_name is not null then
        k := private.launch_generation_creative_count(p_team, generation);
        video_name := regexp_replace(btrim(normalize(video_name, NFC)), '\s+', ' ', 'g');
        reserved := coalesce(nullif(regexp_replace(video_name, '\.[^.]+$', ''), ''), video_name)
          || case when k > 1 then '+' || (k - 1)::text else '' end
          || '_v' || v::text || '_catalog';
      end if;
    end if;
  end if;
  return detail_value || jsonb_build_object('pendingCatalogName', reserved);
end $$;
revoke all on function public.get_launch(uuid, uuid, uuid) from public, anon;
grant execute on function public.get_launch(uuid, uuid, uuid) to authenticated, service_role;

commit;
