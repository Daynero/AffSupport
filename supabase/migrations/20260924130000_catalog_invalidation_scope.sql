-- A catalog event is an invalidation, not a replay cursor. A move affects two
-- folder windows even though the material has only one current parent.
alter table public.team_catalog_events add column parent_folder_id text;
grant select (parent_folder_id) on table public.team_catalog_events to authenticated;

-- The publication has an explicit column list; adding a table column alone
-- would leave parent_folder_id absent from the delivered event.
alter publication supabase_realtime drop table public.team_catalog_events;
alter publication supabase_realtime add table public.team_catalog_events (
  id, team_id, material_id, parent_folder_id, event_kind, occurred_at
);

create function private.emit_catalog_move_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.parent_folder_id is distinct from new.parent_folder_id then
    insert into public.team_catalog_events
      (team_id, material_id, parent_folder_id, event_kind)
    values
      (new.team_id, new.id, old.parent_folder_id, 'upserted'),
      (new.team_id, new.id, new.parent_folder_id, 'upserted');
  end if;
  return new;
end;
$$;
revoke all on function private.emit_catalog_move_scope() from public, anon, authenticated, service_role;
create trigger catalog_move_scope
after update of parent_folder_id on public.team_materials
for each row when (old.parent_folder_id is distinct from new.parent_folder_id)
execute function private.emit_catalog_move_scope();

comment on function private.emit_catalog_move_scope() is
  'Emit both affected parent windows atomically with any Drive-operation or catalog-scan move commit.';
