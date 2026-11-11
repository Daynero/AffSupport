-- A catalog video variant whose child operation ended terminally failed stayed
-- 'unknown' forever: reconcile answers 'unknown' for everything that is not a
-- succeeded or still-admissible operation, and nothing requeues a variant. One
-- failed video out of N therefore buried the whole set (production,
-- 2026-11-10: 9 of 10 ready, launch unrecoverable).
--
-- A variant may now be retried, at most twice, and only when its operation is
-- PROVABLY terminal without output (failed, or abandoned for 12 hours, with no
-- result material, upload ownership or provider result). A succeeded operation
-- whose confirmation was lost is registered. Anything that may still be running
-- or may have produced output keeps today's answer. A retry never reuses the consumed
-- execution fence: the variant gets a new request id (hence a new operation),
-- and the retired identity is kept as history.
begin;
alter table private.catalog_video_variants
 add column retry_count integer not null default 0 check(retry_count between 0 and 2),
 add column original_request_id uuid;
create table private.catalog_video_variant_attempts (
 video_set_id uuid not null,video_variant_index integer not null,attempt integer not null check(attempt between 0 and 1),
 team_id uuid not null,request_id uuid not null unique,operation_id uuid not null unique references public.team_operations(id),
 failure_code text,retired_at timestamptz not null default clock_timestamp(),
 primary key(video_set_id,video_variant_index,attempt),
 foreign key(video_set_id,video_variant_index) references private.catalog_video_variants(video_set_id,video_variant_index)
);
alter table private.catalog_video_variant_attempts enable row level security;
alter table private.catalog_video_variant_attempts force row level security;
revoke all on private.catalog_video_variant_attempts from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_variant_attempts for each row execute function private.guard_task_cleanup_reference();
-- One alias per root operation remains; a retried variant owns a second root.
alter table private.restitch_process_aliases drop constraint restitch_process_aliases_video_set_id_video_variant_index_key;

