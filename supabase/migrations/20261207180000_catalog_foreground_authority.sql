-- Explicit user-started N work. No global delegation or recovery job is created.
begin;
create table private.catalog_video_foreground_authorities(
 enrollment_id uuid primary key,video_set_id uuid unique references private.catalog_video_sets(id),
 team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),session_id uuid not null,
 source_material_id uuid not null,source_version text,settings_digest text,
 consumer_kind text not null check(consumer_kind in('create','launch','updater')),
 original_key text not null check(length(original_key)between 1 and 200),expected_version text,
 canonical_key text,original_request_id uuid,planned_set_id uuid,admitted_at timestamptz,native_instance_id uuid not null,execution_native_instance_id uuid not null,
 proof_hash bytea not null check(octet_length(proof_hash)=32),token_hash bytea not null unique check(octet_length(token_hash)=32),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 challenge_until timestamptz,expires_at timestamptz not null,redeemed_at timestamptz,
 unused_at timestamptz,
 safe_error_code text references public.team_error_codes(code),
 foreign key(source_material_id,team_id)references public.team_materials(id,team_id),
 check((video_set_id is null and source_version is null and settings_digest is null and challenge_until is null and redeemed_at is null)or(video_set_id is not null and canonical_key is not null and original_request_id is not null and source_version is not null and settings_digest is not null and challenge_until is not null))
);
alter table private.catalog_video_foreground_authorities enable row level security;
alter table private.catalog_video_foreground_authorities force row level security;
revoke all on private.catalog_video_foreground_authorities from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_foreground_authorities for each row execute function private.guard_task_cleanup_reference();

create function public.service_prepare_catalog_video_foreground(p_team uuid,p_actor uuid,p_session uuid,p_source uuid,p_kind text,p_key text,p_version text,p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_token_hash bytea)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;expiry timestamptz;
begin
 if p_kind not in('create','launch','updater')or p_key is null or length(p_key)not between 1 and 200 or p_enrollment is null or p_native is null or octet_length(p_proof_hash)is distinct from 32 or octet_length(p_token_hash)is distinct from 32 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment for update;
 if f.video_set_id is not null then
  if(f.team_id,f.actor_id,f.source_material_id,f.consumer_kind,f.original_key,f.expected_version,f.native_instance_id,f.proof_hash)is distinct from(p_team,p_actor,p_source,p_kind,p_key,p_version,p_native,p_proof_hash)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
  -- Canonical read replay only: never replace the original session/hash or grant new I/O.
  return jsonb_build_object('enrollmentId',f.enrollment_id,'setId',f.video_set_id,'executorId',f.enrollment_id,'nativeInstanceId',f.native_instance_id,'expiresAt',f.expires_at);
 end if;
 perform private.require_restitch_control_session(p_session,p_actor);
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'download',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or not exists(select 1 from public.team_materials where id=p_source and team_id=p_team and lifecycle='active'and category='video')then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment for update;
 if f.enrollment_id is not null then
  if(f.team_id,f.actor_id,f.session_id,f.source_material_id,f.consumer_kind,f.original_key,f.expected_version,f.native_instance_id,f.proof_hash,f.token_hash)is distinct from(p_team,p_actor,p_session,p_source,p_kind,p_key,p_version,p_native,p_proof_hash,p_token_hash)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
  if f.unused_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if f.expires_at<=clock_timestamp()then raise exception 'EXPIRED'using errcode='55000';end if;
 else
  select least(clock_timestamp()+interval '24 hours',coalesce((to_jsonb(s)->>'not_after')::timestamptz,clock_timestamp()+interval '24 hours'))into expiry from auth.sessions s where s.id=p_session and s.user_id=p_actor;
  insert into private.catalog_video_foreground_authorities(enrollment_id,team_id,actor_id,session_id,source_material_id,consumer_kind,original_key,expected_version,native_instance_id,execution_native_instance_id,proof_hash,token_hash,expires_at)values(p_enrollment,p_team,p_actor,p_session,p_source,p_kind,p_key,p_version,p_native,p_native,p_proof_hash,p_token_hash,expiry)returning*into f;
 end if;
 return jsonb_build_object('enrollmentId',f.enrollment_id,'setId',f.video_set_id,'executorId',f.enrollment_id,'nativeInstanceId',f.native_instance_id,'expiresAt',f.expires_at);
