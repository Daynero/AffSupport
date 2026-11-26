-- Hotfix 2026-11-26 (applied to prod 09:42 UTC and to beta): 20261224210000 (072) declared a PL/pgSQL
-- variable `s` that collides with the table alias `s` in the agentSilent check, so every read of a
-- preparing launch catalog video failed with 42702 "column reference s.id is ambiguous" and the launch
-- stopped at «Каталог» with «Сервер відповів несподівано». The variable is renamed; behaviour is unchanged.
begin;
CREATE OR REPLACE FUNCTION public.service_read_initial_catalog_video(p_team uuid, p_actor uuid, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;descriptor jsonb;vset private.catalog_video_sets%rowtype;d private.team_recovery_delegations%rowtype;
begin
 result:=public.service_read_initial_catalog_video_before_foreground(p_team,p_actor,p_key);
 if result->>'outcome'='preparing_video'then
  descriptor:=private.catalog_video_public_executor((result->>'videoSetId')::uuid);if descriptor is not null then result:=result||jsonb_build_object('executor',descriptor);end if;
  if result->>'state' in('preparing','unknown') and exists(select 1 from private.catalog_video_variants v join private.catalog_video_sets s on s.id=v.video_set_id
   join public.team_operations o on o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   where v.video_set_id=(result->>'videoSetId')::uuid and v.state='working' and o.state in('pending','running')
   and private.catalog_video_variant_last_life(v.video_set_id,v.video_variant_index,o.id)<=clock_timestamp()-interval '2 minutes') then
   result:=result||jsonb_build_object('agentSilent',true);
  end if;
  -- 072: a set handed to background work that nobody has taken says why, as the manager's
  -- registry does for update rounds (private.catalog_registry_video_generation).
  if result->>'state'='preparing' then
   select * into vset from private.catalog_video_sets where id=(result->>'videoSetId')::uuid and team_id=p_team;
   if vset.id is not null and vset.state='accepted' and vset.native_instance_id is null and vset.executor_id is not null
      and vset.created_at<statement_timestamp()-interval '3 minutes' then
    if not exists(select 1 from public.team_materials m join public.team_drive_connections c on c.id=m.connection_id and c.team_id=m.team_id
                  where m.id=vset.source_material_id and m.team_id=p_team and c.state in('connected','unavailable')) then
     result:=result||jsonb_build_object('waitReason','NEEDS_REAUTH');
    else
     select * into d from private.team_recovery_delegations where team_id=p_team and actor_id=vset.actor_id and installation_id=vset.executor_id
      and revoked_at is null and expires_at>statement_timestamp() order by created_at desc limit 1;
     if d.id is null then result:=result||jsonb_build_object('waitReason','AGENT_REQUIRED');
     elsif (d.last_claim_at is null or d.last_claim_at<vset.created_at)
      and not exists(select 1 from private.catalog_video_sets o where o.team_id=p_team and o.executor_id=vset.executor_id and o.id<>vset.id and o.state='preparing') then
      result:=result||jsonb_build_object('backgroundStalled',true);
     end if;
    end if;
   end if;
  end if;
 end if;
 return result;
end $function$;
commit;