-- Caller holds no locks. Order is the same as every other set path: set, variant, operation.
-- Three provable outcomes; everything else keeps today's answer (unknown):
--  * the operation SUCCEEDED with a registered output of the frozen source: the
--    lost confirmation is replayed and the variant becomes registered;
--  * the operation is pending/running but has shown no activity for 12 hours
--    (no grant reserved, no operation update; a run and its two 6-hour grants
--    cannot outlive that) and owns no upload: it is failed as abandoned, then
--    retried like a failure;
--  * the operation FAILED without output: the variant is requeued under a new
--    identity, at most twice.
create function private.retry_failed_catalog_video_variant(p_set uuid,p_index integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;i private.team_operation_intents%rowtype;fresh uuid;last_grant timestamptz;
begin
 select * into s from private.catalog_video_sets where id=p_set for update;
 select * into v from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index for update;
 if s.id is null or v.request_id is null or s.state not in('accepted','preparing','unknown') or v.state not in('working','unknown') or v.output_material_id is not null then return jsonb_build_object('kind','none');end if;
 select * into o from public.team_operations where team_id=s.team_id and actor_id=s.actor_id and kind='process' and idempotency_key='catalog-variant:'||v.request_id::text for update;
 if o.id is null or (v.operation_id is not null and v.operation_id is distinct from o.id) then return jsonb_build_object('kind','unknown');end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=s.team_id;
 if i.operation_id is null or i.tool_id is distinct from 'restitch' or i.expected_source_version is distinct from s.source_version or o.source_material_id is distinct from s.source_material_id then return jsonb_build_object('kind','unknown');end if;
 -- (c) Succeeded with output: replay the confirmation the agent never received.
 if o.state='succeeded' then
  if o.result_material_id is null or not exists(select 1 from public.team_materials m where m.id=o.result_material_id and m.team_id=s.team_id and m.lifecycle='active') then return jsonb_build_object('kind','unknown');end if;
  update private.catalog_video_variants set state='registered',operation_id=o.id,output_material_id=o.result_material_id where video_set_id=p_set and video_variant_index=p_index;
  update private.catalog_video_sets set revision=revision+1,state=case when not exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state<>'registered') then 'ready' when exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state='unknown') then 'unknown' else 'preparing' end,updated_at=clock_timestamp() where id=p_set;
  return jsonb_build_object('kind','registered','operationId',o.id,'outputId',o.result_material_id);
 end if;
 if o.result_material_id is not null or i.provider_result_id is not null or exists(select 1 from private.process_upload_ownership w where w.operation_id=o.id) then return jsonb_build_object('kind','unknown');end if;
 -- (b) Abandoned: no sign of life for 12 hours. Failing it first means no late
 -- finalize can attach output to the retired identity.
 if o.state in('pending','running') then
  select max(r.expires_at)-interval '6 hours' into last_grant from private.catalog_video_grant_rounds r where r.video_set_id=p_set and r.video_variant_index=p_index;
  if greatest(o.updated_at,o.created_at,coalesce(last_grant,o.created_at))>clock_timestamp()-interval '12 hours' then return jsonb_build_object('kind','unknown');end if;
  update public.team_operations set state='failed',error_code='PROCESS_RESULT_UNCERTAIN',retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=o.id returning * into o;
 end if;
 if o.state is distinct from 'failed' then return jsonb_build_object('kind','unknown');end if;
 -- (a) The same input fails the same way: do not spend two more full runs on it.
 if v.retry_count>=2 or o.error_code is null or o.error_code like 'STITCH_PLAN_%' or o.error_code in('SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_SOURCE_FORBIDDEN','UNSUPPORTED_MEDIA','TOO_LARGE','RESTITCH_INVALID','RESTITCH_NO_SCREENS','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_SELECTION_LIMIT','STITCH_PATH_INVALID')
  then return jsonb_build_object('kind','terminal','attempt',v.retry_count,'code',o.error_code);end if;
 fresh:=gen_random_uuid();
 insert into private.catalog_video_variant_attempts(video_set_id,video_variant_index,attempt,team_id,request_id,operation_id,failure_code) values(p_set,p_index,v.retry_count,s.team_id,v.request_id,o.id,o.error_code);
 delete from private.catalog_video_grant_rounds where video_set_id=p_set and video_variant_index=p_index;
 update private.catalog_video_variants set original_request_id=coalesce(original_request_id,request_id),request_id=fresh,operation_id=null,state='queued',dispatch_credential_hash=null,dispatch_native_instance_id=null,grant_refreshes=0,retry_count=retry_count+1 where video_set_id=p_set and video_variant_index=p_index;
 update private.catalog_video_sets set revision=revision+1,state=case when exists(select 1 from private.catalog_video_variants where video_set_id=p_set and state='unknown') then 'unknown' else 'preparing' end,updated_at=clock_timestamp() where id=p_set;
 return jsonb_build_object('kind','retry','requestId',fresh,'attempt',v.retry_count+1);
end;$$;
revoke all on function private.retry_failed_catalog_video_variant(uuid,integer) from public,anon,authenticated,service_role;

