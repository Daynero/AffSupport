-- A manual update with restitch on a team without a background-recovery
-- delegation waits for an agent (note_catalog_variant_round_wait with
-- AGENT_REQUIRED). The manager row read that as "0 of N" with no reason and
-- looked hung. The registry progress now carries the round's wait reason.
begin;
create or replace function private.catalog_registry_video_generation(p_team uuid,p_catalog uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sid uuid;n integer;st text;k integer;child uuid;reason text;
begin
 select v.set_id into sid from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id where v.team_id=p_team and v.catalog_material_id=p_catalog and a.result in('running','unknown')and v.canceled_at is null order by v.created_at desc limit 1;
 if sid is null then select n0.set_id into sid from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then select t.video_set_id into sid from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id where p.team_id=p_team and p.catalog_material_id=p_catalog and t.kind='video_set';end if;
 if sid is null then select s.id into sid from private.catalog_video_sets s join private.catalog_generation_intents g on g.id=s.catalog_intent_id where g.team_id=p_team and g.result->'catalog'->>'materialId'=p_catalog::text order by s.created_at desc limit 1;end if;
 if sid is null then select n0.set_id,n0.requested_count into sid,n from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then return null;end if;
 select s.requested_count,s.state into n,st from private.catalog_video_sets s where s.id=sid and s.team_id=p_team;
 if not found then select requested_count into n from private.catalog_variant_round_snapshots where set_id=sid and team_id=p_team;st:='accepted';end if;
 select count(*)::integer into k from private.catalog_video_variants where video_set_id=sid and state='registered';
 select operation_id into child from private.catalog_video_variants where video_set_id=sid and state in('working','unknown')order by video_variant_index limit 1;
 -- A round that is waiting rather than working says why (note_catalog_variant_round_wait).
 if st<>'ready' then
  select coalesce(n0.failure_code,a.failure_code) into reason from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.set_id=sid and n0.team_id=p_team and a.result in('running','unknown') order by n0.created_at desc limit 1;
 end if;
 return jsonb_strip_nulls(jsonb_build_object('setId',sid,'requestedCount',n,'registeredCount',k,'state',st,'activeChildOperationId',child,'waitReason',reason));
end;$$;
revoke all on function private.catalog_registry_video_generation(uuid,uuid)from public,anon,authenticated,service_role;
commit;
