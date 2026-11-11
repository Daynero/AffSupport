-- A restitch whose agent died hung until the 12-hour abandonment rule of
-- 20261207199000 (beta 2026-11-11, set 5a2d8619: agent killed mid-run, the
-- restarted agent's takeover refused with PROCESS_RESULT_UNCERTAIN because the
-- variant was still 'working'), and cancelled sets stayed 'cancel_requested'
-- forever when a variant was 'working' with no operation or with a dead one.
--
-- Liveness signal: every live agent already calls variant_heartbeat every 30 s
-- for the whole run (catalog-variant-recovery.ts, foreground and background,
-- 1.4.2 included). The server now records it.
--  * takeover: the same installation (proof secret) restarted as a NEW native
--    instance asks to take over its set; a variant silent for 2 minutes is
--    failed and requeued, so the restarted agent continues the creation;
--  * cancellation: a cancelled variant silent for 3 minutes ends canceled (a
--    live executor sees the cancellation on its next heartbeat and stops);
--  * sweep: 15 minutes of silence, still silent on a second observation at
--    least 2 minutes later (guards the minute after a database outage), is
--    abandoned as by the 12-hour rule, which stays as the fallback.
begin;
alter table private.catalog_video_variants
 add column heartbeat_at timestamptz,
 add column silence_observed_at timestamptz;

create function public.service_note_catalog_video_variant_heartbeat(p_set uuid,p_hash bytea,p_native uuid,p_protocol integer,p_index integer,p_request uuid,p_operation uuid default null) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.service_authorize_catalog_video_executor(p_set,p_hash,p_native,p_protocol);
 update private.catalog_video_variants set heartbeat_at=clock_timestamp(),silence_observed_at=null
  where video_set_id=p_set and video_variant_index=p_index and request_id=p_request and state='working'
  and (p_operation is null or operation_id is null or operation_id=p_operation);
 return found;
end;$$;
revoke all on function public.service_note_catalog_video_variant_heartbeat(uuid,bytea,uuid,integer,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_note_catalog_video_variant_heartbeat(uuid,bytea,uuid,integer,integer,uuid,uuid) to service_role;

-- Last sign of life of a variant's operation: its own updates, grant rounds
-- (a round is issued 6 hours before it expires) and recorded heartbeats.
create function private.catalog_video_variant_last_life(p_set uuid,p_index integer,p_operation uuid) returns timestamptz language sql stable security definer set search_path='' as $$
 select greatest(o.updated_at,o.created_at,
  coalesce((select max(r.expires_at)-interval '6 hours' from private.catalog_video_grant_rounds r where r.video_set_id=p_set and r.video_variant_index=p_index),o.created_at),
  coalesce(v.heartbeat_at,o.created_at))
 from public.team_operations o join private.catalog_video_variants v on v.video_set_id=p_set and v.video_variant_index=p_index
 where o.id=p_operation
$$;
revoke all on function private.catalog_video_variant_last_life(uuid,integer,uuid) from public,anon,authenticated,service_role;

-- Sweep rule: 15 minutes of silence, confirmed by a second observation at
-- least 2 minutes after the first. Records the first observation.
create function private.catalog_video_variant_silence_confirmed(p_set uuid,p_index integer,p_operation uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare v private.catalog_video_variants%rowtype;last_life timestamptz;
begin
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index;
 last_life:=private.catalog_video_variant_last_life(p_set,p_index,p_operation);
 if v.video_set_id is null or last_life is null then return false;end if;
 if last_life>clock_timestamp()-interval '15 minutes' then
  if v.silence_observed_at is not null then update private.catalog_video_variants set silence_observed_at=null where video_set_id=p_set and video_variant_index=p_index;end if;
  return false;
 end if;
 if v.silence_observed_at is null or v.silence_observed_at<=last_life then
  update private.catalog_video_variants set silence_observed_at=clock_timestamp() where video_set_id=p_set and video_variant_index=p_index;
  return false;
 end if;
 return v.silence_observed_at<=clock_timestamp()-interval '2 minutes';
end;$$;
revoke all on function private.catalog_video_variant_silence_confirmed(uuid,integer,uuid) from public,anon,authenticated,service_role;

-- The resolver of 20261207199000 also abandons an operation whose silence is confirmed.
do $retry$
declare d text;needle text:=$find$if greatest(o.updated_at,o.created_at,coalesce(last_grant,o.created_at))>clock_timestamp()-interval '12 hours' then return jsonb_build_object('kind','unknown');end if;$find$;
begin
 select pg_get_functiondef('private.retry_failed_catalog_video_variant(uuid,integer)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'VARIANT_LIVENESS_RETRY_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$if greatest(o.updated_at,o.created_at,coalesce(last_grant,o.created_at))>clock_timestamp()-interval '12 hours' and private.catalog_video_variant_silence_confirmed(p_set,p_index,o.id) is not true then return jsonb_build_object('kind','unknown');end if;$replace$);
 execute d;
end $retry$;

-- Takeover: fail and requeue every working variant of the set whose operation
-- has been silent for p_silence and owns no output. A variant that may not be
-- retried any more ends unknown, and the set with it.
create function private.release_silent_catalog_video_variants(p_set uuid,p_silence interval) returns integer language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;answer jsonb;n integer:=0;
begin
 select * into s from private.catalog_video_sets where id=p_set for update;
 if s.id is null or s.state not in('accepted','preparing','unknown') then return 0;end if;
 for v in select * from private.catalog_video_variants where video_set_id=p_set and state='working' and output_material_id is null order by video_variant_index for update loop
  select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
  if o.id is null or o.state not in('pending','running') or o.result_material_id is not null
   or exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id)
   or exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.provider_result_id is not null) then continue;end if;
  if private.catalog_video_variant_last_life(p_set,v.video_variant_index,o.id)>clock_timestamp()-p_silence then continue;end if;
  update public.team_operations set state='failed',error_code='PROCESS_RESULT_UNCERTAIN',retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=o.id;
  answer:=private.retry_failed_catalog_video_variant(p_set,v.video_variant_index);
  if answer->>'kind' in('retry','registered') then n:=n+1;
  else
   update private.catalog_video_variants set state='unknown' where video_set_id=p_set and video_variant_index=v.video_variant_index and state='working';
   update private.catalog_video_sets set state='unknown',revision=revision+1,updated_at=clock_timestamp() where id=p_set and state in('accepted','preparing');
  end if;
 end loop;
 return n;
