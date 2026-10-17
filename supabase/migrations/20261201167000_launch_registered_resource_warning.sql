-- A registered workspace catalog can exist before the Launch publication checkpoint.
create function private.launch_retained_catalogs(p_team uuid,p_launch uuid)
returns table(material_id uuid,restitch_material_id uuid) language sql stable security definer set search_path='' as $$
 select x.material_id,x.restitch_material_id from public.team_launch_revision_catalogs x
  join public.team_launch_revisions r on r.id=x.revision_id and r.team_id=x.team_id
  where r.team_id=p_team and r.launch_id=p_launch
 union
 select c.material_id,o.result_material_id from public.team_launch_generations g
  join private.catalog_generation_intents i on i.team_id=g.team_id and i.actor_id=g.actor_id
   and i.request_key='launch:'||g.id::text||':catalog' and i.state='registered'
  join public.team_product_catalogs c on c.team_id=i.team_id and c.material_id::text=i.result->'catalog'->>'materialId'
   and c.video_material_id=i.video_material_id
  left join public.team_operations o on o.id::text=i.request_payload->>'restitchOperationId'
   and o.team_id=g.team_id and o.actor_id=g.actor_id and o.source_material_id=i.video_material_id and o.state='succeeded'
  where g.team_id=p_team and g.launch_id=p_launch;
$$;
revoke all on function private.launch_retained_catalogs(uuid,uuid) from public,anon,authenticated,service_role;
create or replace function public.get_launch_archive_warning(p_team uuid,p_launch uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'delete');
 if not exists(select 1 from public.team_launches where team_id=p_team and id=p_launch) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 return jsonb_build_object('hasCatalog',exists(select 1 from private.launch_retained_catalogs(p_team,p_launch)),
  'hasRestitch',exists(select 1 from private.launch_retained_catalogs(p_team,p_launch) r where r.restitch_material_id is not null),
  'suppressed',coalesce((select suppress_catalog_retention_warning from public.team_launch_member_preferences where team_id=p_team and user_id=auth.uid()),false));
end $$;

create or replace function public.archive_launch(p_team uuid,p_launch uuid,p_expected_version text,p_key text,p_suppress boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;payload jsonb:=jsonb_build_array(p_launch,p_expected_version,p_suppress);replay jsonb;result jsonb;
begin
 perform private.launch_access(p_team,'delete');replay:=private.launch_request(p_team,p_key,'archive',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;perform private.launch_unlocked(p_team,p_launch);
 if p_expected_version is null or l.aggregate_version::text<>p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 update public.team_launches set archived_at=clock_timestamp(),aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into l;
 if p_suppress and exists(select 1 from private.launch_retained_catalogs(p_team,p_launch)) then
  insert into public.team_launch_member_preferences(team_id,user_id,suppress_catalog_retention_warning) values(p_team,auth.uid(),true) on conflict(team_id,user_id) do update set suppress_catalog_retention_warning=true,updated_at=clock_timestamp();
 end if;
 result:=jsonb_build_object('id',l.id,'version',l.aggregate_version::text);perform private.launch_signal(p_team,l.id,l.aggregate_version);perform private.launch_remember(p_team,p_key,'archive',payload,result);return result;
end $$;
