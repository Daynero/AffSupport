-- 1.4.3, beta QA: two week-old groups came back as panels that read
-- «Підтверджено 0 з 1 · Очікуємо підтвердження · Файл 1». Their only item was
-- trashed long ago; it carried a historical receipt saying the catalog changed
-- since, and 20261207310000 counted any item with such a receipt as unfinished,
-- so the group was never treated as finished work and never hidden.
--
-- Finished now means every item reached a terminal hosted state (confirmed or
-- failed), receipt or not: what happened to the catalog afterwards is not work
-- this group still owes. Finished groups older than a day, or someone else's,
-- arrive hidden as before.
--
-- The list also carries each material's name for its viewer. The group panel
-- could only name rows the current screen happened to list, so a group from
-- another folder, or read after a reload, said «Файл 1» for a known file. The
-- name is added to this list only; the snapshot used elsewhere stays name-free.
begin;

create or replace function public.list_team_bulk_trash(p_team uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null or not private.can(p_team,'view',viewer) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(
   jsonb_set(s.snapshot,'{items}',coalesce((
    select jsonb_agg(e || case when m.name is null then '{}'::jsonb else jsonb_build_object('name',m.name) end order by x.ord)
    from jsonb_array_elements(s.snapshot->'items') with ordinality x(e,ord)
    left join public.team_materials m on m.id=(e->>'materialId')::uuid and m.team_id=p_team),'[]'::jsonb))
   || jsonb_build_object('dismissed',
   exists(select 1 from private.bulk_trash_dismissals d where d.group_id=s.id and d.actor_id=viewer)
   or ((s.actor_id<>viewer or s.created_at<now()-interval '1 day')
    and jsonb_array_length(s.snapshot->'items')>0
    and not exists(select 1 from jsonb_array_elements(s.snapshot->'items') e where e->>'state' not in ('confirmed','failed')))
  ) order by s.created_at desc) from
  (select g.id,g.actor_id,g.created_at,private.bulk_trash_snapshot(g.id) snapshot from
   (select id,actor_id,created_at from private.team_bulk_trash_groups where team_id=p_team order by created_at desc limit 50) g) s),'[]'::jsonb);
end $$;

commit;
