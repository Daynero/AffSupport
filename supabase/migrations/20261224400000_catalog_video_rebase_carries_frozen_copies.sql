-- Production 2026-11-26 (set ccd19207, a catalog of ten videos made with the window open): after
-- eight videos the window stayed at «Готово відео: 8 з 10» for good, and restarting Soty did not
-- bring it back.
--
-- Drive moves a file's version on metadata-only changes (sharing by link, a copy to R2), and
-- Soty makes those changes itself while a catalog is being created. 20261215110000 answered that
-- with service_rebase_catalog_video_source: when the live version carries the very bytes the set
-- was made from, the set and its process intents move to it. Two rows that had frozen the set's
-- version when it was admitted were left behind:
--
--  * private.catalog_video_foreground_authorities.source_version. Every call of a set made with
--    the window open goes through private.require_catalog_video_foreground, which compares the
--    set with its authority field by field. From the rebase on, every call — the read that
--    follows the rebase itself, then load, save, heartbeat — was refused with AUTH_REQUIRED
--    (the 409 on `admit` and the 401s after it), on every attempt, restart or not.
--  * private.catalog_video_restitch_contexts.source_version. A set that draws its pictures from
--    Drive accepts a process alias only while intent, set and context agree on the version, so
--    its next video was refused with REQUEST_REUSE_CONFLICT.
--
-- On production every one of the 19 sets rebased since 2026-11-15 that had either row ended
-- cancelled; none finished.
--
-- Now the rebase carries both rows in its own transaction. The guards that keep them frozen let
-- exactly one thing move — the source version, and only to the version their own set holds —
-- so the proof stays where it was: the rebase's checksum comparison. The alias keeps comparing
-- the video's raw version with the context; nothing about that policy is relaxed.
--
-- And a creation the computer has left between two videos says so. The agentSilent answer of
-- service_read_initial_catalog_video only looked at a video whose process was under way; a set
-- stopped before its next video began had nothing to show but «8 з 10». The window already
-- knows what to say for agentSilent («Soty на комп’ютері не відповідає…»), so this needs no
-- new web build.
--
-- No table or column. No production row is waiting for a heal (checked 2026-11-26).
begin;
create or replace function private.guard_catalog_foreground_immutable()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
 if (new.enrollment_id,new.team_id,new.actor_id,new.session_id,new.source_material_id,new.consumer_kind,new.original_key,new.expected_version,new.native_instance_id,new.proof_hash,new.token_hash,new.created_at,new.expires_at)is distinct from(old.enrollment_id,old.team_id,old.actor_id,old.session_id,old.source_material_id,old.consumer_kind,old.original_key,old.expected_version,old.native_instance_id,old.proof_hash,old.token_hash,old.created_at,old.expires_at)or(old.video_set_id is not null and(new.video_set_id,new.settings_digest,new.canonical_key,new.original_request_id)is distinct from(old.video_set_id,old.settings_digest,old.canonical_key,old.original_request_id))or(old.unused_at is not null and new.unused_at is distinct from old.unused_at)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 -- A bound authority's source version may only follow its own set (a rebase proved the bytes).
 if old.video_set_id is not null and new.source_version is distinct from old.source_version
  and new.source_version is distinct from(select bound.source_version from private.catalog_video_sets bound where bound.id=old.video_set_id)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 return new;
end $function$;

-- The context of a set stays frozen except for the same single move.
create or replace function private.guard_catalog_video_context_immutable()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
 if (to_jsonb(new)-'source_version') is distinct from (to_jsonb(old)-'source_version')
  or (new.source_version is distinct from old.source_version
   and new.source_version is distinct from(select bound.source_version from private.catalog_video_sets bound where bound.id=old.video_set_id)) then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $function$;
revoke all on function private.guard_catalog_video_context_immutable() from public,anon,authenticated,service_role;
create or replace trigger catalog_video_context_immutable before update on private.catalog_video_restitch_contexts
 for each row execute function private.guard_catalog_video_context_immutable();

