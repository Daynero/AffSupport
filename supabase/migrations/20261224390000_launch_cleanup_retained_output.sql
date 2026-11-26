-- Production 2026-11-26 (generation 61028246): a launch cancelled three seconds after its catalog
-- sheet had been created stayed in canceled_with_cleanup_pending for three days, and could be
-- neither cancelled (it already was) nor deleted (LAUNCH_BUSY).
--
-- 1. The sheet had already become a file of the space. service_claim_launch_cleanup rightly
--    offers no output to remove then (a material is never deleted by a cancel), and
--    service_authorize_launch_cleanup answers `retained` for it — but the finish step only knew
--    two ways to be done with a started creation: the intent registered, or the output marked
--    removed (launchOutputCleaned). A kept file is neither, so every five minutes the tick found
--    nothing to do and nothing settled: LAUNCH_RESULT_UNCERTAIN, next attempt in five minutes.
--
--    Now a created output that is a material is settled as kept, by the same test the claim and
--    the authorisation use (a material with that Drive id, of any lifecycle — a trashed sheet is
--    still not this cleanup's to remove). The intent's checkpoint says so with its own mark,
--    launchOutputRetained; launchOutputCleaned keeps meaning "removed". The sharing condition is
--    unchanged: a link this attempt opened on a source is still closed first, and one that was
--    public before (prior_anyone, `preserved`) never held a cleanup back.
--
-- 2. A cancelled launch whose leftovers are still being removed can be deleted: the cleanup
--    works from the generation and its intent, not from the launch being listed, and carries on.
--    Every other unfinished state refuses as before.
--
-- No table or column. Nothing is healed here: the one production row was closed by hand.
begin;
create or replace function public.service_finish_launch_cleanup_before_video(p_team uuid, p_generation uuid, p_owner uuid, p_fence text, p_intent_fence text, p_cleaned_file text default null::text)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;i private.catalog_generation_intents%rowtype;settled boolean;
 output_file text;kept boolean;
begin
 if p_owner is null or p_fence is null or p_intent_fence is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=g.actor_id and request_key='launch:'||g.id::text||':catalog' for update;
 if g.id is null or i.id is null or g.state is distinct from 'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text or g.fence::text is distinct from p_fence or (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
  or i.lease_owner is distinct from p_owner or i.fence::text is distinct from p_intent_fence or (i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp()) then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_cleaned_file is not null then
  if public.service_authorize_launch_cleanup(p_team,p_generation,p_owner,p_fence,p_intent_fence,p_cleaned_file) is distinct from 'owned_unpublished' then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
  update private.catalog_generation_intents set checkpoint=checkpoint||'{"launchOutputCleaned":true}',updated_at=clock_timestamp() where id=i.id returning * into i;
  update private.catalog_generation_sharing set state='cleaned',updated_at=clock_timestamp()
   where intent_id=i.id and file_id=p_cleaned_file and state<>'cleaned';
 end if;
 -- The created output is a material: service_claim_launch_cleanup never offers it for removal
 -- and service_authorize_launch_cleanup answers `retained`. There is nothing left to remove.
 output_file:=i.checkpoint->>'providerFileId';
 kept:=i.state<>'registered' and i.checkpoint->>'launchOutputCleaned' is distinct from 'true'
  and output_file is not null and exists(select 1 from public.team_materials m where m.drive_file_id=output_file);
 if kept and i.checkpoint->>'launchOutputRetained' is distinct from 'true' then
  update private.catalog_generation_intents set checkpoint=checkpoint||'{"launchOutputRetained":true}',updated_at=clock_timestamp() where id=i.id returning * into i;
 end if;
 settled:=i.state='registered' or
  ((i.checkpoint->>'createStarted' is distinct from 'true' or i.checkpoint->>'launchOutputCleaned'='true' or kept)
   and not exists(select 1 from private.catalog_generation_sharing s where s.intent_id=i.id and not s.prior_anyone
    and s.state not in('cleaned','retained') and (s.created_by_attempt or s.state in('pending','cleanup_pending','revoking'))));
 if settled and i.state<>'registered' then update private.catalog_generation_intents set state='canceled',lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where id=i.id;end if;
 update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
  stage=case when settled then 'cancel' else 'cleanup' end,state_version=state_version+1,lease_owner=null,lease_expires_at=null,
  next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
  safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,updated_at=clock_timestamp() where id=g.id;
 update private.catalog_generation_intents set lease_expires_at=clock_timestamp(),next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end where id=i.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return case when settled then 'canceled' else 'canceled_with_cleanup_pending' end;
end $function$;

create or replace function private.archive_launch_pre_assignment(p_team uuid, p_launch uuid, p_expected_version text, p_key text, p_suppress boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare l public.team_launches%rowtype;payload jsonb:=jsonb_build_array(p_launch,p_expected_version,p_suppress);replay jsonb;result jsonb;
begin
 perform private.launch_access(p_team,'delete');replay:=private.launch_request(p_team,p_key,'archive',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=p_launch and team_id=p_team and archived_at is null for update;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 -- private.launch_unlocked, except that a cancelled generation still removing its leftovers
 -- does not hold the launch: that cleanup needs nothing from the launch being listed.
 if exists(select 1 from public.team_launch_generations where team_id=p_team and launch_id=p_launch
  and state not in('succeeded','canceled','failed','canceled_with_cleanup_pending')) then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
 if p_expected_version is null or l.aggregate_version::text<>p_expected_version then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode = 'PT409';end if;
 update public.team_launches set archived_at=clock_timestamp(),aggregate_version=aggregate_version+1,updated_at=clock_timestamp() where id=p_launch returning * into l;
 if p_suppress and exists(select 1 from private.launch_retained_catalogs(p_team,p_launch)) then
  insert into public.team_launch_member_preferences(team_id,user_id,suppress_catalog_retention_warning) values(p_team,auth.uid(),true) on conflict(team_id,user_id) do update set suppress_catalog_retention_warning=true,updated_at=clock_timestamp();
 end if;
 result:=jsonb_build_object('id',l.id,'version',l.aggregate_version::text);perform private.launch_signal(p_team,l.id,l.aggregate_version);perform private.launch_remember(p_team,p_key,'archive',payload,result);return result;
end $function$;
commit;
