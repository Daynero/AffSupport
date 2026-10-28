-- Keep accepted v1 catalog payloads byte-compatible through a v2 server release.
-- This is an operational read under service role, never an analytics writer.
create function public.service_catalog_image_request_version_v2(
  p_team uuid, p_video uuid, p_actor uuid, p_key text
) returns integer language plpgsql security definer set search_path='' as $$
declare existing private.catalog_generation_intents%rowtype; version integer;
begin
  if p_actor is null or not private.can(p_team,'view',p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  select * into existing from private.catalog_generation_intents
    where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key;
  if not found then return null; end if;
  version:=coalesce((existing.request_payload->>'catalogImageContractVersion')::integer,1);
  if version not in(1,2) then raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED'; end if;
  return version;
end $$;
revoke all on function public.service_catalog_image_request_version_v2(uuid,uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.service_catalog_image_request_version_v2(uuid,uuid,uuid,text)
  to service_role;

-- Preserve the old wire shape while refusing stale settings mutations on a v2 pool.
alter function public.set_team_product_catalog_image_sources(uuid,jsonb) set schema private;
alter function private.set_team_product_catalog_image_sources(uuid,jsonb)
  rename to catalog_image_sources_v1;
revoke all on function private.catalog_image_sources_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;
create function public.set_team_product_catalog_image_sources(p_team uuid,p_items jsonb)
returns integer language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.can(p_team,'manage_metadata',auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||p_team::text,0));
  if exists(select 1 from private.catalog_image_config where team_id=p_team and mode='v2') then
    raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED' using errcode='55000';
  end if;
  return private.catalog_image_sources_v1(p_team,p_items);
end $$;
revoke all on function public.set_team_product_catalog_image_sources(uuid,jsonb)
  from public,anon;
grant execute on function public.set_team_product_catalog_image_sources(uuid,jsonb)
  to authenticated;

-- Enforce fresh-version admission atomically with durable intent creation as well.
-- A preflight mode read alone has a race with the first pool admission.
alter function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid) set schema private;
alter function private.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid)
  rename to catalog_image_begin_intent_legacy;
revoke all on function private.catalog_image_begin_intent_legacy(uuid,uuid,uuid,text,jsonb,uuid)
  from public,anon,authenticated,service_role;
create function public.service_begin_catalog_intent(
  p_team uuid,p_video uuid,p_actor uuid,p_key text,p_payload jsonb,p_owner uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  -- Same lock as admission serializes mode transition and fresh-intent admission.
  perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||p_team::text,0));
  if exists(select 1 from private.catalog_image_config where team_id=p_team and mode='v2')
     and coalesce(p_payload->>'catalogImageContractVersion','1')<>'2'
     and not exists(select 1 from private.catalog_generation_intents
       where team_id=p_team and video_material_id=p_video and actor_id=p_actor and request_key=p_key) then
    raise exception 'CATALOG_IMAGE_UPGRADE_REQUIRED' using errcode='55000';
  end if;
  return private.catalog_image_begin_intent_legacy(p_team,p_video,p_actor,p_key,p_payload,p_owner);
end $$;
revoke all on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function public.service_begin_catalog_intent(uuid,uuid,uuid,text,jsonb,uuid) to service_role;

-- Reconciliation must not complete a previously unknown external write while its
-- R2 use receipt still points at a revoked publication. Preserve the old row and
-- RPC shapes; image checks and completion share this transaction's row locks.
alter function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text) set schema private;
alter function private.service_resolve_catalog_reconciliation(uuid,uuid,text,text)
  rename to catalog_image_resolve_reconciliation_v1;
revoke all on function private.catalog_image_resolve_reconciliation_v1(uuid,uuid,text,text)
  from public,anon,authenticated,service_role;
create function public.service_resolve_catalog_reconciliation(
  p_item uuid,p_marker uuid,p_outcome text,p_worker text
) returns boolean language plpgsql security definer set search_path='' as $$
declare team uuid; attempt uuid; resolved boolean; snapshot jsonb; images jsonb;
begin
  select settings_snapshot into snapshot from private.catalog_update_reconciliations
    where catalog_material_id=p_item and marker=p_marker for update;
  if not found then return false; end if;
  select i.team_id,a.attempt_id into team,attempt
    from public.team_catalog_updater_items i
    left join public.team_catalog_update_attempts a
      on a.catalog_material_id=i.catalog_material_id and a.round_due_at=i.round_due_at
    where i.catalog_material_id=p_item;
  if p_outcome='delivered' and attempt is not null then
    perform public.service_catalog_image_validate_uses_v2(team,attempt);
  end if;
  if p_outcome='delivered' and jsonb_typeof(snapshot->'rows')='array' then
    select coalesce(jsonb_agg(r.value->'pictureImage'),'[]'::jsonb) into images
      from jsonb_array_elements(snapshot->'rows') as r(value) where r.value ? 'pictureImage';
    if jsonb_array_length(images)>0 then
      if team is null then select team_id into team from public.team_product_catalogs where material_id=p_item; end if;
      if team is null then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
      -- Draw advisory + deterministic publication locks precede the legacy item's mutation.
      perform public.service_catalog_image_validate_rows_v2(team,images);
    end if;
  end if;
  resolved:=private.catalog_image_resolve_reconciliation_v1(p_item,p_marker,p_outcome,p_worker);
  if resolved and p_outcome='delivered' and attempt is not null then
    perform public.service_catalog_image_finalize_uses_v2(team,attempt,true);
  end if;
  return resolved;
end $$;
revoke all on function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text)
  to service_role;

-- Retained images may belong to an earlier attempt with no current use receipt.
-- Keep the legacy RPC shape, but gate every outgoing R2 row and completion atomically.
alter function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) set schema private;
alter function private.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb)
  rename to catalog_image_complete_update_v1;
revoke all on function private.catalog_image_complete_update_v1(uuid,text,integer,uuid,integer,jsonb)
  from public,anon,authenticated,service_role;
create function public.service_complete_catalog_update(
 p_item uuid,p_worker text,p_update_count integer,p_swapped_copy uuid default null,
 p_product_count integer default null,p_settings_snapshot jsonb default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare team uuid; images jsonb:='[]'::jsonb;
begin
 if jsonb_typeof(p_settings_snapshot->'rows')='array' then
  select coalesce(jsonb_agg(r.value->'pictureImage'),'[]'::jsonb) into images
   from jsonb_array_elements(p_settings_snapshot->'rows') as r(value) where r.value ? 'pictureImage';
 end if;
 if jsonb_array_length(images)>0 then
  select team_id into team from public.team_product_catalogs where material_id=p_item;
  if team is null then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
  perform public.service_catalog_image_validate_rows_v2(team,images);
 end if;
 return private.catalog_image_complete_update_v1(p_item,p_worker,p_update_count,p_swapped_copy,p_product_count,p_settings_snapshot);
end $$;
revoke all on function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb)
 from public,anon,authenticated;
grant execute on function public.service_complete_catalog_update(uuid,text,integer,uuid,integer,jsonb) to service_role;
