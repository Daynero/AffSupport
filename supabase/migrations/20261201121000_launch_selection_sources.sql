-- Source metadata read when selections change; preview calculations remain local.
create function private.launch_sources_from_config(p_team uuid,p_config jsonb,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.team_account_agents%rowtype;s public.team_accounts%rowtype;m public.team_materials%rowtype;o public.team_launch_offers%rowtype;b public.team_launch_buyers%rowtype;
begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into a from public.team_account_agents where id=(p_config->>'agentRowId')::uuid and team_id=p_team;
 select * into s from public.team_accounts where id=a.account_id and team_id=p_team;
 select * into m from public.team_materials where id=(p_config->>'materialId')::uuid and team_id=p_team and lifecycle='active' and kind='file' and category in('video','image');
 select * into o from public.team_launch_offers where id=(p_config->>'offerId')::uuid and team_id=p_team and archived_at is null;
 select * into b from public.team_launch_buyers where id=(p_config->>'buyerId')::uuid and team_id=p_team and archived_at is null;
 if a.id is null or s.id is null or m.id is null or o.id is null or b.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return jsonb_build_object('schemaVersion',1,'agentRowId',a.id,'accountId',s.id,'social',s.name,'agentId',a.agent_id,'offerId',o.id,'offer',o.name,'buyerId',b.id,'buyer',b.value,'materialId',m.id,'materialType',m.category,'materialVersion',m.drive_version,'catalogSettingsVersion',null);
end $$;

create or replace function public.service_launch_sources(p_team uuid,p_launch uuid,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cfg jsonb;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select draft_config into cfg from public.team_launches where id=p_launch and team_id=p_team and archived_at is null;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;return private.launch_sources_from_config(p_team,cfg,p_actor);
end $$;
create function public.resolve_launch_selection(p_team uuid,p_config jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform private.launch_access(p_team,'edit');return private.launch_sources_from_config(p_team,p_config,auth.uid());end $$;
revoke all on function private.launch_sources_from_config(uuid,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.resolve_launch_selection(uuid,jsonb) from public,anon;
grant execute on function public.resolve_launch_selection(uuid,jsonb) to authenticated;
