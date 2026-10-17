-- Reference writers and the orphan claimant serialize on the intent row.
-- A new reference cancels a waiting intent; a claimed file cannot acquire one
-- while an HTTP provider call might already be in flight.
create function private.guard_task_orphan_reference()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ref uuid; key text; raw text; item record;
begin
  foreach key in array tg_argv loop
    if position('.' in key)>0 then
      raw:=to_jsonb(new)->split_part(key,'.',1)->>split_part(key,'.',2);
    else
      raw:=to_jsonb(new)->>key;
    end if;
    if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then continue; end if;
    ref:=raw::uuid;
    for item in select i.id,i.state from private.team_task_orphan_intents i
      where i.team_id=new.team_id and i.material_id=ref
        and i.state in ('waiting','claimed') for update
    loop
      if item.state='claimed' then
        raise exception 'WRONG_STATE' using errcode='55000';
      end if;
      update private.team_task_orphan_intents i set state='cancelled',
        reason_code='NEW_REFERENCE',updated_at=clock_timestamp() where i.id=item.id;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function private.guard_task_orphan_reference()
  from public, anon, authenticated;

-- The known material-id fields used by tasks, library, catalogs and Launches.
create trigger orphan_ref_material_links before insert or update on public.team_material_links
  for each row execute function private.guard_task_orphan_reference('source_material_id','derivative_material_id');
create trigger orphan_ref_companion before insert or update on public.team_materials
  for each row execute function private.guard_task_orphan_reference('companion_of');
create trigger orphan_ref_requirements before insert or update on public.team_library_requirements
  for each row execute function private.guard_task_orphan_reference('source_material_id');
create trigger orphan_ref_results before insert or update on public.team_library_results
  for each row execute function private.guard_task_orphan_reference('source_material_id','material_id');
create trigger orphan_ref_catalog_images before insert or update on public.team_product_catalog_image_sources
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_restitch_sources before insert or update on public.team_restitch_sources
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_product_catalogs before insert or update on public.team_product_catalogs
  for each row execute function private.guard_task_orphan_reference('material_id','video_material_id');
create trigger orphan_ref_restitch_copies before insert or update on public.team_catalog_restitch_copies
  for each row execute function private.guard_task_orphan_reference('material_id','catalog_material_id');
create trigger orphan_ref_landing_renders before insert or update on public.team_landing_renders
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_restitch_prep before insert or update on public.team_material_restitch_prep
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_operations before insert or update on public.team_operations
  for each row execute function private.guard_task_orphan_reference('source_material_id');
create trigger orphan_ref_launches before insert or update on public.team_launches
  for each row execute function private.guard_task_orphan_reference('draft_config.materialId','expected_source_snapshot.materialId');
create trigger orphan_ref_launch_revisions before insert or update on public.team_launch_revisions
  for each row execute function private.guard_task_orphan_reference('config.materialId','sources.materialId');
create trigger orphan_ref_launch_catalogs before insert or update on public.team_launch_revision_catalogs
  for each row execute function private.guard_task_orphan_reference('material_id','restitch_material_id');
create trigger orphan_ref_launch_steps before insert or update on public.team_launch_generation_steps
  for each row execute function private.guard_task_orphan_reference('result_material_id');
create trigger orphan_ref_group_intents before insert or update on private.team_material_group_intents
  for each row execute function private.guard_task_orphan_reference('source_material_id');
create trigger orphan_ref_library_attempts before insert or update on private.team_library_attempts
  for each row execute function private.guard_task_orphan_reference('result_material_id');
create trigger orphan_ref_operation_intents before insert or update on private.team_operation_intents
  for each row execute function private.guard_task_orphan_reference('replace_material_id','version_of_material_id');
create trigger orphan_ref_bulk_trash before insert or update on private.team_bulk_trash_items
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_transfer_grants before insert or update on private.team_transfer_grants
  for each row execute function private.guard_task_orphan_reference('material_id');
create trigger orphan_ref_catalog_updater before insert or update on public.team_catalog_updater_items
  for each row execute function private.guard_task_orphan_reference('catalog_material_id');
create trigger orphan_ref_catalog_generation before insert or update on private.catalog_generation_intents
  for each row execute function private.guard_task_orphan_reference('video_material_id','replaces_material_id');

create function private.guard_task_orphan_catalog_url()
returns trigger language plpgsql security definer set search_path = '' as $$
declare item record;
begin
  for item in select i.id,i.state from private.team_task_orphan_intents i
    join public.team_materials m on m.id=i.material_id and m.team_id=i.team_id
    where i.team_id=new.team_id and i.state in ('waiting','claimed')
      and (position(m.drive_file_id in coalesce(new.video_link,''))>0
        or position(m.drive_file_id in coalesce(new.current_video_link,''))>0)
    for update of i
  loop
    if item.state='claimed' then raise exception 'WRONG_STATE' using errcode='55000'; end if;
    update private.team_task_orphan_intents i set state='cancelled',
      reason_code='NEW_REFERENCE',updated_at=clock_timestamp() where i.id=item.id;
  end loop;
  return new;
end $$;
revoke all on function private.guard_task_orphan_catalog_url()
  from public, anon, authenticated;
create trigger orphan_ref_catalog_url before insert or update on public.team_product_catalogs
  for each row execute function private.guard_task_orphan_catalog_url();

create function private.guard_task_orphan_shortcut()
returns trigger language plpgsql security definer set search_path = '' as $$
declare item record;
begin
  if new.kind<>'shortcut' or new.lifecycle<>'active' or new.shortcut_target_id is null
  then return new; end if;
  for item in select i.id,i.state from private.team_task_orphan_intents i
    join public.team_materials m on m.id=i.material_id and m.team_id=i.team_id
    where i.team_id=new.team_id and i.state in ('waiting','claimed')
      and m.drive_file_id=new.shortcut_target_id for update of i
  loop
    if item.state='claimed' then raise exception 'WRONG_STATE' using errcode='55000'; end if;
    update private.team_task_orphan_intents i set state='cancelled',
      reason_code='NEW_REFERENCE',updated_at=clock_timestamp() where i.id=item.id;
  end loop;
  return new;
end $$;
revoke all on function private.guard_task_orphan_shortcut()
  from public, anon, authenticated;
create trigger orphan_ref_shortcut before insert or update on public.team_materials
  for each row execute function private.guard_task_orphan_shortcut();
