-- Feature 024, US15 — a video's catalogs are variations.
--
-- One video runs on several ad accounts, each with its own tracking link, so it needs several
-- catalogs. 022 allowed one: the one-live-companion index refused a second, and the link RPC
-- answered a second create with the first. Now a video holds any number of live catalogs, each a
-- numbered variation named `<video>_v<N>_catalog` on Drive and, by the owner's habit, on Meta.
--
-- What changes:
--   team_product_catalogs.variant                the variation's number; existing rows are 1
--   team_materials_one_companion_idx             narrowed back to what it was written for:
--                                                one live *transcript* per video
--   list_material_product_catalogs               every live catalog of a video, by number
--   service_next_product_catalog_variant         the number a new variation takes
--   service_link_product_catalog_companion       links beside the others; a re-create retires
--                                                only the catalog it names
--
-- Numbers are never handed out twice for a video while the rows remember them: a removed `v2`
-- may still be the name of a live catalog on Meta, and a second `v2` would be the confusion the
-- numbering exists to prevent.
--
-- Additive for the released client: `get_material_product_catalog` still answers with the newest
-- live catalog. Forward-only; reverse steps in ROLLBACK.md.

alter table public.team_product_catalogs
  add column if not exists variant integer;

update public.team_product_catalogs set variant = 1 where variant is null;

alter table public.team_product_catalogs
  alter column variant set default 1,
  alter column variant set not null;

alter table public.team_product_catalogs
  drop constraint if exists team_product_catalogs_variant_check;
alter table public.team_product_catalogs
  add constraint team_product_catalogs_variant_check check (variant between 1 and 9999);

grant select (variant) on public.team_product_catalogs to authenticated;

-- One live transcript per video, as 20260830100000 said in its comment; catalogs are many.
drop index if exists public.team_materials_one_companion_idx;
create unique index if not exists team_materials_one_transcript_idx
  on public.team_materials (team_id, companion_of)
  where companion_of is not null and companion_kind = 'transcript' and lifecycle = 'active';

-- ---------------------------------------------------------------------------------------------
-- Every live catalog of a video, for anyone who can see the video.

create or replace function public.list_material_product_catalogs(p_team uuid, p_video uuid)
returns table (
  id uuid,
  name text,
  drive_file_id text,
  sheet_url text,
  source_link text,
  product_count smallint,
  variant integer,
  created_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select sheet.id,
         sheet.name,
         sheet.drive_file_id,
         record.sheet_url,
         record.source_link,
         record.product_count,
         record.variant,
         record.created_at
  from public.team_materials as sheet
  join public.team_product_catalogs as record on record.material_id = sheet.id
  where sheet.team_id = p_team
    and sheet.companion_of = p_video
    and sheet.companion_kind = 'product_catalog'
    and sheet.lifecycle = 'active'
    and private.can(p_team, 'view', auth.uid())
  order by record.variant, record.created_at;
$$;

-- The number a new variation of this video takes: one past the highest it ever had.
create or replace function public.service_next_product_catalog_variant(p_team uuid, p_video uuid)
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(max(record.variant), 0) + 1
  from public.team_product_catalogs as record
  where record.team_id = p_team and record.video_material_id = p_video;
$$;

/*
 * Links a freshly created sheet to its video as one of its product catalogs.
 *
 * `p_replaces` null makes a new variation: it is linked beside whatever else the video has, with
 * the number in `p_record.variant` (the one the sheet was named with) or, failing that, the next
 * free one. `p_replaces` naming a live catalog of the video re-creates that variation: the new
 * sheet takes its number and only it is retired. Naming one that is no longer live — somebody
 * re-created or removed it first — loses: the new sheet is trashed and returned as `discarded`,
 * and the newest live catalog comes back as `existing`.
 */
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

revoke all on function public.list_material_product_catalogs(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_next_product_catalog_variant(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.list_material_product_catalogs(uuid, uuid) to authenticated;
grant execute on function public.service_next_product_catalog_variant(uuid, uuid) to service_role;
grant execute on function public.service_link_product_catalog_companion(uuid, uuid, uuid, uuid, jsonb)
  to service_role;
