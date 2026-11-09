-- Connect the existing selection kernel to an enrolled native controller.
-- No new queue or state: scope is derived from the private control on every call.
begin;
create function public.service_read_restitch_control_selection(
 p_control uuid,p_control_hash bytea,p_slot text,p_active boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare scope jsonb;r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;candidates jsonb;
begin
 if p_active is null or p_slot is null or p_slot not in('start','end') then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 scope:=private.restitch_control_screen_scope(p_control,p_control_hash,p_active);
 select * into r from private.restitch_selection_roots where root_operation_id=(scope->>'rootOperationId')::uuid;
 select * into s from private.restitch_selection_slots where root_operation_id=r.root_operation_id and slot=p_slot;
 if r.root_operation_id is null or s.root_operation_id is null or s.snapshot_complete is null then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 candidates:='[]'::jsonb;
 if p_active then
  select coalesce(jsonb_agg(jsonb_build_object('versionId',c.version_id,'materialId',c.material_id,
   'sizeBytes',c.size_bytes,'mimeType',c.mime_type,'checksum',c.checksum) order by c.ordinal),'[]'::jsonb)
   into candidates from private.restitch_selection_candidates c
   where c.root_operation_id=r.root_operation_id and c.slot=p_slot;
 end if;
 return scope||jsonb_build_object('slot',p_slot,'poolNamespaceId',r.pool_namespace_id,
  'defaults',r.recipe->'defaults','source',jsonb_build_object('materialId',r.source_material_id,'version',r.source_version,
   'checksum',r.recipe->'sourceIdentity'->'checksum','sizeBytes',r.recipe->'sourceIdentity'->'sizeBytes','mimeType',r.recipe->'sourceIdentity'->'mimeType'),
  'budget',s.budget,'complete',s.snapshot_complete,'poolObservation',r.recipe->'poolObservations'->p_slot,'candidates',candidates);
end $fn$;
create function public.service_cas_restitch_control_selection(
 p_control uuid,p_control_hash bytea,p_slot text,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare scope jsonb;
begin
 scope:=private.restitch_control_screen_scope(p_control,p_control_hash,true);
 return public.service_cas_restitch_selection_slot_owned((scope->>'rootOperationId')::uuid,
  (scope->>'teamId')::uuid,(scope->>'actorId')::uuid,p_slot,p_expected_budget,p_next_budget,
  (scope->>'executorId')::uuid,(scope->>'epoch')::bigint);
end $fn$;
revoke all on function public.service_read_restitch_control_selection(uuid,bytea,text,boolean),
 public.service_cas_restitch_control_selection(uuid,bytea,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.service_read_restitch_control_selection(uuid,bytea,text,boolean),
 public.service_cas_restitch_control_selection(uuid,bytea,text,jsonb,jsonb) to service_role;

-- Completion and the original native closure are one transaction. The requested
-- local outcome is immutable; a pre-existing parent cancellation stays canceled.
alter table private.restitch_selection_executor_claims add column terminal_outcome text
 check(terminal_outcome is null or terminal_outcome in('delivered','failed','canceled'));
create function public.service_finish_restitch_native_control(
 p_grant uuid,p_ticket_hash bytea,p_claim uuid,p_quiescence uuid,p_outcome text)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare g private.restitch_native_controls%rowtype;c private.restitch_selection_executor_claims%rowtype;
 e private.restitch_selection_executors%rowtype;o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
 terminal text;
begin
 if p_claim is null or p_quiescence is null or p_outcome is null or p_outcome not in('delivered','failed','canceled') then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 g:=private.restitch_native_control_scope(p_grant,p_ticket_hash,false);
 if g.claim_id is distinct from p_claim then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 select * into c from private.restitch_selection_executor_claims where root_operation_id=g.root_operation_id and claim_id=p_claim;
 select * into e from private.restitch_selection_executors where root_operation_id=g.root_operation_id for update;
 select * into o from public.team_operations where id=g.root_operation_id;
 select * into r from private.restitch_selection_roots where root_operation_id=g.root_operation_id;
 if c.claim_id is null or c.native_instance_id is distinct from g.native_instance_id or e.epoch is distinct from c.epoch
  or (e.state='owned' and e.executor_id is distinct from c.executor_id) or e.state not in('owned','quiescent')
  or o.kind<>'download' or r.recipe->>'selectionProtocol' is distinct from '1' then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if c.terminal_outcome is not null and c.terminal_outcome<>p_outcome then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
 if (select count(*) from private.restitch_selection_slots where root_operation_id=g.root_operation_id)<>2 then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if p_outcome='delivered' and o.state in('pending','running') and exists(
  select 1 from private.restitch_selection_slots s where s.root_operation_id=g.root_operation_id
   and coalesce(r.recipe->'defaults'->>(s.slot||'Enabled'),'true')='true'
   and (s.budget->>'acceptedVersionId' is null or not exists(select 1 from jsonb_array_elements(s.budget->'candidates') candidate
    where candidate->>'versionId'=s.budget->>'acceptedVersionId' and candidate->>'rejected'='false'
     and candidate->'validatedAcquisition'=candidate->'acquisition'))
 ) then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if public.service_quiesce_restitch_native_control(p_grant,p_ticket_hash,p_claim,p_quiescence) is distinct from true then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 update private.restitch_selection_executor_claims set terminal_outcome=p_outcome
  where root_operation_id=g.root_operation_id and claim_id=p_claim and terminal_outcome is null;
 if o.state in('pending','running') then
  terminal:=case when p_outcome='delivered' then 'succeeded' else p_outcome end;
  update public.team_operations set state=terminal,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
   progress=case when terminal='succeeded' then 100 else progress end,
   bytes_completed=case when terminal='succeeded' then coalesce(bytes_total,bytes_completed) else bytes_completed end,
   error_code=case when terminal='failed' then 'PROCESS_FAILED' when terminal='canceled' then 'PROCESS_CANCELED' else null end,
   retryable=false where id=g.root_operation_id;
 end if;
 return true;
end $fn$;
revoke all on function public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.service_finish_restitch_native_control(uuid,bytea,uuid,uuid,text) to service_role;
commit;
