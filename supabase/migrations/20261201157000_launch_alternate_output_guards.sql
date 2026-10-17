-- Guard alternate upload/version writes and late generic catalog replacement.
create function private.guard_launch_output_intent() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.team_materials where team_id=new.team_id and id in(new.replace_material_id,new.version_of_material_id) order by id for update;
 if private.launch_output_is_referenced(new.team_id,new.replace_material_id) or private.launch_output_is_referenced(new.team_id,new.version_of_material_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $$;
create trigger team_operation_intents_launch_output_guard before insert or update on private.team_operation_intents
 for each row execute function private.guard_launch_output_intent();
revoke all on function private.guard_launch_output_intent() from public,anon,authenticated,service_role;
create or replace function public.service_link_product_catalog_companion(
  p_team uuid,
  p_video uuid,
  p_companion uuid,
  p_replaces uuid,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  video_row public.team_materials%rowtype;
  companion_row public.team_materials%rowtype;
  replaced_row public.team_materials%rowtype;
  v_source_link text := p_record ->> 'sourceLink';
  v_product_count text := p_record ->> 'productCount';
  v_sheet_url text := p_record ->> 'sheetUrl';
  v_video_link text := p_record ->> 'videoLink';
  v_variant_text text := p_record ->> 'variant';
  v_snapshot jsonb := p_record -> 'settingsSnapshot';
  v_created_by uuid;
  v_variant integer;
  retired jsonb := '[]'::jsonb;
  existing jsonb;
begin
  if p_record is null
     or jsonb_typeof(p_record) <> 'object'
     or v_source_link is null
     or v_sheet_url is null
     or v_video_link is null
     or v_product_count is null
     or v_product_count !~ '^[0-9]{1,3}$'
     or (v_variant_text is not null and v_variant_text !~ '^[0-9]{1,4}$')
     or jsonb_typeof(v_snapshot) is distinct from 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_created_by := nullif(p_record ->> 'createdBy', '')::uuid;

  if p_replaces is not null and private.launch_output_is_referenced(p_team,p_replaces) then
    raise exception 'WRONG_STATE' using errcode='55000';
  end if;

  -- The video row is the lock every variation of it takes, so two creates number in turn.
  select * into video_row from public.team_materials as material
  where material.id = p_video and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  select * into companion_row from public.team_materials as material
  where material.id = p_companion and material.team_id = p_team and material.lifecycle = 'active'
  for update;
  if video_row.id is null
     or companion_row.id is null
     or video_row.category is distinct from 'video'
     or companion_row.mime_type is distinct from 'application/vnd.google-apps.spreadsheet'
     or companion_row.companion_of is not null then
    return jsonb_build_object(
      'linked', false, 'reason', 'NOT_ELIGIBLE', 'existing', null, 'discarded', null,
      'retired', '[]'::jsonb
    );
  end if;

  if p_replaces is not null then
    select * into replaced_row from public.team_materials as material
    where material.id = p_replaces
      and material.team_id = p_team
      and material.companion_of = p_video
      and material.companion_kind = 'product_catalog'
      and material.lifecycle = 'active'
    for update;

    if replaced_row.id is null then
      update public.team_materials as sheet
         set lifecycle = 'trashed',
             trashed_at = pg_catalog.clock_timestamp(),
             updated_at = pg_catalog.clock_timestamp()
       where sheet.id = p_companion and sheet.team_id = p_team;
      select jsonb_build_object(
               'id', live.id,
               'name', live.name,
               'sheetUrl', record.sheet_url,
               'sourceLink', record.source_link,
               'productCount', record.product_count,
               'variant', record.variant,
               'createdAt', record.created_at
             )
        into existing
      from public.team_materials as live
      join public.team_product_catalogs as record on record.material_id = live.id
      where live.team_id = p_team
        and live.companion_of = p_video
        and live.companion_kind = 'product_catalog'
        and live.lifecycle = 'active'
      order by record.created_at desc
      limit 1;
      insert into public.team_catalog_events (team_id, material_id, event_kind)
      values (p_team, p_companion, 'upserted');
      return jsonb_build_object(
        'linked', false,
        'reason', 'EXISTS',
        'existing', existing,
        'discarded', jsonb_build_object(
          'materialId', companion_row.id,
          'driveFileId', companion_row.drive_file_id,
          'resourceKey', companion_row.resource_key
        ),
        'retired', '[]'::jsonb
      );
    end if;

    select record.variant into v_variant
    from public.team_product_catalogs as record
    where record.material_id = replaced_row.id;

    update public.team_materials as previous
       set lifecycle = 'trashed',
           trashed_at = pg_catalog.clock_timestamp(),
           companion_of = null,
           companion_kind = null,
           updated_at = pg_catalog.clock_timestamp()
     where previous.id = replaced_row.id;
    retired := jsonb_build_array(
      jsonb_build_object(
        'materialId', replaced_row.id,
        'driveFileId', replaced_row.drive_file_id,
        'resourceKey', replaced_row.resource_key
      )
    );
  end if;

  if v_variant is null then
    v_variant := coalesce(
      v_variant_text::integer,
      public.service_next_product_catalog_variant(p_team, p_video)
    );
  end if;

  update public.team_materials as sheet
     set companion_of = p_video,
         companion_kind = 'product_catalog',
         updated_at = pg_catalog.clock_timestamp()
   where sheet.id = p_companion and sheet.team_id = p_team;

  insert into public.team_product_catalogs (
    material_id, team_id, video_material_id, source_link, product_count, sheet_url,
    video_link, settings_snapshot, created_by, variant
  )
  values (
    p_companion, p_team, p_video, v_source_link, v_product_count::smallint, v_sheet_url,
    v_video_link, v_snapshot, v_created_by, v_variant
  )
  on conflict (material_id) do update
    set video_material_id = excluded.video_material_id,
        source_link = excluded.source_link,
        product_count = excluded.product_count,
        sheet_url = excluded.sheet_url,
        video_link = excluded.video_link,
        settings_snapshot = excluded.settings_snapshot,
        created_by = excluded.created_by,
        variant = excluded.variant;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, p_companion, 'upserted'), (p_team, p_video, 'upserted');
  return jsonb_build_object('linked', true, 'retired', retired, 'variant', v_variant);
end;
$$;


-- Folder trash takes the same ordered locks as a new historical reference.
create or replace function private.guard_launch_output_operation() returns trigger language plpgsql security definer set search_path='' as $$
declare affected uuid[];
begin
 if new.kind not in('rename','move','content_edit','new_version','trash') or new.source_material_id is null then return new;end if;
 if new.kind='trash' and exists(select 1 from public.team_materials where id=new.source_material_id and team_id=new.team_id and kind='folder') then
  with recursive descendants(id,drive_file_id,connection_id) as (
   select id,drive_file_id,connection_id from public.team_materials where id=new.source_material_id and team_id=new.team_id
   union select m.id,m.drive_file_id,m.connection_id from public.team_materials m join descendants d
    on m.parent_folder_id=d.drive_file_id and m.connection_id=d.connection_id where m.team_id=new.team_id
  ) select array_agg(id order by id) into affected from descendants;
 else affected:=array[new.source_material_id];end if;
 perform 1 from public.team_materials where team_id=new.team_id and id=any(affected) order by id for update;
 if exists(select 1 from unnest(affected) id where private.launch_output_is_referenced(new.team_id,id)) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $$;
create function private.guard_launch_catalog_ancestors() returns trigger language plpgsql security definer set search_path='' as $$
declare ancestors uuid[];
begin
 with recursive parents(id,parent_folder_id,connection_id) as (
  select id,parent_folder_id,connection_id from public.team_materials where team_id=new.team_id and id in(new.material_id,new.restitch_material_id)
  union select m.id,m.parent_folder_id,m.connection_id from public.team_materials m join parents p
   on m.drive_file_id=p.parent_folder_id and m.connection_id=p.connection_id where m.team_id=new.team_id
 ) select array_agg(id order by id) into ancestors from parents;
 perform 1 from public.team_materials where team_id=new.team_id and id=any(ancestors) order by id for update;
 if exists(select 1 from public.team_operations where team_id=new.team_id and source_material_id=any(ancestors) and kind='trash' and state in('pending','running'))
  or exists(select 1 from private.orphan_cleanups where material_id in(new.material_id,new.restitch_material_id) and lease_expires_at>clock_timestamp()) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 return new;
end $$;
create trigger team_launch_catalog_ancestors_guard before insert on public.team_launch_revision_catalogs for each row execute function private.guard_launch_catalog_ancestors();
revoke all on function private.guard_launch_catalog_ancestors() from public,anon,authenticated,service_role;
