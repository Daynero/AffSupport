-- 1.4.3: "Перевірити чинні посилання" always failed for a restitched catalog.
-- The baseline check accepted only empty cells or the original video link, and a
-- restitched catalog's cells hold links to the variant outputs of its video set
-- (Drive, or the R2 copy of a variant since 050).
--
-- authorize now also hands the edge function the catalog's candidate video sets:
-- every registered variant with an active output (its Drive file and its ready R2
-- URLs), and, where the catalog recorded which product got which recipe row, the
-- expected output per product. The edge function proves which set the cells hold;
-- finish adopts that set as the active delivery, re-checking it is a candidate.
-- Source-target catalogs keep the original-link rule unchanged.
begin;

-- Expected output per product of one recipe, or null when the catalog never
-- recorded its product order (the edge function then accepts any variant).
create function private.catalog_baseline_video_rows(p_team uuid,p_catalog uuid,p_set uuid,p_recipe bigint) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.team_product_catalogs%rowtype;row_ids jsonb;public_ids jsonb;result jsonb;
begin
 select * into c from public.team_product_catalogs where material_id=p_catalog and team_id=p_team;
 if c.material_id is null then return null;end if;
 if jsonb_typeof(c.settings_snapshot->'_catalogRecipeRowIds')='array' and jsonb_typeof(c.settings_snapshot->'_catalogPublicIds')='array' then
  row_ids:=c.settings_snapshot->'_catalogRecipeRowIds';public_ids:=c.settings_snapshot->'_catalogPublicIds';
  if jsonb_array_length(row_ids)<>c.product_count or jsonb_array_length(public_ids)<>c.product_count
   or (select count(*) from jsonb_array_elements_text(row_ids) r(id) join private.catalog_video_assignments a on a.recipe_row_id::text=r.id and a.video_set_id=p_set and a.team_id=p_team and a.recipe_revision=p_recipe)<>c.product_count then
   row_ids:=null;public_ids:=null;
  end if;
 end if;
 if row_ids is null then
  select i.checkpoint->'initialVideoPlan'->'recipeRowIds',(select jsonb_agg(cell.value->0->>'v' order by cell.ordinality) from jsonb_array_elements(case when jsonb_typeof(i.checkpoint->'sheetRows')='array' then i.checkpoint->'sheetRows' else '[]'::jsonb end) with ordinality cell(value,ordinality) where cell.ordinality>2)
  into row_ids,public_ids from private.catalog_generation_intents i
  where i.team_id=p_team and i.checkpoint->>'materialId'=p_catalog::text and i.checkpoint->'initialVideoPlan'->>'setId'=p_set::text order by i.created_at limit 1;
 end if;
 if jsonb_typeof(row_ids) is distinct from 'array' or jsonb_typeof(public_ids) is distinct from 'array' then return null;end if;
 if jsonb_array_length(row_ids)<>c.product_count or jsonb_array_length(public_ids)<>c.product_count then return null;end if;
 select jsonb_agg(jsonb_build_object('productId',p.id,'materialId',v.output_material_id) order by p.ordinality) into result
 from jsonb_array_elements_text(row_ids) with ordinality r(id,ordinality)
 join jsonb_array_elements_text(public_ids) with ordinality p(id,ordinality) on p.ordinality=r.ordinality
 join private.catalog_video_assignments a on a.recipe_row_id::text=r.id and a.video_set_id=p_set and a.team_id=p_team and a.recipe_revision=p_recipe
 join private.catalog_video_variants v on v.video_set_id=a.video_set_id and v.video_variant_index=a.video_variant_index and v.state='registered' and v.output_material_id is not null
 where p.id is not null and length(p.id) between 1 and 100;
 if result is null or jsonb_array_length(result)<>c.product_count then return null;end if;
 return result;
end $$;
revoke all on function private.catalog_baseline_video_rows(uuid,uuid,uuid,bigint) from public,anon,authenticated,service_role;

