-- 1.4.3: the catalog manager row names a scheduled video-link publication.
--
-- A catalog whose link was deferred showed nothing in the manager: the time lived
-- only in «Відкладене відеопосилання», so a member scanning the list could not see
-- that a link was due at 19:42, or that it was waiting for its videos (1.4.3 QA).
-- The snapshot each row is drawn from now carries the pending scheduled
-- publication, if any: its due time, its zone, and whether its video set is still
-- being made. Display only; nothing here changes when or how a link is written.
begin;

create function private.catalog_registry_video_publication(p_team uuid, p_catalog uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'due_at', p.due_at,
  'time_zone', p.time_zone,
  'waiting_for_videos', coalesce(t.kind = 'video_set' and s.state is distinct from 'ready', false))
 from private.catalog_video_publication_policies p
 join private.catalog_video_publication_jobs j
   on j.catalog_material_id = p.catalog_material_id
  and j.team_id = p.team_id
  and j.state not in ('published', 'superseded', 'held')
 join private.catalog_publication_targets t on t.id = j.target_id and t.team_id = j.team_id
 left join private.catalog_video_sets s on s.id = t.video_set_id and s.team_id = t.team_id
 where p.team_id = p_team and p.catalog_material_id = p_catalog and p.mode = 'scheduled'
 limit 1
$$;
revoke all on function private.catalog_registry_video_publication(uuid, uuid)
  from public, anon, authenticated, service_role;

do $snapshot$
declare d text;
begin
 select pg_get_functiondef('public.list_team_catalog_manager_snapshot(uuid)'::regprocedure) into d;
 if strpos(d, $find$'video_generation',private.catalog_registry_video_generation(p_team,c.catalog_id))$find$) = 0 then
  raise exception 'MANAGER_SNAPSHOT_PUBLICATION_PATCH_MISSING';
 end if;
 d := replace(d,
  $find$'video_generation',private.catalog_registry_video_generation(p_team,c.catalog_id))$find$,
  $replace$'video_generation',private.catalog_registry_video_generation(p_team,c.catalog_id),'video_publication',private.catalog_registry_video_publication(p_team,c.catalog_id))$replace$);
 execute d;
end $snapshot$;

commit;
