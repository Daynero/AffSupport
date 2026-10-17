-- Wake the existing team Realtime owner when a hosted bulk item reaches a new
-- authoritative state. A normal catalog invalidation waits one second; this
-- content-free marker takes the urgent path in useTeamRealtime.
create function private.notify_bulk_trash_operation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'trash' and exists (
    select 1 from private.team_bulk_trash_items item
    where item.team_id = new.team_id
      and item.material_id = new.source_material_id
      and item.idempotency_key::text = new.idempotency_key
  ) then
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (new.team_id, null, 'bulk_trash_changed');
  end if;
  return new;
end $$;

create trigger notify_bulk_trash_operation
after insert or update of state on public.team_operations
for each row execute function private.notify_bulk_trash_operation();

create function private.notify_bulk_trash_lifecycle() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.lifecycle is distinct from old.lifecycle and exists (
    select 1 from private.team_bulk_trash_items item
    where item.team_id = new.team_id and item.material_id = new.id
  ) then
    insert into public.team_catalog_events(team_id, material_id, event_kind)
      values (new.team_id, null, 'bulk_trash_changed');
  end if;
  return new;
end $$;

create trigger notify_bulk_trash_lifecycle
after update of lifecycle on public.team_materials
for each row execute function private.notify_bulk_trash_lifecycle();