end $$;
create function public.service_catalog_video_foreground_context(p_team uuid,p_actor uuid,p_source uuid,p_enrollment uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;context jsonb;
begin
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment and team_id=p_team and actor_id=p_actor and source_material_id=p_source;
 if f.enrollment_id is null or f.unused_at is not null or f.expires_at<=clock_timestamp()then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 perform private.require_restitch_control_session(f.session_id,p_actor);
 if private.can(p_team,'download',p_actor)is not true or private.can(p_team,'process',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 context:=public.service_initial_catalog_video_context(p_team,p_actor,p_source,null,false);
 return context||jsonb_build_object('executorId',f.enrollment_id,'foregroundEnrollmentId',f.enrollment_id);
end $$;
create function public.service_accept_foreground_catalog_video_set(p_team uuid,p_actor uuid,p_enrollment uuid,p_payload jsonb,p_children jsonb,p_assignments jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;s private.catalog_video_sets%rowtype;i private.catalog_generation_intents%rowtype;a public.team_catalog_update_attempts%rowtype;result jsonb;owner_key text;owner_id uuid;
begin
 -- Same parent -> set -> authority order as all set admission/cancel paths.
 if p_payload->>'catalogIntentId'is not null then
  select *into i from private.catalog_generation_intents where id=(p_payload->>'catalogIntentId')::uuid and team_id=p_team and actor_id=p_actor for update;
  if i.id is null then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;owner_key:=i.request_key;owner_id:=i.id;
 else
  select *into a from public.team_catalog_update_attempts where attempt_id=(p_payload->>'updateAttemptId')::uuid and team_id=p_team for update;
  if a.attempt_id is null then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;owner_key:=a.attempt_id::text;owner_id:=a.attempt_id;
 end if;
 perform public.service_catalog_video_foreground_context(p_team,p_actor,(p_payload->>'sourceMaterialId')::uuid,p_enrollment);
 result:=public.service_accept_catalog_video_set_before_foreground(p_team,p_actor,p_enrollment,p_payload,p_children,p_assignments);
 select *into s from private.catalog_video_sets where id=(p_payload->>'setId')::uuid for update;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment for update;
 if f.enrollment_id is null or s.executor_id is distinct from p_enrollment or f.source_material_id is distinct from s.source_material_id or f.native_instance_id is null or(f.video_set_id is not null and(f.video_set_id,f.canonical_key,f.original_request_id,f.source_version,f.settings_digest)is distinct from(s.id,owner_key,owner_id,s.source_version,s.settings_digest))then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.consumer_kind='create'and (i.id is null or f.original_key<>i.request_key)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.consumer_kind='launch'and (i.id is null or not exists(select 1 from public.team_launch_generations generation where generation.team_id=p_team and generation.actor_id=p_actor and i.request_key='launch:'||generation.id::text||':catalog' and generation.request_key=f.original_key and generation.input_version=f.expected_version))then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.consumer_kind='updater'and not exists(select 1 from private.catalog_updater_variant_requests r where r.attempt_id=a.attempt_id and r.request_id::text=f.original_key and r.actor_id=f.actor_id and r.profile_version-1=f.expected_version::bigint)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if i.id is not null and i.request_payload#>>'{foregroundExecutor,enrollmentId}'is distinct from p_enrollment::text then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.video_set_id is null then
  update private.catalog_video_foreground_authorities set video_set_id=s.id,canonical_key=owner_key,original_request_id=owner_id,source_version=s.source_version,settings_digest=s.settings_digest,challenge_until=least(expires_at,clock_timestamp()+interval '2 minutes'),updated_at=clock_timestamp(),safe_error_code=null where enrollment_id=f.enrollment_id;
  update private.catalog_video_sets set native_instance_id=f.execution_native_instance_id where id=s.id;
 end if;
 return result;
end $$;
create function private.require_catalog_video_foreground(p_set uuid,p_hash bytea,p_native uuid,p_live boolean)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;s private.catalog_video_sets%rowtype;
begin
 select *into f from private.catalog_video_foreground_authorities where video_set_id=p_set;
 select *into s from private.catalog_video_sets where id=p_set;
 if f.enrollment_id is null or f.token_hash is distinct from p_hash or f.redeemed_at is null or s.id is null or s.executor_id is distinct from f.enrollment_id or s.native_instance_id is distinct from p_native or f.execution_native_instance_id is distinct from p_native or(s.team_id,s.actor_id,s.source_material_id,s.source_version,s.settings_digest)is distinct from(f.team_id,f.actor_id,f.source_material_id,f.source_version,f.settings_digest)then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 if p_live then
  if f.unused_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if f.expires_at<=clock_timestamp()then raise exception 'EXPIRED'using errcode='55000';end if;
  perform private.require_restitch_control_session(f.session_id,f.actor_id);
  if private.can(s.team_id,'view',s.actor_id)is not true or private.can(s.team_id,'process',s.actor_id)is not true or private.can(s.team_id,'upload',s.actor_id)is not true or private.can(s.team_id,'download',s.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
  if s.workspace_epoch is distinct from(select coalesce(max(epoch),0)from private.workspace_pauses where team_id=s.team_id)then raise exception 'WRONG_STATE'using errcode='55000';end if;
 end if;
 return jsonb_build_object('setId',s.id,'teamId',s.team_id,'actorId',s.actor_id,'executorId',f.enrollment_id,'epoch',s.epoch,'nativeInstanceId',s.native_instance_id,'delegationVersion',null,'executionMode','paired_session');
end $$;
revoke all on function private.require_catalog_video_foreground(uuid,bytea,uuid,boolean)from public,anon,authenticated,service_role;
create function public.service_redeem_catalog_video_foreground(p_set uuid,p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_execution_native uuid default null,p_expected_execution_native uuid default null)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;s private.catalog_video_sets%rowtype;
begin
 select *into s from private.catalog_video_sets where id=p_set for update;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment for update;
 if f.enrollment_id is null or f.video_set_id is distinct from p_set or f.native_instance_id is distinct from p_native or f.proof_hash is distinct from p_proof_hash or s.executor_id is distinct from p_enrollment then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 perform private.require_restitch_control_session(f.session_id,f.actor_id);
 if f.expires_at<=clock_timestamp()or(f.redeemed_at is null and f.challenge_until<=clock_timestamp())then raise exception 'EXPIRED'using errcode='55000';end if;
 if private.can(f.team_id,'process',f.actor_id)is not true or private.can(f.team_id,'upload',f.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if p_execution_native is not null and p_execution_native<>f.execution_native_instance_id then
  if f.execution_native_instance_id is distinct from coalesce(p_expected_execution_native,p_native)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
  if s.state not in('accepted','preparing','unknown')or s.workspace_epoch is distinct from(select coalesce(max(epoch),0)from private.workspace_pauses where team_id=s.team_id)or exists(select 1 from private.catalog_video_variants v where v.video_set_id=s.id and(v.state not in('queued','registered')or(v.state='queued'and exists(select 1 from public.team_operations operation where operation.team_id=s.team_id and operation.actor_id=s.actor_id and operation.idempotency_key='catalog-variant:'||v.request_id::text and(exists(select 1 from private.team_recovery_execution_fences fence where fence.operation_id=operation.id)or exists(select 1 from private.process_upload_ownership ownership where ownership.operation_id=operation.id))))))then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
  update private.catalog_video_foreground_authorities set execution_native_instance_id=p_execution_native,updated_at=clock_timestamp()where enrollment_id=f.enrollment_id returning*into f;
  update private.catalog_video_sets set native_instance_id=p_execution_native,epoch=epoch+1,revision=revision+1,state='preparing',updated_at=clock_timestamp()where id=s.id returning*into s;
 end if;
 if f.redeemed_at is null then update private.catalog_video_foreground_authorities set redeemed_at=clock_timestamp(),updated_at=clock_timestamp(),safe_error_code=null where enrollment_id=f.enrollment_id returning*into f;end if;
 return jsonb_build_object('protocolVersion',1,'setId',f.video_set_id,'executorId',f.enrollment_id,'enrollmentId',f.enrollment_id,'nativeInstanceId',f.native_instance_id,'executionNativeInstanceId',f.execution_native_instance_id,'teamId',f.team_id,'actorId',f.actor_id,'sourceMaterialId',f.source_material_id,'requestKey',f.original_key,'expectedVersion',f.expected_version,'expiresAt',f.expires_at,'_ticketScope',jsonb_build_object('enrollmentId',f.enrollment_id,'teamId',f.team_id,'actorId',f.actor_id,'sessionId',f.session_id,'sourceMaterialId',f.source_material_id,'consumerKind',f.consumer_kind,'requestKey',f.original_key,'expectedVersion',f.expected_version,'nativeInstanceId',f.native_instance_id,'proofDigest',encode(f.proof_hash,'hex')));
end $$;
create function public.service_record_catalog_video_foreground_failure(p_enrollment uuid,p_team uuid,p_actor uuid,p_code text)returns boolean language plpgsql security definer set search_path=''as $$
begin
 if not exists(select 1 from public.team_error_codes where code=p_code)then p_code:='PROCESS_RESULT_UNCERTAIN';end if;
 update private.catalog_video_foreground_authorities set safe_error_code=p_code,updated_at=clock_timestamp()where enrollment_id=p_enrollment and team_id=p_team and actor_id=p_actor;return found;
end $$;
revoke all on function public.service_prepare_catalog_video_foreground(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,bytea,bytea),public.service_catalog_video_foreground_context(uuid,uuid,uuid,uuid),public.service_accept_foreground_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid),public.service_record_catalog_video_foreground_failure(uuid,uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.service_prepare_catalog_video_foreground(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,bytea,bytea),public.service_catalog_video_foreground_context(uuid,uuid,uuid,uuid),public.service_accept_foreground_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb),public.service_redeem_catalog_video_foreground(uuid,uuid,uuid,bytea,uuid,uuid),public.service_record_catalog_video_foreground_failure(uuid,uuid,uuid,text)to service_role;
alter table private.restitch_process_aliases add column auth_mode text not null default 'recovery'check(auth_mode in('recovery','paired_session')),add column foreground_enrollment_id uuid references private.catalog_video_foreground_authorities(enrollment_id);
alter table private.restitch_process_aliases alter column recovery_delegation_id drop not null,alter column recovery_delegation_version drop not null;
alter table private.restitch_process_aliases add constraint restitch_process_alias_authority check((auth_mode='recovery'and foreground_enrollment_id is null and recovery_delegation_id is not null and recovery_delegation_version is not null)or(auth_mode='paired_session'and foreground_enrollment_id is not null and recovery_delegation_id is null and recovery_delegation_version is null));
alter table private.restitch_native_controls drop constraint restitch_control_auth_mode;
alter table private.restitch_native_controls add constraint restitch_control_auth_mode check((auth_mode='browser_session'and session_id is not null and process_alias_id is null)or(auth_mode='catalog_process'and session_id is null and process_alias_id=root_operation_id)or(auth_mode='catalog_browser_session'and session_id is not null and process_alias_id=root_operation_id));

alter table private.catalog_video_variants add column dispatch_native_instance_id uuid;

-- Transform only exact existing protected primitives; no older migration changes.
do $patch$
declare d text;
begin
 select pg_get_functiondef('public.service_authorize_catalog_video_executor(uuid,bytea,uuid,integer)'::regprocedure)into d;
 if strpos(d,'authority:=public.service_team_recovery')=0 then raise exception 'FOREGROUND_AUTHORITY_PATCH_MISSING';end if;
 d:=replace(d,'authority:=public.service_team_recovery',E'if exists(select 1 from private.catalog_video_foreground_authorities where video_set_id=p_set)then\n perform 1 from private.catalog_video_sets where id=p_set for update;\n return private.require_catalog_video_foreground(p_set,p_hash,p_native,true);\n end if;\n authority:=public.service_team_recovery');execute d;
 select pg_get_functiondef('public.service_claim_catalog_video_set(bytea,uuid,integer)'::regprocedure)into d;
 if strpos(d,'order by created_at,id for update')=0 then raise exception 'FOREGROUND_CLAIM_PATCH_MISSING';end if;
 d:=replace(d,'order by created_at,id for update','and not exists(select 1 from private.catalog_video_foreground_authorities fg where fg.video_set_id=catalog_video_sets.id)order by created_at,id for update');execute d;
 select pg_get_functiondef('public.service_accept_catalog_video_restitch_alias(uuid,bytea,uuid,integer,integer,uuid,uuid)'::regprocedure)into d;
 d:=replace(d,'workspace_epoch,recovery_delegation_id,recovery_delegation_version)','workspace_epoch,recovery_delegation_id,recovery_delegation_version,auth_mode,foreground_enrollment_id)');
 if strpos(d,'s.recovery_delegation_id,s.recovery_delegation_version);')=0 then raise exception 'FOREGROUND_ALIAS_PATCH_MISSING';end if;
 d:=replace(d,'s.recovery_delegation_id,s.recovery_delegation_version);','s.recovery_delegation_id,s.recovery_delegation_version,case when exists(select 1 from private.catalog_video_foreground_authorities fg where fg.video_set_id=s.id)then ''paired_session''else ''recovery''end,(select fg.enrollment_id from private.catalog_video_foreground_authorities fg where fg.video_set_id=s.id));');execute d;
 select pg_get_functiondef('private.require_catalog_restitch_alias(uuid,uuid,uuid,uuid,boolean)'::regprocedure)into d;
 if strpos(d,'if not exists(select 1 from private.team_recovery_delegations d')=0 then raise exception 'FOREGROUND_ALIAS_LIVE_PATCH_MISSING';end if;
 d:=replace(d,'if not exists(select 1 from private.team_recovery_delegations d',E'if a.auth_mode=''paired_session''then\n perform private.require_catalog_video_foreground(a.video_set_id,(select fg.token_hash from private.catalog_video_foreground_authorities fg where fg.enrollment_id=a.foreground_enrollment_id),a.native_instance_id,true);return a;\n end if;\n if not exists(select 1 from private.team_recovery_delegations d');execute d;
 select pg_get_functiondef('private.require_restitch_control_auth(private.restitch_native_controls,boolean)'::regprocedure)into d;
 if strpos(d,'if g.auth_mode=''browser_session'' then')=0 then raise exception 'FOREGROUND_CONTROL_PATCH_MISSING';end if;
 d:=replace(d,'if g.auth_mode=''browser_session'' then',E'if g.auth_mode=''catalog_browser_session''then\n if not exists(select 1 from private.restitch_process_aliases a join private.catalog_video_foreground_authorities f on f.enrollment_id=a.foreground_enrollment_id and f.video_set_id=a.video_set_id join public.team_operations o on o.id=a.root_operation_id where a.root_operation_id=g.root_operation_id and a.auth_mode=''paired_session''and a.team_id=g.team_id and a.actor_id=g.actor_id and f.session_id=g.session_id and a.native_instance_id=g.native_instance_id and o.kind=''process''and g.process_alias_id=g.root_operation_id)then raise exception ''AUTH_REQUIRED''using errcode=''42501'';end if;\n perform private.require_catalog_restitch_alias(g.root_operation_id,g.team_id,g.actor_id,g.native_instance_id,p_live);return;\n end if;\n if g.auth_mode=''browser_session'' then');execute d;
 select pg_get_functiondef('public.service_issue_catalog_video_restitch_control(uuid,bytea,uuid,integer,integer,uuid,uuid,uuid,uuid,bytea,bytea)'::regprocedure)into d;
 d:=replace(d,'t timestamptz;expiry timestamptz;','t timestamptz;expiry timestamptz;control_session uuid;control_mode text;');
 if strpos(d,'select * into g from private.restitch_native_controls where id=p_grant')=0 then raise exception 'FOREGROUND_CONTROL_ISSUE_PATCH_MISSING';end if;
 d:=replace(d,'select * into g from private.restitch_native_controls where id=p_grant',E'control_mode:=case when a.auth_mode=''paired_session''then ''catalog_browser_session''else ''catalog_process''end;\n select session_id into control_session from private.catalog_video_foreground_authorities where enrollment_id=a.foreground_enrollment_id;\n select * into g from private.restitch_native_controls where id=p_grant');
 d:=replace(d,'g.auth_mode,g.process_alias_id)','g.auth_mode,g.process_alias_id,g.session_id)');
 d:=replace(d,'''catalog_process''::text,p_operation)','control_mode,p_operation,control_session)');
 d:=replace(d,$old$select least(expires_at,t+interval '24 hours') into expiry from private.team_recovery_delegations where id=a.recovery_delegation_id;$old$,E'if a.auth_mode=''paired_session''then select least(expires_at,t+interval ''24 hours'')into expiry from private.catalog_video_foreground_authorities where enrollment_id=a.foreground_enrollment_id;else\n select least(expires_at,t+interval ''24 hours'') into expiry from private.team_recovery_delegations where id=a.recovery_delegation_id;end if;');
 d:=replace(d,'a.actor_id,null,p_enrollment','a.actor_id,control_session,p_enrollment');
 d:=replace(d,'''catalog_process'',p_operation)','control_mode,p_operation)');execute d;
 select pg_get_functiondef('public.service_dispatch_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid)'::regprocedure)into d;
 if strpos(d,'set dispatch_credential_hash=p_hash')=0 then raise exception 'FOREGROUND_DISPATCH_AUDIENCE_PATCH_MISSING';end if;
 d:=replace(d,'set dispatch_credential_hash=p_hash','set dispatch_credential_hash=p_hash,dispatch_native_instance_id=p_native');execute d;
 select pg_get_functiondef('public.service_complete_catalog_video_variant(uuid,bytea,uuid,integer,integer,uuid,uuid,text,text)'::regprocedure)into d;
 if strpos(d,'s.recovery_delegation_id is null or s.recovery_delegation_version is null')=0 then raise exception 'FOREGROUND_CLOSURE_PATCH_MISSING';end if;
 d:=replace(d,'s.native_instance_id is distinct from p_native','coalesce(v.dispatch_native_instance_id,s.native_instance_id) is distinct from p_native');
 d:=replace(d,'s.recovery_delegation_id is null or s.recovery_delegation_version is null','((s.recovery_delegation_id is null or s.recovery_delegation_version is null)and not exists(select 1 from private.catalog_video_foreground_authorities fg where fg.video_set_id=s.id and fg.enrollment_id=s.executor_id and fg.token_hash=p_hash and fg.redeemed_at is not null))');execute d;
end $patch$;

create view public.analytics_catalog_video_session_authorities with(security_barrier=true)as
 select f.enrollment_id authority_id,f.video_set_id set_id,f.team_id,f.actor_id,f.consumer_kind,f.original_request_id,
 (select g.launch_id from public.team_launch_generations g where f.consumer_kind='launch'and f.team_id=g.team_id and f.actor_id=g.actor_id and g.request_key=f.original_key limit 1)launch_id,
 coalesce((select r.catalog_material_id from private.catalog_updater_variant_requests r where r.attempt_id=f.original_request_id and r.team_id=f.team_id),(select nullif(i.result#>>'{catalog,materialId}','')::uuid from private.catalog_generation_intents i where i.id=f.original_request_id and i.team_id=f.team_id))catalog_material_id,
 case when f.unused_at is not null then 'canceled' when s.state='ready'then 'ready'when s.state='canceled'then 'canceled'when s.state='cancel_requested'then 'cancel_requested'when f.expires_at<=clock_timestamp()then 'expired'when not exists(select 1 from auth.sessions session where session.id=f.session_id and session.user_id=f.actor_id and(to_jsonb(session)->>'not_after'is null or(to_jsonb(session)->>'not_after')::timestamptz>clock_timestamp()))then 'session_revoked'when s.state='unknown'then 'unknown'when f.video_set_id is null and f.original_request_id is not null then 'accepted_unbound'when f.video_set_id is null then 'prepared'when f.redeemed_at is null then 'accepted'else 'redeemed'end state,
 exists(select 1 from auth.sessions session where session.id=f.session_id and session.user_id=f.actor_id and(to_jsonb(session)->>'not_after'is null or(to_jsonb(session)->>'not_after')::timestamptz>clock_timestamp()))session_valid,
 f.redeemed_at,f.expires_at,f.created_at,f.updated_at,f.safe_error_code
 from private.catalog_video_foreground_authorities f left join private.catalog_video_sets s on s.id=f.video_set_id;
revoke all on public.analytics_catalog_video_session_authorities from public,anon,authenticated;
grant select on public.analytics_catalog_video_session_authorities to service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_catalog_video_session_authorities to wishly_analytics_ro;end if;end$$;

create function public.service_await_catalog_video_foreground(p_enrollment uuid,p_native uuid,p_proof_hash bytea,p_execution_native uuid default null,p_expected_execution_native uuid default null)returns jsonb language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;
begin
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment;
 if f.enrollment_id is null then return jsonb_build_object('state','pending','enrollmentId',p_enrollment);end if;
 if f.native_instance_id is distinct from p_native or f.proof_hash is distinct from p_proof_hash then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 if f.unused_at is not null then return jsonb_build_object('state','unused','enrollmentId',f.enrollment_id);end if;
 perform private.require_restitch_control_session(f.session_id,f.actor_id);
 if f.unused_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if f.expires_at<=clock_timestamp()then raise exception 'EXPIRED'using errcode='55000';end if;
 if f.safe_error_code is not null and f.video_set_id is null then raise exception '%',f.safe_error_code using errcode='55000';end if;
 if f.video_set_id is null then return jsonb_build_object('state','pending','enrollmentId',f.enrollment_id,'teamId',f.team_id,'actorId',f.actor_id,'sourceMaterialId',f.source_material_id,'requestKey',f.original_key,'expectedVersion',f.expected_version);end if;
 return public.service_redeem_catalog_video_foreground(f.video_set_id,p_enrollment,p_native,p_proof_hash,p_execution_native,p_expected_execution_native)||jsonb_build_object('state','bound');
end $$;
revoke all on function public.service_await_catalog_video_foreground(uuid,uuid,bytea,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_await_catalog_video_foreground(uuid,uuid,bytea,uuid,uuid)to service_role;

create function public.service_require_catalog_video_audience(p_set uuid,p_hash bytea,p_kind text,p_enrollment uuid default null)returns boolean language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;
begin
 select *into f from private.catalog_video_foreground_authorities where video_set_id=p_set;
 if p_kind='recovery'then if f.enrollment_id is not null then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;return true;end if;
 if p_kind is distinct from 'paired_session'or f.enrollment_id is null or f.enrollment_id is distinct from p_enrollment or f.token_hash is distinct from p_hash or f.redeemed_at is null then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 return true;
end $$;
revoke all on function public.service_require_catalog_video_audience(uuid,bytea,text,uuid)from public,anon,authenticated;
grant execute on function public.service_require_catalog_video_audience(uuid,bytea,text,uuid)to service_role;

create function private.catalog_video_public_executor(p_set uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('mode','paired_session','enrollmentId',enrollment_id,'nativeInstanceId',native_instance_id)from private.catalog_video_foreground_authorities where video_set_id=p_set
$$;
revoke all on function private.catalog_video_public_executor(uuid)from public,anon,authenticated,service_role;
do $progress$
declare d text;
begin
 select pg_get_functiondef('private.catalog_initial_video_progress(uuid,text,boolean)'::regprocedure)into d;
 if strpos(d,$find$'providerCas','unsupported')$find$)=0 then raise exception 'FOREGROUND_PROGRESS_PATCH_MISSING';end if;
 d:=replace(d,$find$'providerCas','unsupported')$find$,$replace$'providerCas','unsupported')||case when private.catalog_video_public_executor(s.id)is null then '{}'::jsonb else jsonb_build_object('executor',private.catalog_video_public_executor(s.id))end$replace$);execute d;
end $progress$;

create function public.service_catalog_video_public_executor(p_set uuid,p_team uuid,p_actor uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
begin
 if private.can(p_team,'view',p_actor)is not true or not exists(select 1 from private.catalog_video_sets where id=p_set and team_id=p_team and actor_id=p_actor)then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 return private.catalog_video_public_executor(p_set);
end $$;
revoke all on function public.service_catalog_video_public_executor(uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_catalog_video_public_executor(uuid,uuid,uuid)to service_role;
alter function public.service_read_initial_catalog_video(uuid,uuid,text)rename to service_read_initial_catalog_video_before_foreground;
revoke all on function public.service_read_initial_catalog_video_before_foreground(uuid,uuid,text)from public,anon,authenticated,service_role;
create function public.service_read_initial_catalog_video(p_team uuid,p_actor uuid,p_key text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;descriptor jsonb;
begin
 result:=public.service_read_initial_catalog_video_before_foreground(p_team,p_actor,p_key);
 if result->>'outcome'='preparing_video'then descriptor:=private.catalog_video_public_executor((result->>'videoSetId')::uuid);if descriptor is not null then result:=result||jsonb_build_object('executor',descriptor);end if;end if;
 return result;
end $$;
revoke all on function public.service_read_initial_catalog_video(uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.service_read_initial_catalog_video(uuid,uuid,text)to service_role;

create function public.service_note_catalog_video_foreground_intent(p_enrollment uuid,p_team uuid,p_actor uuid,p_intent uuid,p_planned_set uuid)returns boolean language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;i private.catalog_generation_intents%rowtype;
begin
 select *into i from private.catalog_generation_intents where id=p_intent and team_id=p_team and actor_id=p_actor for update;
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment and team_id=p_team and actor_id=p_actor for update;
 if i.id is null or f.enrollment_id is null or i.video_material_id is distinct from f.source_material_id or i.request_payload#>>'{foregroundExecutor,enrollmentId}'is distinct from p_enrollment::text or i.checkpoint#>>'{initialVideoPlan,setId}'is distinct from p_planned_set::text then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 perform private.require_restitch_control_session(f.session_id,f.actor_id);
 if f.unused_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if f.expires_at<=clock_timestamp()then raise exception 'EXPIRED'using errcode='55000';end if;
 if f.consumer_kind='create'and f.original_key<>i.request_key then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.consumer_kind='launch'and not exists(select 1 from private.launch_catalog_video_contexts context join public.team_launch_generations generation on generation.id=context.generation_id and generation.team_id=f.team_id and generation.actor_id=f.actor_id where context.catalog_intent_id=i.id and generation.request_key=f.original_key)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 if f.original_request_id is not null and(f.original_request_id,f.canonical_key,f.planned_set_id)is distinct from(i.id,i.request_key,p_planned_set)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 update private.catalog_video_foreground_authorities set original_request_id=i.id,canonical_key=i.request_key,planned_set_id=p_planned_set,admitted_at=coalesce(admitted_at,clock_timestamp()),updated_at=clock_timestamp()where enrollment_id=f.enrollment_id;return true;
end $$;
revoke all on function public.service_note_catalog_video_foreground_intent(uuid,uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_note_catalog_video_foreground_intent(uuid,uuid,uuid,uuid,uuid)to service_role;
-- A trusted known no-work result retires only its exact still-unbound enrollment.
-- Retained tombstone prevents a delayed browser POST from admitting this proof later.
create function public.service_retire_unused_catalog_video_foreground(p_enrollment uuid,p_team uuid,p_actor uuid)returns boolean language plpgsql security definer set search_path=''as $$
declare f private.catalog_video_foreground_authorities%rowtype;
begin
 select *into f from private.catalog_video_foreground_authorities where enrollment_id=p_enrollment and team_id=p_team and actor_id=p_actor for update;
 if f.enrollment_id is null then raise exception 'AUTH_REQUIRED'using errcode='42501';end if;
 if f.video_set_id is not null or f.planned_set_id is not null or f.admitted_at is not null then return false;end if;
 update private.catalog_video_foreground_authorities set unused_at=coalesce(unused_at,clock_timestamp()),safe_error_code='ALREADY_COMPLETED',updated_at=clock_timestamp()where enrollment_id=f.enrollment_id;
 return true;
end $$;
revoke all on function public.service_retire_unused_catalog_video_foreground(uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_retire_unused_catalog_video_foreground(uuid,uuid,uuid)to service_role;
-- All existing canonical callers retain the same API, with a closed auth union.
alter function public.service_initial_catalog_video_context(uuid,uuid,uuid,uuid,boolean)rename to service_initial_catalog_video_context_before_foreground;
revoke all on function public.service_initial_catalog_video_context_before_foreground(uuid,uuid,uuid,uuid,boolean)from public,anon,authenticated,service_role;
do $missing_executor$
declare d text;
begin
 select pg_get_functiondef('public.service_initial_catalog_video_context_before_foreground(uuid,uuid,uuid,uuid,boolean)'::regprocedure)into d;
 if strpos(d,$find$if p_require_executor is not false and executor is null then raise exception 'PERMISSION_DENIED'$find$)=0 then raise exception 'FOREGROUND_AGENT_REQUIRED_PATCH_MISSING';end if;
 d:=replace(d,$find$if p_require_executor is not false and executor is null then raise exception 'PERMISSION_DENIED'$find$,$replace$if p_require_executor is not false and executor is null then raise exception 'AGENT_REQUIRED'$replace$);execute d;
end $missing_executor$;
create function public.service_initial_catalog_video_context(p_team uuid,p_actor uuid,p_source uuid,p_executor uuid default null,p_require_executor boolean default true)returns jsonb language plpgsql security definer set search_path=''as $$
begin
 if p_require_executor and exists(select 1 from private.catalog_video_foreground_authorities where enrollment_id=p_executor)then return public.service_catalog_video_foreground_context(p_team,p_actor,p_source,p_executor);end if;
 return public.service_initial_catalog_video_context_before_foreground(p_team,p_actor,p_source,p_executor,p_require_executor);
end $$;
revoke all on function public.service_initial_catalog_video_context(uuid,uuid,uuid,uuid,boolean)from public,anon,authenticated;
grant execute on function public.service_initial_catalog_video_context(uuid,uuid,uuid,uuid,boolean)to service_role;
alter function public.service_accept_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb)rename to service_accept_catalog_video_set_before_foreground;
revoke all on function public.service_accept_catalog_video_set_before_foreground(uuid,uuid,uuid,jsonb,jsonb,jsonb)from public,anon,authenticated,service_role;
create function public.service_accept_catalog_video_set(p_team uuid,p_actor uuid,p_executor uuid,p_payload jsonb,p_children jsonb,p_assignments jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
begin
 if exists(select 1 from private.catalog_video_foreground_authorities where enrollment_id=p_executor)then return public.service_accept_foreground_catalog_video_set(p_team,p_actor,p_executor,p_payload,p_children,p_assignments);end if;
 return public.service_accept_catalog_video_set_before_foreground(p_team,p_actor,p_executor,p_payload,p_children,p_assignments);
end $$;
revoke all on function public.service_accept_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb)from public,anon,authenticated;
grant execute on function public.service_accept_catalog_video_set(uuid,uuid,uuid,jsonb,jsonb,jsonb)to service_role;
do $launch_foreground$
declare d text;
begin
 select pg_get_functiondef('public.service_accept_launch_catalog_video_generation(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure)into d;
 if strpos(d,'preferences->>''expectedExecutorId'' is distinct from executor::text')=0 then raise exception 'FOREGROUND_LAUNCH_EXECUTOR_PATCH_MISSING';end if;
 d:=replace(d,'preferences->>''expectedExecutorId'' is distinct from executor::text','coalesce(preferences#>>''{foregroundExecutor,enrollmentId}'',preferences->>''expectedExecutorId'') is distinct from executor::text');execute d;
end $launch_foreground$;
create function public.service_catalog_foreground_updater_scope(p_team uuid,p_actor uuid,p_catalog uuid,p_version bigint)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare source_id uuid;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select c.video_material_id into source_id from public.team_product_catalogs c join public.team_catalog_update_profiles p on p.catalog_material_id=c.material_id and p.team_id=c.team_id where c.material_id=p_catalog and c.team_id=p_team and p.version=p_version;
 if source_id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return jsonb_build_object('sourceMaterialId',source_id);
end $$;
revoke all on function public.service_catalog_foreground_updater_scope(uuid,uuid,uuid,bigint)from public,anon,authenticated;
grant execute on function public.service_catalog_foreground_updater_scope(uuid,uuid,uuid,bigint)to service_role;
create function private.guard_catalog_foreground_immutable()returns trigger language plpgsql set search_path=''as $$
begin
 if (new.enrollment_id,new.team_id,new.actor_id,new.session_id,new.source_material_id,new.consumer_kind,new.original_key,new.expected_version,new.native_instance_id,new.proof_hash,new.token_hash,new.created_at,new.expires_at)is distinct from(old.enrollment_id,old.team_id,old.actor_id,old.session_id,old.source_material_id,old.consumer_kind,old.original_key,old.expected_version,old.native_instance_id,old.proof_hash,old.token_hash,old.created_at,old.expires_at)or(old.video_set_id is not null and(new.video_set_id,new.source_version,new.settings_digest,new.canonical_key,new.original_request_id)is distinct from(old.video_set_id,old.source_version,old.settings_digest,old.canonical_key,old.original_request_id))or(old.unused_at is not null and new.unused_at is distinct from old.unused_at)then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 return new;
end $$;
revoke all on function private.guard_catalog_foreground_immutable()from public,anon,authenticated,service_role;
create trigger catalog_foreground_immutable before update on private.catalog_video_foreground_authorities for each row execute function private.guard_catalog_foreground_immutable();
create function public.service_launch_catalog_foreground_source(p_team uuid,p_actor uuid,p_generation uuid,p_key text,p_version text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare source_id uuid;
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select (r.config->>'materialId')::uuid into source_id from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id where g.id=p_generation and g.team_id=p_team and g.actor_id=p_actor and g.request_key=p_key and g.input_version=p_version and r.config->>'method'='catalog';
 if source_id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return jsonb_build_object('sourceMaterialId',source_id);
end $$;
revoke all on function public.service_launch_catalog_foreground_source(uuid,uuid,uuid,text,text)from public,anon,authenticated;
grant execute on function public.service_launch_catalog_foreground_source(uuid,uuid,uuid,text,text)to service_role;
alter function public.service_read_catalog_updater_variants(uuid,uuid,uuid,uuid)rename to service_read_catalog_updater_variants_before_foreground;
revoke all on function public.service_read_catalog_updater_variants_before_foreground(uuid,uuid,uuid,uuid)from public,anon,authenticated,service_role;
create function public.service_read_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid default null)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;descriptor jsonb;
begin
 result:=public.service_read_catalog_updater_variants_before_foreground(p_team,p_actor,p_catalog,p_request);
 if result is null then return null;end if;
 descriptor:=private.catalog_video_public_executor((result->>'setId')::uuid);
 return result||case when descriptor is null then '{}'::jsonb else jsonb_build_object('executor',descriptor)end;
end $$;
revoke all on function public.service_read_catalog_updater_variants(uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_read_catalog_updater_variants(uuid,uuid,uuid,uuid)to service_role;
do $launch_progress$
declare d text;
begin
 select pg_get_functiondef('public.get_launch(uuid,uuid,uuid)'::regprocedure)into d;
 if strpos(d,$find$'setId',s.id,'requestedCount'$find$)=0 then raise exception 'FOREGROUND_LAUNCH_PROGRESS_PATCH_MISSING';end if;
 d:=replace(d,$find$'setId',s.id,'requestedCount'$find$,$replace$'setId',s.id,'executor',private.catalog_video_public_executor(s.id),'requestedCount'$replace$);execute d;
end $launch_progress$;
commit;
