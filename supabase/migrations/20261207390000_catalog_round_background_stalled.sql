-- A manager round with restitch is executed by this computer's background
-- work (a recovery delegation claims the video set). On beta, 2026-11-11, one
-- uncertain claim parked the agent's worker for good (blocked,
-- checkpoint_unavailable) and every later round sat in
-- «Очікуємо підготовку відео…» with no reason given: the delegation existed,
-- so nothing said AGENT_REQUIRED, and nothing claimed the set either.
--
-- The registry progress now says it, three minutes after the set was
-- accepted:
--  * no live delegation for the set's executor -> waitReason AGENT_REQUIRED;
--  * a live delegation that has not claimed since the set was accepted, while
--    it is not busy with another set -> backgroundStalled true (a new key, so
--    an older client that validates waitReason strictly keeps reading the row).
begin;
create or replace function private.catalog_registry_video_generation(p_team uuid,p_catalog uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sid uuid;n integer;st text;k integer;child uuid;reason text;s private.catalog_video_sets%rowtype;d private.team_recovery_delegations%rowtype;stalled boolean:=false;
begin
 select v.set_id into sid from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id where v.team_id=p_team and v.catalog_material_id=p_catalog and a.result in('running','unknown')and v.canceled_at is null order by v.created_at desc limit 1;
 if sid is null then select n0.set_id into sid from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then select t.video_set_id into sid from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id where p.team_id=p_team and p.catalog_material_id=p_catalog and t.kind='video_set';end if;
 if sid is null then select s0.id into sid from private.catalog_video_sets s0 join private.catalog_generation_intents g on g.id=s0.catalog_intent_id where g.team_id=p_team and g.result->'catalog'->>'materialId'=p_catalog::text order by s0.created_at desc limit 1;end if;
 if sid is null then select n0.set_id,n0.requested_count into sid,n from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then return null;end if;
 select s0.requested_count,s0.state into n,st from private.catalog_video_sets s0 where s0.id=sid and s0.team_id=p_team;
 if not found then select requested_count into n from private.catalog_variant_round_snapshots where set_id=sid and team_id=p_team;st:='accepted';end if;
 select count(*)::integer into k from private.catalog_video_variants where video_set_id=sid and state='registered';
 select operation_id into child from private.catalog_video_variants where video_set_id=sid and state in('working','unknown')order by video_variant_index limit 1;
 -- A round that is waiting rather than working says why (note_catalog_variant_round_wait).
 if st<>'ready' then
  select coalesce(n0.failure_code,a.failure_code) into reason from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.set_id=sid and n0.team_id=p_team and a.result in('running','unknown') order by n0.created_at desc limit 1;
 end if;
 -- An update round's set that nobody has claimed: is there background work to claim it?
 if st='accepted' and reason is null then
  select * into s from private.catalog_video_sets where id=sid and team_id=p_team;
  if s.id is not null and s.update_attempt_id is not null and s.native_instance_id is null and s.executor_id is not null and s.created_at<statement_timestamp()-interval '3 minutes' then
   select * into d from private.team_recovery_delegations where team_id=p_team and actor_id=s.actor_id and installation_id=s.executor_id and revoked_at is null and expires_at>statement_timestamp() order by created_at desc limit 1;
   if d.id is null then reason:='AGENT_REQUIRED';
   elsif (d.last_claim_at is null or d.last_claim_at<s.created_at)
    and not exists(select 1 from private.catalog_video_sets o where o.team_id=p_team and o.executor_id=s.executor_id and o.id<>s.id and o.state='preparing') then stalled:=true;
   end if;
  end if;
 end if;
 return jsonb_strip_nulls(jsonb_build_object('setId',sid,'requestedCount',n,'registeredCount',k,'state',st,'activeChildOperationId',child,'waitReason',reason,'backgroundStalled',case when stalled then true end));
end;$$;
revoke all on function private.catalog_registry_video_generation(uuid,uuid)from public,anon,authenticated,service_role;
commit;
