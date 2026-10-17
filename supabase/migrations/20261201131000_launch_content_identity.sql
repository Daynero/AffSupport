-- Binary content identity survives permission-only changes; pool/default snapshots stay actor-scoped.
-- Content/settings signatures do not depend on the pools' rotation cursor.
create or replace function private.launch_catalog_settings_version(p_team uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(jsonb_build_object(
 'settings',(select to_jsonb(s)-'updated_by'-'created_at' from public.team_product_catalog_settings s where s.team_id=p_team),
 'texts',(select coalesce(jsonb_agg(jsonb_build_array(t.id,t.title,t.description,t.updated_at) order by t.position,t.id),'[]') from public.team_product_catalog_texts t where t.team_id=p_team),
 'images',(select coalesce(jsonb_agg(jsonb_build_array(i.material_id,i.drive_file_id,i.resource_key,coalesce(m.checksum,m.drive_version),i.name,m.lifecycle) order by i.material_id),'[]') from private.product_catalog_pool_images(p_team) i join public.team_materials m on m.id=i.material_id and m.team_id=p_team)
 )::text,'sha256'),'hex');
$$;
create or replace function private.launch_restitch_settings_version(p_team uuid,p_actor uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(jsonb_build_object(
 'defaults',private.effective_restitch_defaults_json(p_team,p_actor)-'updatedBy',
 'start',(select coalesce(jsonb_agg(jsonb_build_array(material_id,drive_file_id,resource_key,coalesce(checksum,drive_version)) order by material_id),'[]') from private.restitch_pool_images(p_team,p_actor,'start')),
 'end',(select coalesce(jsonb_agg(jsonb_build_array(material_id,drive_file_id,resource_key,coalesce(checksum,drive_version)) order by material_id),'[]') from private.restitch_pool_images(p_team,p_actor,'end'))
 )::text,'sha256'),'hex');
$$;
revoke all on function private.launch_catalog_settings_version(uuid),private.launch_restitch_settings_version(uuid,uuid) from public,anon,authenticated;
create or replace function private.launch_sources_from_config(p_team uuid,p_config jsonb,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.team_account_agents%rowtype;s public.team_accounts%rowtype;m public.team_materials%rowtype;o public.team_launch_offers%rowtype;b public.team_launch_buyers%rowtype;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into a from public.team_account_agents where id=(p_config->>'agentRowId')::uuid and team_id=p_team;
 select * into s from public.team_accounts where id=a.account_id and team_id=p_team;
 select * into m from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team and lifecycle='active' and kind='file' and category in('video','image');
 select * into o from public.team_launch_offers where id=(p_config->>'offerId')::uuid and team_id=p_team and archived_at is null;
 select * into b from public.team_launch_buyers where id=(p_config->>'buyerId')::uuid and team_id=p_team and archived_at is null;
 if a.id is null or s.id is null or m.id is null or o.id is null or b.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return jsonb_build_object('schemaVersion',1,'agentRowId',a.id,'accountId',s.id,'social',s.name,'agentId',a.agent_id,'offerId',o.id,'offer',o.name,'buyerId',b.id,'buyer',b.value,'materialId',m.id,'materialType',m.category,'materialVersion',m.drive_version,'materialChecksum',case when m.checksum ~* '^[0-9a-f]{32}$' then lower(m.checksum) else null end,'materialDriveFileId',m.drive_file_id,'catalogSettingsVersion',case when p_config->>'method'='catalog' then private.launch_catalog_settings_version(p_team) else null end,'restitchSettingsVersion',case when p_config->>'method'='catalog' and p_config->'catalog'->>'restitchEnabled'='true' then private.launch_restitch_settings_version(p_team,p_actor) else null end);
end $$;