-- The ready video sets whose variants this catalog's cells may hold: the policy
-- target first, then the active delivery, then the catalog's own sets, newest
-- first. At most four, each with its registered variants that are still active.
create function private.catalog_baseline_video_sets(p_team uuid,p_catalog uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with candidates as (
  select t.video_set_id,t.recipe_revision,1 rank from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id
  where p.catalog_material_id=p_catalog and p.team_id=p_team and t.kind='video_set'
  union all
  select t.video_set_id,t.recipe_revision,2 from private.catalog_video_deliveries d join private.catalog_publication_targets t on t.id=d.target_id and t.team_id=d.team_id
  where d.catalog_material_id=p_catalog and d.team_id=p_team and t.kind='video_set'
  union all
  select s.id,coalesce((select max(a.recipe_revision) from private.catalog_video_assignments a where a.video_set_id=s.id and a.team_id=s.team_id),s.recipe_revision),3
  from private.catalog_video_sets s where s.team_id=p_team and (
   s.catalog_material_id=p_catalog
   or s.catalog_intent_id in(select i.id from private.catalog_generation_intents i where i.team_id=p_team and i.checkpoint->>'materialId'=p_catalog::text)
   or s.id in(select r.set_id from private.catalog_updater_variant_requests r where r.catalog_material_id=p_catalog and r.team_id=p_team)
   or s.id in(select r.set_id from private.catalog_variant_round_snapshots r where r.catalog_material_id=p_catalog and r.team_id=p_team))
 ), ranked as (
  select distinct on(c.video_set_id,c.recipe_revision) c.video_set_id,c.recipe_revision,c.rank,s.created_at
  from candidates c join private.catalog_video_sets s on s.id=c.video_set_id and s.team_id=p_team and s.state='ready'
  join private.catalog_video_set_recipes r on r.video_set_id=c.video_set_id and r.team_id=p_team and r.recipe_revision=c.recipe_revision
  order by c.video_set_id,c.recipe_revision,c.rank
 ), chosen as (
  select x.*,(select jsonb_agg(jsonb_build_object('materialId',m.id,'fileId',m.drive_file_id,'resourceKey',m.resource_key,'credentialId',conn.credential_id,'rootFolderId',conn.root_folder_id,
    'r2Urls',coalesce((select jsonb_agg(cfg.public_origin||'/'||copy.object_key order by copy.created_at) from private.catalog_video_r2_copies copy cross join private.catalog_video_r2_config cfg
     where copy.team_id=p_team and copy.source_material_id=m.id and copy.state='ready' and cfg.public_origin is not null),'[]'::jsonb)) order by v.video_variant_index)
   from private.catalog_video_variants v join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team and m.lifecycle='active'
   join public.team_drive_connections conn on conn.id=m.connection_id and conn.team_id=p_team and conn.state='connected'
   where v.video_set_id=x.video_set_id and v.state='registered') variants
  from ranked x order by x.rank,x.created_at desc,x.video_set_id,x.recipe_revision desc limit 4
 )
 select coalesce(jsonb_agg(jsonb_build_object('videoSetId',c.video_set_id,'recipeRevision',c.recipe_revision,'variants',c.variants,'rows',private.catalog_baseline_video_rows(p_team,p_catalog,c.video_set_id,c.recipe_revision)) order by c.rank,c.created_at desc,c.video_set_id,c.recipe_revision desc),'[]'::jsonb)
 from chosen c where c.variants is not null
$$;
revoke all on function private.catalog_baseline_video_sets(uuid,uuid) from public,anon,authenticated,service_role;

do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_authorize_catalog_baseline_check(uuid,uuid,uuid,uuid)'::regprocedure) into d;
 if strpos(d,$find$'sourceCredentialId',source_conn.credential_id) into ctx$find$)=0 then raise exception 'BASELINE_AUTHORIZE_PATCH_MISSING';end if;
 d:=replace(d,$find$'sourceCredentialId',source_conn.credential_id) into ctx$find$,$replace$'sourceCredentialId',source_conn.credential_id,'videoSets',private.catalog_baseline_video_sets(b.team_id,b.catalog_material_id)) into ctx$replace$);
 execute d;

 select pg_get_functiondef('public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure) into d;
 if strpos(d,$find$p_video_cells_digest text)$find$)=0
  or strpos(d,$find$ if p_outcome not in('blank','source') or p_outcome is null or$find$)=0
  or strpos(d,$find$  insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',b.source_material_id,b.source_version) returning id into target_id;$find$)=0 then raise exception 'BASELINE_FINISH_PATCH_MISSING';end if;
 d:=replace(d,$find$p_video_cells_digest text)$find$,$replace$p_video_cells_digest text, p_video_set uuid DEFAULT NULL::uuid, p_recipe_revision bigint DEFAULT NULL::bigint)$replace$);
 d:=replace(d,$find$ if p_outcome not in('blank','source') or p_outcome is null or$find$,$replace$ if p_outcome not in('blank','source','video_set') or p_outcome is null or (p_outcome='video_set') is distinct from (p_video_set is not null) or (p_video_set is null) is distinct from (p_recipe_revision is null) or$replace$);
 d:=replace(d,$find$  insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',b.source_material_id,b.source_version) returning id into target_id;$find$,$replace$  if p_outcome='video_set' then
   if not exists(select 1 from jsonb_array_elements(private.catalog_baseline_video_sets(p_team,b.catalog_material_id)) candidate(value) where candidate.value->>'videoSetId'=p_video_set::text and (candidate.value->>'recipeRevision')::bigint=p_recipe_revision) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
   insert into private.catalog_publication_targets(team_id,kind,video_set_id,recipe_revision) values(p_team,'video_set',p_video_set,p_recipe_revision) returning id into target_id;
  else
   insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',b.source_material_id,b.source_version) returning id into target_id;
  end if;$replace$);
 drop function public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text);
 execute d;
end $patch$;
revoke all on function public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text,uuid,bigint) to service_role;

commit;
