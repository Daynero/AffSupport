-- A browser-visible result must carry the generation that produced its
-- revision. The analytics consumer correlates both IDs before it treats a
-- committed result as delivered to a person.
create or replace function private.launch_revision_json(p_team uuid,p_revision uuid)
returns jsonb language sql stable security definer set search_path='' as $$
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
   'restitchMaterialId',x.restitch_material_id)
   from public.team_launch_revision_catalogs x where x.revision_id=r.id),
  'createdAt',r.created_at)
 from public.team_launch_revisions r
 join public.team_launch_revisions b on b.id=coalesce(r.baseline_revision_id,r.id)
 where r.team_id=p_team and r.id=p_revision;
$$;
