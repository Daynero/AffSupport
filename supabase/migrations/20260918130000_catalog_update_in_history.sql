-- Feature 024 US23 — an update a catalog gets is in the space's history.
--
-- The history recorded who made a catalog and never that anything happened to it again: a sheet
-- rewritten every hour, with new IDs, new pictures and new products, left no line at all. The
-- worker acts for the space rather than for a person, so it writes with no actor and a label of
-- its own; the panel shows "Soty" where a member's name would be.
-- Forward-only; ROLLBACK.md re-applies 20260918120000's completion and drops the writer.

-- The actor was required, because until now every event had one. A space's own machinery does
-- not; the label snapshot carries "Soty" in its place, and the reader already draws the snapshot.
alter table public.team_audit_events alter column actor_id drop not null;

create or replace function private.record_team_system_audit(
  p_team uuid, p_action text, p_target jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id uuid;
begin
  if p_team is null or p_action is null or char_length(p_action) not between 1 and 96
     or jsonb_typeof(coalesce(p_target, '{}'::jsonb)) <> 'object' then
    raise exception 'INVALID_AUDIT_EVENT' using errcode = '22023';
  end if;
  insert into public.team_audit_events (
    team_id, actor_id, actor_label_snapshot, action, target, result
  ) values (
    p_team, null, 'Soty', p_action, coalesce(p_target, '{}'::jsonb), 'succeeded'
  )
  returning id into audit_id;
  return audit_id;
end;
$$;

revoke all on function private.record_team_system_audit(uuid, text, jsonb)
  from public, anon, authenticated;

create or replace function public.service_complete_catalog_update(
  p_item uuid,
  p_worker text,
  p_update_count integer,
  p_swapped_copy uuid default null,
  p_product_count integer default null,
  p_settings_snapshot jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owning_team uuid;
  swapped public.team_catalog_restitch_copies;
begin
  update public.team_catalog_updater_items as item
     set round_due_at = null,
         attempts = 0,
         lease_owner = null,
         lease_expires_at = null,
         next_attempt_at = clock_timestamp()
   where item.catalog_material_id = p_item
     and item.lease_owner = p_worker
     and item.lease_expires_at > clock_timestamp()
  returning item.team_id into owning_team;
  if owning_team is null then return false; end if;

  update public.team_product_catalogs as record
     set update_count = greatest(record.update_count, p_update_count),
         last_updated_at = clock_timestamp(),
         last_update_error = null,
         product_count = case
           when p_product_count between 1 and 400 then p_product_count::smallint
           else record.product_count
         end,
         settings_snapshot = case
           when p_settings_snapshot is null then record.settings_snapshot
           else p_settings_snapshot
         end
   where record.material_id = p_item
     and p_update_count between record.update_count and record.update_count + 1;

  -- The sheet now points at this copy, whatever happened to it meanwhile: a spare retired by a stop
  -- during the round is brought back rather than deleted from under the sheet.
  if p_swapped_copy is not null then
    select * into swapped from public.team_catalog_restitch_copies as copy
    where copy.material_id = p_swapped_copy and copy.catalog_material_id = p_item
      and copy.role in ('spare', 'retired') and copy.shared_link is not null
    for update;
    if swapped.material_id is not null then
      update public.team_catalog_restitch_copies as copy
         set role = 'retired',
             retired_at = clock_timestamp(),
             next_delete_at = clock_timestamp()
       where copy.catalog_material_id = p_item and copy.role = 'in_use';
      update public.team_catalog_restitch_copies as copy
         set role = 'in_use', retired_at = null, next_delete_at = null
       where copy.material_id = swapped.material_id;
      update public.team_product_catalogs as record
         set current_video_link = swapped.shared_link
       where record.material_id = p_item;
      perform private.queue_restitch_jobs(owning_team);
    end if;
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (owning_team, p_item, 'upserted');
  perform private.record_team_system_audit(
    owning_team, 'catalog.updated', jsonb_build_object('material_id', p_item)
  );
  return true;
end;
$$;

revoke all on function public.service_complete_catalog_update(uuid, text, integer, uuid, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_complete_catalog_update(uuid, text, integer, uuid, integer, jsonb)
  to service_role;
