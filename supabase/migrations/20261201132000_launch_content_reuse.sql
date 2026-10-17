-- Binary identity is the same rule as shared launchMaterialIdentity; full source expectation still rechecks all fields at acceptance.
create function private.launch_material_identity(p_sources jsonb) returns jsonb language sql immutable set search_path='' as $$
 select case when p_sources->>'materialChecksum' ~* '^[0-9a-f]{32}$' then jsonb_build_array(p_sources->>'materialDriveFileId','md5:'||lower(p_sources->>'materialChecksum')) when p_sources->>'materialVersion' is not null then jsonb_build_array(p_sources->>'materialDriveFileId','version:'||(p_sources->>'materialVersion')) else null end;
$$;
revoke all on function private.launch_material_identity(jsonb) from public,anon,authenticated,service_role;
-- Names-only regeneration copies a validated historical catalog reference, never overwrites it.
create or replace function public.service_reuse_launch_catalog(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text) returns boolean language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;r public.team_launch_revisions%rowtype;b public.team_launch_revisions%rowtype;c public.team_launch_revision_catalogs%rowtype;begin
 perform public.service_touch_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,'catalog_registering');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 select * into b from public.team_launch_revisions where id=r.base_revision_id and team_id=p_team;
 select * into c from public.team_launch_revision_catalogs where revision_id=b.id and team_id=p_team;
 if c.revision_id is null or r.config->>'method'<>'catalog' or b.config->>'method'<>'catalog' or r.generated_url is distinct from b.generated_url or r.config->>'materialId' is distinct from b.config->>'materialId' or r.config->'catalog'->>'productCount' is distinct from b.config->'catalog'->>'productCount' or r.config->'catalog'->>'restitchEnabled' is distinct from b.config->'catalog'->>'restitchEnabled' or (r.config->'catalog'->>'restitchEnabled'='true' and (r.config->'catalog'->>'finalDurationMode' is distinct from b.config->'catalog'->>'finalDurationMode' or r.config->'catalog'->'customFinalDurationSeconds' is distinct from b.config->'catalog'->'customFinalDurationSeconds')) or private.launch_material_identity(r.sources) is null or private.launch_material_identity(r.sources) is distinct from private.launch_material_identity(b.sources) or r.sources->>'catalogSettingsVersion' is null or r.sources->>'catalogSettingsVersion' is distinct from b.sources->>'catalogSettingsVersion' or r.sources->>'restitchSettingsVersion' is distinct from b.sources->>'restitchSettingsVersion' then return false;end if;
 if not exists(select 1 from public.team_product_catalogs p join public.team_materials m on m.id=p.material_id and m.team_id=p.team_id where p.team_id=p_team and p.material_id=c.material_id and p.source_link=r.generated_url and p.product_count=(r.config->'catalog'->>'productCount')::integer and p.sheet_url=c.sheet_url and m.lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if c.restitch_material_id is not null and not exists(select 1 from public.team_materials where team_id=p_team and id=c.restitch_material_id and lifecycle='active') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into public.team_launch_revision_catalogs select team_id,r.id,catalog_id,material_id,variant,name_snapshot,sheet_url,restitch_operation_id,restitch_material_id,settings_snapshot from public.team_launch_revision_catalogs where revision_id=c.revision_id on conflict(revision_id) do nothing;
 update public.team_launch_generation_steps set state='succeeded',result_material_id=c.material_id,reserved_variant=c.variant where generation_id=g.id and stage='catalog_registering';
 return true;
end $$;
revoke all on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_reuse_launch_catalog(uuid,uuid,uuid,text,text) to service_role;
