-- Launch history already owns a name snapshot. A member may trash the actual
-- catalog (or its containing folder); other mutations still protect the output.
create or replace function private.guard_launch_output_operation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare affected uuid[];
begin
  if new.kind not in ('rename','move','content_edit','new_version','trash')
     or new.source_material_id is null then return new; end if;
  if new.kind = 'trash' and exists (
    select 1 from public.team_materials
    where id = new.source_material_id and team_id = new.team_id and kind = 'folder'
  ) then
    with recursive descendants(id,drive_file_id,connection_id) as (
      select id,drive_file_id,connection_id from public.team_materials
      where id = new.source_material_id and team_id = new.team_id
      union
      select m.id,m.drive_file_id,m.connection_id from public.team_materials m
      join descendants d on m.parent_folder_id = d.drive_file_id
        and m.connection_id = d.connection_id where m.team_id = new.team_id
    ) select array_agg(id order by id) into affected from descendants;
  else
    affected := array[new.source_material_id];
  end if;
  perform 1 from public.team_materials
  where team_id = new.team_id and id = any(affected) order by id for update;
  if new.kind <> 'trash' and exists (
    select 1 from unnest(affected) id
    where private.launch_output_is_referenced(new.team_id,id)
  ) then raise exception 'WRONG_STATE' using errcode = '55000'; end if;
  return new;
end $$;

-- Keep the historical name while telling the client whether the file exists.
create or replace function private.launch_revision_json(p_team uuid,p_revision uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'id',r.id,'revisionNo',r.revision_no,'kind',r.result_kind,
  'generationId',(select g.id from public.team_launch_generations g
                  where g.team_id=p_team and g.revision_id=r.id and g.state='succeeded'
                  order by g.created_at desc,g.id desc limit 1),
  'config',r.config,'sources',r.sources,'baselineRevisionId',r.baseline_revision_id,
  'baseline',jsonb_build_object('advertisingUrl',b.generated_url,'subValues',b.sub_values,
   'campaigns',coalesce((select jsonb_agg(jsonb_build_object('ordinal',c.ordinal,
    'budget',c.budget_usd,'adStart',c.ad_start,'adEnd',c.ad_end,'name',c.name)
    order by c.ordinal) from public.team_launch_campaigns c where c.revision_id=b.id),'[]')),
  'overrides',r.result_overrides,
  'catalog',(select jsonb_build_object('id',x.catalog_id,'materialId',x.material_id,
   'variant',x.variant,'name',x.name_snapshot,'url',x.sheet_url,
   'available',coalesce(m.lifecycle = 'active',false),
   'restitchMaterialId',x.restitch_material_id)
   from public.team_launch_revision_catalogs x
   left join public.team_materials m on m.id=x.material_id and m.team_id=x.team_id
   where x.revision_id=r.id),
  'createdAt',r.created_at)
 from public.team_launch_revisions r
 join public.team_launch_revisions b on b.id=coalesce(r.baseline_revision_id,r.id)
 where r.team_id=p_team and r.id=p_revision;
$$;
