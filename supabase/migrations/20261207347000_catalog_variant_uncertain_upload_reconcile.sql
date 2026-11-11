-- Beta 2026-11-11 (QA, gateway paused 150 s): a catalog variant whose agent lost
-- the backend while its output was uploading owns a process upload (the Drive id
-- generated and bound before the provider call). The silence takeover and the
-- retry resolver skip such an operation, and the cleanup claimer fails it only
-- once its handoff and finalize grant have expired, so the variant waited for
-- the 12-hour abandonment rule while the file might already sit in Drive.
--
-- An uncertain upload is now reconciled in minutes:
--  * eligible when its executor has been silent for 2 minutes (the agent stops
--    itself after 90 s without a heartbeat) or when the agent itself reports
--    that its uploader has quiesced (the existing /process/output/quiesced ack);
--  * an upload that never started cannot have reached Drive: failed at once
--    (the outcome fence records 'not_created') and the variant requeued;
--  * a started one is claimed under a lease; the finalize grant is revoked, so
--    no late agent finalize can race the reconcile; drive-ops looks the
--    generated id up and settles it: registered (the verified file becomes the
--    variant's output), absent (provably never created: failed, 'not_created',
--    requeued), mismatch (failed, 'attention' with SOURCE_CHANGED, requeued —
--    the file stays where it is) or unknown (retried at 30 s, 1, 2, 4, 8, 10,
--    10 min; after 8 checks failed with 'attention', requeued). Nothing is
--    deleted; an orphan stays recorded on the ownership row.
begin;

alter table private.process_upload_ownership
 add column reconcile_requested_at timestamptz,
 add column reconcile_attempts integer not null default 0 check(reconcile_attempts between 0 and 8),
 add column reconcile_next_at timestamptz;

-- The catalog variant an operation belongs to, if any.
create function private.catalog_variant_of_operation(p_operation uuid) returns table(set_id uuid,variant_index integer) language sql stable security definer set search_path='' as $$
 select s.id,v.video_variant_index from public.team_operations o
  join private.catalog_video_variants v on o.idempotency_key='catalog-variant:'||v.request_id::text
  join private.catalog_video_sets s on s.id=v.video_set_id and s.team_id=o.team_id and s.actor_id=o.actor_id
 where o.id=p_operation and o.kind='process'
 limit 1
$$;
revoke all on function private.catalog_variant_of_operation(uuid) from public,anon,authenticated,service_role;

