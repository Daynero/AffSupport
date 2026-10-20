begin;
create table private.team_bulk_trash_groups (
 id uuid primary key, team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 source_ids uuid[] not null, created_at timestamptz not null default now()
);
create table private.team_bulk_trash_items (
 group_id uuid not null references private.team_bulk_trash_groups(id) on delete cascade,
 material_id uuid not null references public.team_materials(id) on delete cascade,
 idempotency_key text not null, error_code text, requested_at timestamptz,
 primary key(group_id,material_id), unique(idempotency_key)
);
alter table private.team_bulk_trash_groups enable row level security;
alter table private.team_bulk_trash_groups force row level security;
alter table private.team_bulk_trash_items enable row level security;
alter table private.team_bulk_trash_items force row level security;
revoke all on private.team_bulk_trash_groups, private.team_bulk_trash_items from public,anon,authenticated;
alter table public.team_catalog_events drop constraint team_catalog_events_kind_check;
alter table public.team_catalog_events add constraint team_catalog_events_kind_check check(event_kind in (
 'upserted','tombstoned','restored','sync_state','folder_indexed','thumbnail_ready','storage_state','bulk_trash_changed'
));
create function private.bulk_trash_snapshot(p_group uuid) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',g.id,'teamId',g.team_id,'actorId',g.actor_id,'items',coalesce((
 select jsonb_agg(jsonb_build_object('materialId',i.material_id,'idempotencyKey',i.idempotency_key,
 'state',case when o.state='succeeded' then 'confirmed' when o.state in ('failed','canceled') then 'failed'
 when o.state in ('pending','running') then 'running' when i.requested_at is not null then 'unknown' else 'queued' end,
 'errorCode',case when o.state='succeeded' then null else coalesce(o.error_code,i.error_code) end) order by i.material_id)
 from private.team_bulk_trash_items i left join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id
 and o.kind='trash' and o.idempotency_key=i.idempotency_key where i.group_id=g.id),'[]'::jsonb))
 from private.team_bulk_trash_groups g where g.id=p_group
$$;
create function public.start_team_bulk_trash(p_team uuid,p_group uuid,p_materials uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); existing private.team_bulk_trash_groups%rowtype;
begin
 if actor is null or not private.can(p_team,'delete',actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_group is null or p_materials is null or cardinality(p_materials) not between 1 and 500 or array_position(p_materials,null) is not null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_group::text,0));
 select * into existing from private.team_bulk_trash_groups where id=p_group;
 if found then
  if existing.team_id<>p_team or existing.actor_id<>actor or existing.source_ids<>p_materials then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  return private.bulk_trash_snapshot(p_group);
 end if;
 if (select count(distinct id) from public.team_materials where team_id=p_team and id=any(p_materials) and lifecycle='active')<>(select count(distinct id) from unnest(p_materials) t(id)) then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 insert into private.team_bulk_trash_groups(id,team_id,actor_id,source_ids) values(p_group,p_team,actor,p_materials);
 -- The server, too, removes descendants of selected folders (including nested selections).
 insert into private.team_bulk_trash_items(group_id,material_id,idempotency_key)
 with recursive descendants as (
  select m.id,m.drive_file_id from public.team_materials m where m.team_id=p_team and m.id=any(p_materials) and m.kind='folder'
  union select m.id,m.drive_file_id from public.team_materials m join descendants d on m.parent_folder_id=d.drive_file_id where m.team_id=p_team
 ), children as (
  select m.id from public.team_materials m join descendants d on m.parent_folder_id=d.drive_file_id where m.team_id=p_team
 )
 select p_group,m.id,p_group::text||':'||m.id::text from public.team_materials m
 where m.team_id=p_team and m.id=any(p_materials) and not exists(select 1 from children c where c.id=m.id);
 insert into public.team_catalog_events(team_id,event_kind) values(p_team,'bulk_trash_changed');
 return private.bulk_trash_snapshot(p_group);
end $$;
create function public.list_team_bulk_trash(p_team uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'view',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(private.bulk_trash_snapshot(id) order by created_at desc) from
 (select id,created_at from private.team_bulk_trash_groups where team_id=p_team order by created_at desc limit 50) g),'[]'::jsonb);
end $$;
-- Client request errors are never allowed to assert completion; only team_operations proves it.
create function public.mark_team_bulk_trash_request(p_team uuid,p_group uuid,p_material uuid,p_error text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.can(p_team,'delete',auth.uid()) or not exists(select 1 from private.team_bulk_trash_groups where id=p_group and team_id=p_team and actor_id=auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_error is not null and p_error !~ '^[A-Z][A-Z0-9_]{0,63}$' then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 update private.team_bulk_trash_items set requested_at=now(),error_code=p_error where group_id=p_group and material_id=p_material;
 insert into public.team_catalog_events(team_id,event_kind) values(p_team,'bulk_trash_changed');
end $$;
create function private.signal_bulk_trash_operation() returns trigger language plpgsql set search_path='' as $$
begin
 if new.kind='trash' and exists(select 1 from private.team_bulk_trash_items i join private.team_bulk_trash_groups g on g.id=i.group_id where i.idempotency_key=new.idempotency_key and g.team_id=new.team_id and g.actor_id=new.actor_id) then
 insert into public.team_catalog_events(team_id,event_kind) values(new.team_id,'bulk_trash_changed'); end if;
 return new;
end $$;
create trigger bulk_trash_operation_changed after insert or update of state on public.team_operations for each row execute function private.signal_bulk_trash_operation();
revoke all on function private.bulk_trash_snapshot(uuid),private.signal_bulk_trash_operation() from public,anon,authenticated;
revoke all on function public.start_team_bulk_trash(uuid,uuid,uuid[]),public.list_team_bulk_trash(uuid),public.mark_team_bulk_trash_request(uuid,uuid,uuid,text) from public,anon;
grant execute on function public.start_team_bulk_trash(uuid,uuid,uuid[]),public.list_team_bulk_trash(uuid),public.mark_team_bulk_trash_request(uuid,uuid,uuid,text) to authenticated;
commit;
