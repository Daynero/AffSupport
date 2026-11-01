-- A catalog explicitly created without stitching must not inherit a team-wide
-- stitching default for future updates. Bind its own profile before publication.
begin;
alter function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text)
  rename to service_attach_launch_catalog_before_original_policy;
alter function public.service_attach_launch_catalog_before_original_policy(uuid,uuid,uuid,text,text)
  set schema private;
revoke all on function private.service_attach_launch_catalog_before_original_policy(uuid,uuid,uuid,text,text)
  from public,anon,authenticated,service_role;

create function public.service_attach_launch_catalog(
  p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text
) returns void language plpgsql security definer set search_path='' as $$
declare catalog uuid; changed integer;
begin
 -- The existing implementation validates actor, lease, fence and registered
 -- output ownership. Never mutate a profile before those checks succeed.
 perform private.service_attach_launch_catalog_before_original_policy(p_team,p_generation,p_actor,p_owner,p_fence);
 select c.catalog_id into catalog
 from public.team_launch_generations g
 join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id
 join public.team_launch_revision_catalogs c on c.revision_id=r.id and c.team_id=g.team_id
 where g.team_id=p_team and g.id=p_generation
   and r.config->>'method'='catalog' and r.config->'catalog'->>'restitchEnabled'='false';
 if catalog is null then return; end if;
 if not exists(select 1 from public.team_catalog_update_profiles p where p.team_id=p_team and p.catalog_material_id=catalog) then
   raise exception 'WRONG_STATE' using errcode='55000';
 end if;
 update public.team_catalog_update_profiles p
 set restitch=false,version=p.version+1,updated_at=clock_timestamp(),updated_by=p_actor
 where p.team_id=p_team and p.catalog_material_id=catalog and p.restitch;
 get diagnostics changed=row_count;
 if changed>0 then
   update public.team_catalog_updaters u set restitch=exists(
     select 1 from public.team_catalog_update_profiles p where p.team_id=p_team and p.restitch
   ) where u.team_id=p_team;
   perform private.sync_catalog_updater(p_team);
 end if;
end $$;
revoke all on function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_attach_launch_catalog(uuid,uuid,uuid,text,text) to service_role;
commit;