-- Fails a running operation whose upload outcome is decided here. The outcome
-- fence then records cleanup; the caller overrides it with what it proved.
create function private.fail_uncertain_process_upload(p_operation uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.team_operations set state='failed',stage='failed',error_code='PROCESS_RESULT_UNCERTAIN',retryable=false,
  finished_at=clock_timestamp(),updated_at=clock_timestamp(),reservation_released_at=coalesce(reservation_released_at,clock_timestamp())
  where id=p_operation and state in('pending','running');
 update private.team_transfer_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where operation_id=p_operation;
end $$;
revoke all on function private.fail_uncertain_process_upload(uuid) from public,anon,authenticated,service_role;

-- Whether an uncertain upload may be reconciled now (caller holds the rows).
create function private.uncertain_process_upload_due(o public.team_operations,u private.process_upload_ownership,p_set uuid,p_index integer) returns boolean language sql stable security definer set search_path='' as $$
 select o.kind='process' and o.state in('pending','running') and o.result_material_id is null
  and u.upload_state in('prepared','started') and u.cleanup_state='not_needed'
  and (u.lease_expires_at is null or u.lease_expires_at<=clock_timestamp())
  and (u.reconcile_next_at is null or u.reconcile_next_at<=clock_timestamp())
  and exists(select 1 from private.catalog_video_variants v where v.video_set_id=p_set and v.video_variant_index=p_index
   and v.state in('working','unknown') and v.output_material_id is null)
  and (u.reconcile_requested_at is not null
   or private.catalog_video_variant_last_life(p_set,p_index,o.id)<=clock_timestamp()-interval '2 minutes')
$$;
revoke all on function private.uncertain_process_upload_due(public.team_operations,private.process_upload_ownership,uuid,integer) from public,anon,authenticated,service_role;

create function public.service_claim_uncertain_process_uploads(p_owner uuid,p_limit integer default 3,p_operation uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;plans jsonb:='[]';
begin
 if p_owner is null or p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in
  select q.operation_id,variant.set_id,variant.variant_index from private.process_upload_ownership q
   join public.team_operations op on op.id=q.operation_id
   cross join lateral private.catalog_variant_of_operation(q.operation_id) variant
  where (p_operation is null or q.operation_id=p_operation)
   and op.kind='process' and op.state in('pending','running') and q.cleanup_state='not_needed' and q.upload_state in('prepared','started')
  order by q.reconcile_requested_at nulls last,q.updated_at,q.operation_id limit 20
 loop
  exit when jsonb_array_length(plans)>=p_limit;
  -- Lock order of every ownership path: the set, the operation, the ownership.
  perform 1 from private.catalog_video_sets where id=candidate.set_id for update skip locked;
  if not found then continue;end if;
  select * into o from public.team_operations where id=candidate.operation_id for update skip locked;
  if not found then continue;end if;
  select * into u from private.process_upload_ownership where operation_id=o.id for update skip locked;
  if not found or not private.uncertain_process_upload_due(o,u,candidate.set_id,candidate.variant_index) then continue;end if;
  if u.upload_state='prepared' then
   -- The provider was never asked: no file can exist. The fence records not_created.
   perform private.fail_uncertain_process_upload(o.id);
   perform private.retry_failed_catalog_video_variant(candidate.set_id,candidate.variant_index);
   continue;
  end if;
  update private.team_transfer_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where operation_id=o.id and purpose='finalize';
  update private.process_upload_ownership set reconcile_attempts=least(8,reconcile_attempts+1),fence=fence+1,lease_owner=p_owner,
   lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() where operation_id=o.id returning * into u;
  plans:=plans||jsonb_build_array(private.process_upload_binding(u)||jsonb_build_object('fence',u.fence::text,'actorId',o.actor_id,
   'setId',candidate.set_id,'variantIndex',candidate.variant_index,'attempt',u.reconcile_attempts));
 end loop;
 return plans;
end $$;

create function public.service_settle_uncertain_process_upload(p_operation uuid,p_owner uuid,p_fence text,p_result text,p_code text default null)
returns text language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;variant record;outcome text;
begin
 if p_result is null or p_result not in('registered','absent','mismatch','unknown')
  or (p_code is not null and p_code not in('PROCESS_RESULT_UNCERTAIN','SOURCE_CHANGED','NEEDS_REAUTH','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE'))
 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into variant from private.catalog_variant_of_operation(p_operation);
 if variant.set_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 perform 1 from private.catalog_video_sets where id=variant.set_id for update;
 select * into o from public.team_operations where id=p_operation for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if u.operation_id is null or u.fence::text is distinct from p_fence then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_result='registered' then
  -- Finalize published the ownership (and cleared the lease) when it succeeded the operation.
  if o.state<>'succeeded' or o.result_material_id is null or u.upload_state<>'published' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  perform private.retry_failed_catalog_video_variant(variant.set_id,variant.variant_index);
  return 'registered';
 end if;
 if u.lease_owner is distinct from p_owner or o.state not in('pending','running') or u.upload_state<>'started' or u.cleanup_state<>'not_needed'
 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_result='unknown' and u.reconcile_attempts<8 then
  update private.process_upload_ownership set lease_owner=null,lease_expires_at=null,last_code=coalesce(p_code,'PROCESS_RESULT_UNCERTAIN'),
   reconcile_next_at=clock_timestamp()+make_interval(secs=>least(600,30*power(2,greatest(u.reconcile_attempts-1,0))::integer)),updated_at=clock_timestamp()
   where operation_id=o.id;
  return 'waiting';
 end if;
 perform private.fail_uncertain_process_upload(o.id);
 outcome:=case p_result when 'absent' then 'not_created' else 'attention' end;
 update private.process_upload_ownership set cleanup_state=outcome,
  last_code=case when outcome='not_created' then null when p_result='mismatch' then 'SOURCE_CHANGED' else coalesce(p_code,'PROCESS_RESULT_UNCERTAIN') end,
  next_attempt_at=null,lease_owner=null,lease_expires_at=null,reconcile_next_at=null,updated_at=clock_timestamp()
  where operation_id=o.id;
 perform private.retry_failed_catalog_video_variant(variant.set_id,variant.variant_index);
 return outcome;
end $$;

-- The agent's own word: its uploader has settled without a confirmed result.
-- Authenticated by the operation's finalize ticket, as the launch ack is.
create function public.service_request_process_upload_reconcile(p_operation uuid,p_token_hash bytea)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;
begin
 if p_operation is null or p_token_hash is null or octet_length(p_token_hash)<>32 then return false;end if;
 select * into o from public.team_operations where id=p_operation for update;
 if o.id is null or o.kind<>'process' or o.state not in('pending','running') or not exists(
  select 1 from private.team_transfer_grants g where g.operation_id=o.id and g.team_id=o.team_id and g.actor_id=o.actor_id
   and g.purpose='finalize' and g.token_hash=p_token_hash) then return false;end if;
 update private.process_upload_ownership set reconcile_requested_at=coalesce(reconcile_requested_at,clock_timestamp()),
  reconcile_next_at=null,updated_at=clock_timestamp()
  where operation_id=o.id and upload_state in('prepared','started') and cleanup_state='not_needed';
 return found;
end $$;

revoke all on function public.service_claim_uncertain_process_uploads(uuid,integer,uuid),
 public.service_settle_uncertain_process_upload(uuid,uuid,text,text,text),
 public.service_request_process_upload_reconcile(uuid,bytea) from public,anon,authenticated;
grant execute on function public.service_claim_uncertain_process_uploads(uuid,integer,uuid),
 public.service_settle_uncertain_process_upload(uuid,uuid,text,text,text),
 public.service_request_process_upload_reconcile(uuid,bytea) to service_role;

-- The per-minute dispatcher wakes the worker for a due uncertain upload too.
do $due$
declare d text;
 needle text:=$find$  )
 )
$find$;
begin
 select pg_get_functiondef('private.process_output_cleanup_due()'::regprocedure) into d;
 if strpos(d,needle)=0 then raise exception 'UNCERTAIN_UPLOAD_DUE_SEAM_CHANGED';end if;
 d:=replace(d,needle,$replace$  )
 ) or exists(
  select 1 from private.process_upload_ownership q join public.team_operations op on op.id=q.operation_id
   cross join lateral private.catalog_variant_of_operation(q.operation_id) variant
  where op.kind='process' and op.state in('pending','running') and q.cleanup_state='not_needed' and q.upload_state in('prepared','started')
   and private.uncertain_process_upload_due(op,q,variant.set_id,variant.variant_index)
 )
$replace$);
 execute d;
end $due$;

commit;