create or replace function public.service_rebase_catalog_video_source(p_set uuid, p_hash bytea, p_native uuid, p_protocol integer, p_version text, p_checksum text)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare s private.catalog_video_sets%rowtype; m public.team_materials%rowtype; previous text;
begin
  perform public.service_authorize_catalog_video_executor(p_set, p_hash, p_native, p_protocol);
  if p_version is null or char_length(p_version) not between 1 and 1024
     or p_checksum is null or p_checksum !~ '^[0-9a-f]{32}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into s from private.catalog_video_sets where id = p_set for update;
  if s.id is null or s.state not in ('accepted', 'preparing', 'unknown') then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  if s.source_version = p_version then return true; end if;
  select * into m from public.team_materials
   where id = s.source_material_id and team_id = s.team_id for update;
  -- Only the same bytes under a newer Drive version: anything else is a real change.
  if m.id is null or m.lifecycle <> 'active' or m.drive_version is distinct from p_version
     or m.checksum is distinct from p_checksum
     or s.source_snapshot->>'checksum' is distinct from p_checksum then
    raise exception 'SOURCE_CHANGED' using errcode = '55000';
  end if;
  previous := s.source_version;
  update private.team_operation_intents i set expected_source_version = p_version
   where i.team_id = s.team_id and i.tool_id = 'restitch' and i.expected_source_version = previous
     and i.operation_id in (select v.operation_id from private.catalog_video_variants v
                             where v.video_set_id = s.id and v.operation_id is not null);
  update private.catalog_video_sets
     set source_version = p_version,
         source_snapshot = jsonb_set(source_snapshot, '{version}', to_jsonb(p_version)),
         updated_at = clock_timestamp()
   where id = s.id;
  -- Everything that froze the set's version when it was admitted moves with it, or the very
  -- next call of this set is refused: its window-bound authority (AUTH_REQUIRED) and the
  -- context its pictures are drawn in (REQUEST_REUSE_CONFLICT).
  update private.catalog_video_foreground_authorities
     set source_version = p_version, updated_at = clock_timestamp()
   where video_set_id = s.id and source_version is distinct from p_version;
  update private.catalog_video_restitch_contexts
     set source_version = p_version
   where video_set_id = s.id and source_version is distinct from p_version;
  return true;
end $function$;

create or replace function public.service_read_initial_catalog_video(p_team uuid, p_actor uuid, p_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare result jsonb;descriptor jsonb;vset private.catalog_video_sets%rowtype;d private.team_recovery_delegations%rowtype;
 pending_set uuid;last_sign timestamptz;
begin
 result:=public.service_read_initial_catalog_video_before_foreground(p_team,p_actor,p_key);
 if result->>'outcome'='preparing_video'then
  pending_set:=(result->>'videoSetId')::uuid;
  descriptor:=private.catalog_video_public_executor(pending_set);if descriptor is not null then result:=result||jsonb_build_object('executor',descriptor);end if;
  if result->>'state' in('preparing','unknown') and exists(select 1 from private.catalog_video_variants v join private.catalog_video_sets s on s.id=v.video_set_id
   join public.team_operations o on o.team_id=s.team_id and o.actor_id=s.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   where v.video_set_id=pending_set and v.state='working' and o.state in('pending','running')
   and private.catalog_video_variant_last_life(v.video_set_id,v.video_variant_index,o.id)<=clock_timestamp()-interval '2 minutes') then
   result:=result||jsonb_build_object('agentSilent',true);
  end if;
  -- A creation made with the window open that the computer has left between two videos: no
  -- process is under way (the check above sees nothing), videos are still owed, and nothing of
  -- the set — a checkpoint, a heartbeat, a process, its authority — has moved for two minutes.
  -- One set only: the videos of a launch with several take their turns.
  if not result ? 'agentSilent' and not result ? 'videoSets' and result->>'state' in('preparing','unknown')
   and exists(select 1 from private.catalog_video_foreground_authorities bound where bound.video_set_id=pending_set and bound.redeemed_at is not null and bound.unused_at is null)
   and exists(select 1 from private.catalog_video_variants owed where owed.video_set_id=pending_set and owed.state<>'registered')
   and not exists(select 1 from private.catalog_video_variants busy join public.team_operations work on work.id=busy.operation_id
    where busy.video_set_id=pending_set and busy.state='working' and work.state in('pending','running')) then
   select greatest(kept.updated_at,
     coalesce((select max(bound.updated_at) from private.catalog_video_foreground_authorities bound where bound.video_set_id=kept.id),kept.updated_at),
     coalesce((select max(beat.heartbeat_at) from private.catalog_video_variants beat where beat.video_set_id=kept.id),kept.updated_at),
     coalesce((select max(work.updated_at) from private.catalog_video_variants done join public.team_operations work on work.id=done.operation_id where done.video_set_id=kept.id),kept.updated_at))
    into last_sign from private.catalog_video_sets kept where kept.id=pending_set and kept.team_id=p_team;
   if last_sign<=clock_timestamp()-interval '2 minutes' then result:=result||jsonb_build_object('agentSilent',true);end if;
  end if;
  -- 072: a set handed to background work that nobody has taken says why, as the manager's
  -- registry does for update rounds (private.catalog_registry_video_generation).
  if result->>'state'='preparing' then
   select * into vset from private.catalog_video_sets where id=pending_set and team_id=p_team;
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
