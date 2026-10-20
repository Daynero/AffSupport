begin;
alter table private.team_bulk_trash_items add column attempt integer not null default 1;
create function public.prepare_team_bulk_trash_item(p_team uuid,p_group uuid,p_material uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g private.team_bulk_trash_groups%rowtype; i private.team_bulk_trash_items%rowtype; o public.team_operations%rowtype;
begin
 if auth.uid() is null or not private.can(p_team,'delete',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into g from private.team_bulk_trash_groups where id=p_group and team_id=p_team and actor_id=auth.uid();
 if g.id is null then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into i from private.team_bulk_trash_items where group_id=p_group and material_id=p_material for update;
 if i.group_id is null then raise exception 'NOT_FOUND' using errcode='P0002'; end if;
 select * into o from public.team_operations where team_id=p_team and actor_id=g.actor_id and kind='trash' and idempotency_key=i.idempotency_key for update;
 -- Only an authoritative terminal failure permits a new attempt. Unknown replies reuse the exact key.
 if o.state in ('failed','canceled') and i.attempt<10 then
 update private.team_bulk_trash_items set attempt=attempt+1,idempotency_key=p_group::text||':'||p_material::text||':'||(attempt+1)::text,error_code=null,requested_at=null where group_id=p_group and material_id=p_material;
 end if;
 return private.bulk_trash_snapshot(p_group);
end $$;
revoke all on function public.prepare_team_bulk_trash_item(uuid,uuid,uuid) from public,anon;
grant execute on function public.prepare_team_bulk_trash_item(uuid,uuid,uuid) to authenticated;
commit;
