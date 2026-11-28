-- 057 T108/T109: «Очистити кошик» frees a tool's output at once in an R2 space (US10, FR-048).
--
-- A tool run's output is linked to its source by `processed_from` (team_material_links), and both
-- FKs of the link are ON DELETE RESTRICT. service_empty_space_trash met the restriction as a
-- foreign_key_violation and left the material in the trash: an R2 trash with a tool's output (or a
-- source that had one) in it could never be emptied, and its bytes were never freed.
--
-- The link is provenance, not a reference that keeps anything alive: in an R2 space, emptying a
-- material from the trash now takes its `processed_from` links with it, in the same
-- subtransaction as its row. The other side is untouched — a source keeps working when its
-- output leaves; an output whose source leaves stays an ordinary file of the space and is counted
-- once, under `materials` (private.space_material_ref_sync) — and the deleted material's object is
-- queued for purge by the existing triggers once nothing else refers to it. A link of any other
-- kind (`version_of`), a task, a catalog, a child that stays: the material still stays in the
-- trash, as before. Only the R2 body is replaced (it goes through private.require_space_actor,
-- which refuses a Drive space); Drive's trash never reaches it.

create or replace function public.service_empty_space_trash(p_actor uuid, p_team uuid, p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid;
  v_other uuid;
  v_others uuid[];
  v_deleted integer := 0;
  v_queued integer;
  v_revision bigint;
begin
  if p_ids is not null and cardinality(p_ids) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform 1 from public.teams where id = p_team for no key update;
  perform private.require_space_actor(p_team, p_actor, 'delete');
  perform pg_catalog.set_config('soty.space_purge_reason', 'trash_emptied', true);
  select count(*) into v_queued from public.space_object_purges where team_id = p_team and state = 'due';

  -- The chosen trashed materials and everything their trashing hid; deepest first.
  for v_id in
    with recursive chosen as (
      select material.id, 0 as depth from public.team_materials material
      where material.team_id = p_team and material.connection_id is null and material.lifecycle = 'trashed'
        and (p_ids is null or material.id = any(p_ids))
      union
      select child.id, chosen.depth + 1 from public.team_materials child
      join chosen on child.folder_trash_root = chosen.id
      where child.team_id = p_team and child.connection_id is null and child.lifecycle = 'trashed' and chosen.depth < 1000
    )
    select chosen.id from chosen group by chosen.id order by max(chosen.depth) desc, chosen.id
  loop
    begin
      -- T109: its provenance leaves with it, whichever side of the run it was on.
      with gone as (
        delete from public.team_material_links link
         where link.team_id = p_team and link.relation = 'processed_from'
           and (link.derivative_material_id = v_id or link.source_material_id = v_id)
        returning case when link.derivative_material_id = v_id
          then link.source_material_id else link.derivative_material_id end as other)
      select coalesce(array_agg(distinct other), '{}') into v_others from gone;
      delete from public.team_materials where id = v_id and team_id = p_team and lifecycle = 'trashed';
      if found then
        v_deleted := v_deleted + 1;
        -- The other side is counted again without the link (an output becomes a file of the space).
        foreach v_other in array v_others loop
          perform private.space_material_ref_sync(v_other);
        end loop;
      end if;
    exception when foreign_key_violation then
      -- Still referenced (a task, a catalog, another kind of link, a child that stays): it stays
      -- in the trash, and so do its links (the subtransaction rolls them back).
      null;
    end;
  end loop;

  v_queued := (select count(*) from public.space_object_purges where team_id = p_team and state = 'due') - v_queued;
  if v_deleted > 0 then
    v_revision := private.space_content_changed(p_team, null, true);
  else
    select content_revision into v_revision from public.teams where id = p_team;
  end if;
  perform pg_catalog.set_config('soty.space_purge_reason', '', true);
  return jsonb_build_object('deleted', v_deleted, 'purgesQueued', greatest(v_queued, 0), 'contentRevision', v_revision::text);
end;
$function$;

revoke all on function public.service_empty_space_trash(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.service_empty_space_trash(uuid, uuid, uuid[]) to service_role;
