-- Historical Launch outputs remain immutable through Soty's ordinary mutation routes.
create index team_launch_catalog_material_refs on public.team_launch_revision_catalogs(team_id,material_id);
create index team_launch_restitch_material_refs on public.team_launch_revision_catalogs(team_id,restitch_material_id) where restitch_material_id is not null;
create function private.launch_output_is_referenced(p_team uuid,p_material uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_launch_revision_catalogs where team_id=p_team and (material_id=p_material or restitch_material_id=p_material));
$$;
create function private.guard_launch_output_operation() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.kind in('rename','move','content_edit','new_version','trash') and new.source_material_id is not null then
  perform 1 from public.team_materials where team_id=new.team_id and id=new.source_material_id for update;
  if private.launch_output_is_referenced(new.team_id,new.source_material_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 end if;
 return new;
end $$;
create trigger team_operations_launch_output_guard before insert on public.team_operations for each row execute function private.guard_launch_output_operation();
create function private.guard_launch_catalog_updater() returns trigger language plpgsql security definer set search_path='' as $$ begin
 perform 1 from public.team_materials where id=new.catalog_material_id for update;
 if exists(select 1 from public.team_launch_revision_catalogs where material_id=new.catalog_material_id) and (new.update_interval is not null or new.round_due_at is not null or new.lease_expires_at>clock_timestamp()) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 -- The ordinary generator may inherit workspace scheduling. A Launch-owned candidate is
 -- frozen before its first link, so it must not enter the updater's mutable queue.
 if exists(select 1 from private.catalog_generation_intents i join public.team_launch_generations g on i.request_key='launch:'||g.id::text||':catalog' and i.team_id=g.team_id and i.actor_id=g.actor_id where i.checkpoint->>'materialId'=new.catalog_material_id::text and g.state not in('succeeded','canceled')) then
  new.update_interval:=null;new.next_run_at:=null;new.round_due_at:=null;new.lease_expires_at:=null;
 end if;
 return new;
end $$;
create trigger team_catalog_updater_launch_guard before insert or update on public.team_catalog_updater_items for each row execute function private.guard_launch_catalog_updater();
create function private.guard_launch_catalog_reference() returns trigger language plpgsql security definer set search_path='' as $$ begin
 perform 1 from public.team_materials where team_id=new.team_id and id in(new.material_id,new.restitch_material_id) order by id for update;
 if exists(select 1 from public.team_operations where team_id=new.team_id and source_material_id in(new.material_id,new.restitch_material_id) and kind in('rename','move','content_edit','new_version','trash') and state in('pending','running')) or exists(select 1 from public.team_catalog_updater_items where catalog_material_id=new.material_id and (update_interval is not null or round_due_at is not null or lease_expires_at>clock_timestamp())) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 return new;
end $$;
create trigger team_launch_catalog_reference_guard before insert on public.team_launch_revision_catalogs for each row execute function private.guard_launch_catalog_reference();
revoke all on function private.launch_output_is_referenced(uuid,uuid),private.guard_launch_output_operation(),private.guard_launch_catalog_updater(),private.guard_launch_catalog_reference() from public,anon,authenticated,service_role;
