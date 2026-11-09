-- Close only already-requested cancellation after original execution is proven quiescent.
-- No media, outputs, receipts, assignments, or provider state is changed by this migration.
begin;
create function private.guard_catalog_variant_cancel_admission()returns trigger language plpgsql security definer set search_path=''as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;
begin
 if new.kind<>'process'or new.idempotency_key not like 'catalog-variant:%'then return new;end if;
 select *into v from private.catalog_video_variants where 'catalog-variant:'||request_id::text=new.idempotency_key;
 if v.request_id is null then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
 select *into s from private.catalog_video_sets where id=v.video_set_id for update;
 if(s.team_id,s.actor_id,s.source_material_id)is distinct from(new.team_id,new.actor_id,new.source_material_id)then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if s.state in('cancel_requested','canceled')then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return new;
end $$;
revoke all on function private.guard_catalog_variant_cancel_admission()from public,anon,authenticated,service_role;
create trigger catalog_variant_cancel_admission before insert on public.team_operations for each row execute function private.guard_catalog_variant_cancel_admission();

create function private.catalog_video_cancel_quiescent(p_set uuid)returns boolean language plpgsql security definer set search_path=''as $$
declare s private.catalog_video_sets%rowtype;v private.catalog_video_variants%rowtype;o public.team_operations%rowtype;i private.team_operation_intents%rowtype;has_operation boolean;
begin
 select *into s from private.catalog_video_sets where id=p_set for update;
 if s.id is null or s.state<>'cancel_requested'then return false;end if;
 if s.catalog_intent_id is not null then
  if not exists(select 1 from private.catalog_generation_intents original where original.id=s.catalog_intent_id and original.team_id=s.team_id and original.actor_id=s.actor_id and original.video_material_id=s.source_material_id and original.checkpoint#>>'{initialVideoPlan,setId}'=s.id::text)then return false;end if;
 else
  if not exists(select 1 from public.team_catalog_update_attempts original where original.attempt_id=s.update_attempt_id and original.team_id=s.team_id and original.catalog_material_id=s.catalog_material_id)then return false;end if;
 end if;
 if(select count(*)from private.catalog_video_variants where video_set_id=s.id)<>s.requested_count then return false;end if;
 for v in select *from private.catalog_video_variants where video_set_id=s.id order by video_variant_index for update loop
  if v.state='registered'then continue;end if;
  select exists(select 1 from public.team_operations original where original.team_id=s.team_id and original.actor_id=s.actor_id and original.kind='process'and original.idempotency_key='catalog-variant:'||v.request_id::text)into has_operation;
  select *into o from public.team_operations original where original.team_id=s.team_id and original.actor_id=s.actor_id and original.kind='process'and original.idempotency_key='catalog-variant:'||v.request_id::text for update skip locked;
  if o.id is null then
   if has_operation or v.operation_id is not null or v.state<>'queued'or v.dispatch_credential_hash is not null then return false;end if;
   continue;
  end if;
  if(v.operation_id is not null and v.operation_id<>o.id)or o.source_material_id is distinct from s.source_material_id or o.result_material_id is not null then return false;end if;
  select *into i from private.team_operation_intents where operation_id=o.id and team_id=s.team_id;
  if i.operation_id is null or i.tool_id is distinct from 'restitch'or i.expected_source_version is distinct from s.source_version or i.provider_result_id is not null or exists(select 1 from private.process_upload_ownership where operation_id=o.id)then return false;end if;
  if o.state in('pending','running')then
   -- No native dispatch, grant, provider ownership or alias has ever existed:
   -- only the original metadata admission can be canceled here.
   if v.dispatch_credential_hash is not null or exists(select 1 from private.team_recovery_execution_fences where operation_id=o.id)or exists(select 1 from private.team_transfer_grants where operation_id=o.id)or exists(select 1 from private.catalog_video_grant_rounds where video_set_id=s.id and video_variant_index=v.video_variant_index and(source_hash is not null or finalize_hash is not null))or exists(select 1 from private.restitch_process_aliases where root_operation_id=o.id)or exists(select 1 from private.restitch_screen_range_grants where root_operation_id=o.id)then return false;end if;
   perform public.service_transition_team_operation(o.id,'canceled','canceled',o.progress,null,'PROCESS_CANCELED',false);
  elsif o.state not in('failed','canceled')then return false;end if;
  if v.dispatch_credential_hash is not null and not exists(select 1 from private.team_recovery_execution_fences fence where fence.operation_id=o.id and fence.team_id=s.team_id and fence.actor_id=s.actor_id and fence.job_id=v.request_id)then return false;end if;
  -- A terminal operation is not proof that an enrolled native executor stopped.
  if exists(select 1 from private.restitch_process_aliases alias where alias.root_operation_id=o.id)then
   if not exists(select 1 from private.restitch_selection_executors executor where executor.root_operation_id=o.id and executor.state='quiescent')or exists(select 1 from private.restitch_selection_executor_claims claim where claim.root_operation_id=o.id and(claim.quiescence_id is null or claim.terminal_outcome is null))then return false;end if;
  end if;
  if not exists(select 1 from private.restitch_process_aliases where root_operation_id=o.id)and exists(select 1 from private.team_transfer_grants where operation_id=o.id and uses>0)then return false;end if;
  if exists(select 1 from private.restitch_selection_slots slot cross join lateral jsonb_array_elements(slot.budget->'transfers') transfer where slot.root_operation_id=o.id and(transfer->'settlement'is null or transfer->'settlement'='null'::jsonb))then return false;end if;
 end loop;
 return true;
end $$;
revoke all on function private.catalog_video_cancel_quiescent(uuid)from public,anon,authenticated,service_role;

create function public.service_settle_catalog_video_cancellations(p_limit integer default 3)returns jsonb language plpgsql security definer set search_path=''as $$
declare candidate record;s private.catalog_video_sets%rowtype;context private.launch_catalog_video_contexts%rowtype;g public.team_launch_generations%rowtype;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 for candidate in select id,catalog_intent_id,update_attempt_id from private.catalog_video_sets where state='cancel_requested'order by updated_at,id limit p_limit loop
  select *into context from private.launch_catalog_video_contexts where catalog_intent_id=candidate.catalog_intent_id and video_set_id=candidate.id;
  if context.generation_id is not null then
   perform 1 from public.team_launches where id=(select launch_id from public.team_launch_generations where id=context.generation_id)for update skip locked;if not found then continue;end if;
   select *into g from public.team_launch_generations where id=context.generation_id for update skip locked;if not found then continue;end if;
  end if;
  if candidate.catalog_intent_id is not null then perform 1 from private.catalog_generation_intents where id=candidate.catalog_intent_id for update skip locked;
  else perform 1 from public.team_catalog_update_attempts where attempt_id=candidate.update_attempt_id for update skip locked;end if;
  if not found then continue;end if;
  select *into s from private.catalog_video_sets where id=candidate.id and state='cancel_requested'for update skip locked;if not found then continue;end if;
  if private.catalog_video_cancel_quiescent(s.id)is not true then
   -- Observation scheduling only: this timestamp is not physical progress.
   update private.catalog_video_sets set updated_at=clock_timestamp()where id=s.id and state='cancel_requested';
   continue;end if;
  update private.catalog_video_sets set state='canceled',revision=revision+1,updated_at=clock_timestamp()where id=s.id;
  n:=n+1;
  -- Existing cancellation trigger retains publication/cleanup fences, including unknown provider writes.
  if context.generation_id is not null and g.state in('cancel_requested','canceled_with_cleanup_pending')then
   update public.team_launch_generations set state='canceled',stage='canceled',lease_owner=null,lease_expires_at=clock_timestamp(),next_attempt_at=null,state_version=state_version+1,updated_at=clock_timestamp()where id=g.id;
   perform private.launch_signal(g.team_id,g.launch_id,(select aggregate_version from public.team_launches where id=g.launch_id));
  end if;
 end loop;
 return jsonb_build_object('settled',n);
end $$;
revoke all on function public.service_settle_catalog_video_cancellations(integer)from public,anon,authenticated;
grant execute on function public.service_settle_catalog_video_cancellations(integer)to service_role;
-- Preserve the current 176 wrapper (including 175 underneath) and only wake
-- the existing worker for already-requested cancellation metadata settlement.
do $wake$
declare d text;needle text:='and not exists(select 1 from private.catalog_publication_cell_writes w where w.job_id=j.id))';
begin
 select pg_get_functiondef('private.launch_catalog_recovery_due()'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'CATALOG_CANCEL_WAKE_SEAM_CHANGED';end if;
 d:=replace(d,needle,needle||'or exists(select 1 from private.catalog_video_sets pending_cancel where pending_cancel.state=''cancel_requested'')');execute d;
end $wake$;
commit;