-- Executor-scoped: the agent's reconcile step asks for it explicitly. The
-- heartbeat's own reconcile stays read-only.
create function public.service_retry_catalog_video_variant(p_set uuid,p_team uuid,p_actor uuid,p_executor uuid,p_epoch bigint,p_index integer,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.service_read_catalog_video_set(p_set,p_team,p_actor,p_executor,p_epoch);
 if not exists(select 1 from private.catalog_video_variants where video_set_id=p_set and video_variant_index=p_index and request_id=p_request) then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 return private.retry_failed_catalog_video_variant(p_set,p_index);
end;$$;
revoke all on function public.service_retry_catalog_video_variant(uuid,uuid,uuid,uuid,bigint,integer,uuid) from public,anon,authenticated;
grant execute on function public.service_retry_catalog_video_variant(uuid,uuid,uuid,uuid,bigint,integer,uuid) to service_role;

-- Owner-scoped: catalog creation, launch and recovery ask before they decide
-- that an unknown set cannot move.
create function public.service_retry_failed_catalog_video_variants(p_set uuid,p_team uuid,p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;n integer;answer jsonb;retried integer:=0;registered integer:=0;terminal integer:=0;uncertain integer:=0;code text;
begin
 if p_actor is null or private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team for update;
 if s.id is null or s.actor_id is distinct from p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 for n in select video_variant_index from private.catalog_video_variants where video_set_id=p_set and state in('unknown','working') order by video_variant_index loop
  answer:=private.retry_failed_catalog_video_variant(p_set,n);
  if answer->>'kind'='retry' then retried:=retried+1;
  elsif answer->>'kind'='registered' then registered:=registered+1;
  elsif answer->>'kind'='terminal' then terminal:=terminal+1;code:=coalesce(code,answer->>'code');
  elsif answer->>'kind'='unknown' then uncertain:=uncertain+1;end if;
 end loop;
 select * into s from private.catalog_video_sets where id=p_set;
 return jsonb_build_object('retried',retried,'registered',registered,'terminal',terminal,'uncertain',uncertain,'code',code,'parentState',s.state,'snapshot',private.catalog_video_snapshot(s));
end;$$;
revoke all on function public.service_retry_failed_catalog_video_variants(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_retry_failed_catalog_video_variants(uuid,uuid,uuid) to service_role;

-- The frozen plan names the ORIGINAL child ids; a retried variant must still
-- be recognised as the same accepted set on replay.
do $accept$
declare d text;
begin
 select pg_get_functiondef('public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure) into d;
 if strpos(d,$find$where v.request_id is distinct from (child_row->>'requestId')::uuid)$find$)=0 then raise exception 'VARIANT_RETRY_ACCEPT_PATCH_MISSING';end if;
 d:=replace(d,$find$where v.request_id is distinct from (child_row->>'requestId')::uuid)$find$,$replace$where coalesce(v.original_request_id,v.request_id) is distinct from (child_row->>'requestId')::uuid)$replace$);execute d;
 select pg_get_functiondef('public.service_read_initial_catalog_ready_binding(uuid,uuid,uuid,text)'::regprocedure) into d;
 if strpos(d,$find$jsonb_agg(v.request_id::text order by v.video_variant_index)$find$)=0 then raise exception 'VARIANT_RETRY_BINDING_PATCH_MISSING';end if;
 d:=replace(d,$find$jsonb_agg(v.request_id::text order by v.video_variant_index)$find$,$replace$jsonb_agg(coalesce(v.original_request_id,v.request_id)::text order by v.video_variant_index)$replace$);execute d;
end $accept$;

-- Retired operations stay as history and may not be deleted either.
create or replace function private.guard_catalog_variant_operation_retention() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_video_variants where operation_id=old.id or (team_id=old.team_id and 'catalog-variant:'||request_id::text=old.idempotency_key))
  or exists(select 1 from private.catalog_video_variant_attempts where operation_id=old.id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return old;
end;$$;
revoke all on function private.guard_catalog_variant_operation_retention() from public,anon,authenticated,service_role;

-- A set that cannot move any more must not be retried every few minutes.
create function public.service_fail_launch_catalog_video(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_code text) returns void language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;begin
 if p_actor is null or not private.can(p_team,'edit',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or g.actor_id<>p_actor or g.state<>'running' or g.lease_owner<>p_owner or g.fence::text<>p_fence then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{1,79}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update public.team_launch_generations set state='interrupted',safe_error_code=p_code,retryable=false,lease_owner=null,lease_expires_at=clock_timestamp(),next_attempt_at=null,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
end $$;
revoke all on function public.service_fail_launch_catalog_video(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.service_fail_launch_catalog_video(uuid,uuid,uuid,text,text,text) to service_role;
commit;