end;$$;
revoke all on function private.release_silent_catalog_video_variants(uuid,interval) from public,anon,authenticated,service_role;

-- A restarted agent of the same installation asks to take over its set as a
-- new native instance: its old instance stopped heartbeating.
do $redeem$
declare d text;needle text:=$find$if f.execution_native_instance_id is distinct from coalesce(p_expected_execution_native,p_native)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;$find$;
begin
 select pg_get_functiondef('public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid)'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'VARIANT_LIVENESS_REDEEM_SEAM_CHANGED';end if;
 d:=replace(d,needle,needle||$add$
  if s.state in('accepted','preparing','unknown') then perform private.release_silent_catalog_video_variants(s.id,interval '2 minutes');select *into s from private.catalog_video_sets where id=p_set;end if;$add$);
 execute d;
end $redeem$;

-- Cancellation: a working variant that never got an operation (the admission
-- trigger refuses one once cancellation is requested) is quiescent, and a
-- cancelled operation silent for 3 minutes ends canceled.
do $quiescent$
declare d text;
 needle1 text:=$find$if has_operation or v.operation_id is not null or v.state<>'queued'or v.dispatch_credential_hash is not null then return false;end if;$find$;
 needle2 text:=$find$  if o.state in('pending','running')then$find$;
begin
 select pg_get_functiondef('private.catalog_video_cancel_quiescent(uuid)'::regprocedure) into d;
 if strpos(d,needle1)=0 or strpos(d,needle2)=0 then raise exception 'VARIANT_LIVENESS_CANCEL_SEAM_CHANGED';end if;
 d:=replace(d,needle1,$replace$if has_operation or v.operation_id is not null or v.state not in('queued','working')or v.dispatch_credential_hash is not null then return false;end if;$replace$);
 d:=replace(d,needle2,$replace$  if o.state in('pending','running') and private.catalog_video_variant_last_life(s.id,v.video_variant_index,o.id)<=clock_timestamp()-interval '3 minutes' then
   -- Cancelled and silent: a live executor would have stopped on its next heartbeat.
   perform public.service_transition_team_operation(o.id,'canceled','canceled',o.progress,null,'PROCESS_CANCELED',false);
   continue;
  end if;
  if o.state in('pending','running')then$replace$);
 execute d;
end $quiescent$;

-- The per-minute settlement also resolves active creation and launch sets
-- whose executor went silent (catalog-manager rounds are swept by 220000).
do $settle$
declare d text;
begin
 select pg_get_functiondef('public.service_settle_catalog_video_cancellations(integer)'::regprocedure) into d;
 if strpos(d,'declare candidate record;')=0 or strpos(d,$find$return jsonb_build_object('settled',n);$find$)=0 then raise exception 'VARIANT_LIVENESS_SETTLE_SEAM_CHANGED';end if;
 d:=replace(d,'declare candidate record;','declare idx integer;resolved integer:=0;active record;candidate record;');
 d:=replace(d,$find$return jsonb_build_object('settled',n);$find$,$replace$for active in select silent.id from private.catalog_video_sets silent where silent.state in('accepted','preparing','unknown') and silent.update_attempt_id is null
  and exists(select 1 from private.catalog_video_variants v join public.team_operations o on o.team_id=silent.team_id and o.actor_id=silent.actor_id and o.kind='process' and o.idempotency_key='catalog-variant:'||v.request_id::text
   where v.video_set_id=silent.id and v.state='working' and o.state in('pending','running') and o.result_material_id is null
   and not exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id)
   and not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.provider_result_id is not null)
   and private.catalog_video_variant_last_life(silent.id,v.video_variant_index,o.id)<=clock_timestamp()-interval '15 minutes')
  order by silent.updated_at,silent.id limit p_limit loop
  perform 1 from private.catalog_video_sets where id=active.id for update skip locked;if not found then continue;end if;
  for idx in select video_variant_index from private.catalog_video_variants where video_set_id=active.id and state='working' order by video_variant_index loop
   perform private.retry_failed_catalog_video_variant(active.id,idx);
  end loop;
  resolved:=resolved+1;
 end loop;
 return jsonb_build_object('settled',n,'resolved',resolved);$replace$);
 execute d;
end $settle$;

-- The creation read says when the agent stopped answering, so the web can name it.
create or replace function public.service_read_initial_catalog_video(p_team uuid,p_actor uuid,p_key text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;descriptor jsonb;
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
 end if;
 return result;
end $$;
revoke all on function public.service_read_initial_catalog_video(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.service_read_initial_catalog_video(uuid,uuid,text)to service_role;
commit;
