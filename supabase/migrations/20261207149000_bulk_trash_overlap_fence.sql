-- Serialize acceptance; retain original unknown receipts, including frozen lifecycle members.
begin;
create index team_bulk_trash_groups_team_idx on private.team_bulk_trash_groups(team_id);
create or replace function public.start_team_bulk_trash(p_team uuid,p_group uuid,p_materials uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); existing private.team_bulk_trash_groups%rowtype;
begin
 if actor is null or not private.can(p_team,'delete',actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_group is null or p_materials is null or cardinality(p_materials) not between 1 and 500 or array_position(p_materials,null) is not null then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 -- Serialize new acceptances across actors and group UUIDs in this team.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_team::text,47));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_group::text,0));
 select * into existing from private.team_bulk_trash_groups where id=p_group;
 if found then
  if existing.team_id<>p_team or existing.actor_id<>actor or existing.source_ids<>p_materials then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
  return private.bulk_trash_snapshot(p_group);
 end if;
 -- A different UUID must not bypass accepted, running or uncertain work.
 -- Failed/canceled historical DTOs do not prove provider quiescence. Recovery
 -- continues through the original group and its existing preflight provenance.
 if exists (
  with recursive unresolved as (
   select i.material_id,o.id as operation_id
   from private.team_bulk_trash_groups g
   join private.team_bulk_trash_items i on i.group_id=g.id
   left join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id
    and o.kind='trash' and o.idempotency_key=i.idempotency_key
   where g.team_id=p_team and (
    o.state is distinct from 'succeeded' or exists (
     select 1 from private.team_material_group_intents lifecycle
     where lifecycle.operation_id=o.id and lifecycle.state<>'succeeded'
    )
   )
  ), frozen_members as (
   select member->>'material_id' as material_id, member->>'drive_file_id' as drive_file_id
   from unresolved u join private.team_material_group_intents intent on intent.operation_id=u.operation_id
   cross join lateral jsonb_array_elements(intent.member_snapshot) member
   where intent.team_id=p_team
  ), protected_members as (
   select m.id,m.drive_file_id,m.kind from public.team_materials m
   where m.team_id=p_team and (
    exists(select 1 from unresolved u where u.material_id=m.id)
    or exists(select 1 from frozen_members f where f.material_id=m.id::text)
   )
   union
   select m.id,m.drive_file_id,m.kind from public.team_materials m
   join protected_members parent on parent.kind='folder' and m.parent_folder_id=parent.drive_file_id
   where m.team_id=p_team
  ), requested_members as (
   select m.id,m.drive_file_id,m.kind from public.team_materials m
   where m.team_id=p_team and m.id=any(p_materials)
   union
   select m.id,m.drive_file_id,m.kind from public.team_materials m
   join requested_members parent on parent.kind='folder' and m.parent_folder_id=parent.drive_file_id
   where m.team_id=p_team
  ), protected_files as (
   select drive_file_id from protected_members
   union select drive_file_id from frozen_members where drive_file_id is not null
  )
  select 1 from requested_members wanted join protected_files held using(drive_file_id)
 ) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000'; end if;
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
-- CREATE OR REPLACE preserves the existing restricted grants and actor wrapper.
notify pgrst,'reload schema';
commit;
