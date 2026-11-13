-- A batch receipt commits every selected outcome before the browser is told it
-- was accepted. Existing generations remain the execution/cleanup authority.
begin;
create table private.launch_batches (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id),
 actor_id uuid not null references auth.users(id), request_key uuid not null, intent jsonb not null,
 created_at timestamptz not null default clock_timestamp(), cancel_requested_at timestamptz, admission_last_claim_at timestamptz,
 unique(team_id,actor_id,request_key), check(octet_length(intent::text)<=32768)
);
create table private.launch_batch_items (
 batch_id uuid not null references private.launch_batches(id), ordinal integer not null check(ordinal between 1 and 100),
 launch_id uuid not null, expected_version text not null, child_request_key uuid not null,
 generation_id uuid references public.team_launch_generations(id), error_code text references public.team_error_codes(code),
 identity_snapshot jsonb not null, updated_at timestamptz not null default clock_timestamp(), admission_pending boolean not null default false,
 admission_attempts integer not null default 0 check(admission_attempts>=0), admission_next_attempt_at timestamptz,
 admission_lease_owner uuid,admission_lease_expires_at timestamptz,
 check(not admission_pending or(generation_id is null and error_code is not null)),
 cancel_pending boolean not null default false,
 cancel_error_code text references public.team_error_codes(code), cancel_next_attempt_at timestamptz,
 cancel_command_id uuid not null default gen_random_uuid(), primary key(batch_id,ordinal), unique(batch_id,launch_id),unique(batch_id,child_request_key),
 check((generation_id is null)<>(error_code is null)), check(octet_length(identity_snapshot::text)<=16384)
);
create index launch_batches_actor_time_idx on private.launch_batches(team_id,actor_id,created_at desc,id desc);
create index launch_batch_items_admission_due_idx on private.launch_batch_items(admission_next_attempt_at,batch_id)where admission_pending;
create index launch_batch_items_cancel_due_idx on private.launch_batch_items(cancel_next_attempt_at,batch_id)where cancel_pending;
create index launch_batch_items_generation_idx on private.launch_batch_items(generation_id) where generation_id is not null;
alter table private.launch_batches enable row level security;
alter table private.launch_batches force row level security;
alter table private.launch_batch_items enable row level security;
alter table private.launch_batch_items force row level security;
revoke all on private.launch_batches,private.launch_batch_items from public,anon,authenticated,service_role;

create function private.validate_launch_batch_intent(p_team uuid,p_key uuid,p_intent jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare item jsonb; ids uuid[]:='{}';keys uuid[]:='{}';
begin
 if p_team is null or p_key is null or jsonb_typeof(p_intent) is distinct from 'object' or octet_length(p_intent::text)>32768
  or p_intent->>'teamId' is distinct from p_team::text or p_intent->>'requestKey' is distinct from p_key::text
  or jsonb_typeof(p_intent->'items') is distinct from 'array' or jsonb_array_length(p_intent->'items') not between 1 and 100
  then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_intent ? 'expectedExecutorId' and (p_intent->>'expectedExecutorId' is null or p_intent->>'expectedExecutorId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_intent->'items')loop
  if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'launchId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or coalesce(item->>'childRequestKey','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   or coalesce(item->>'expectedVersion','') !~ '^[1-9][0-9]{0,18}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if (item->>'expectedVersion')::numeric>9223372036854775807 or (item->>'launchId')::uuid=any(ids) or (item->>'childRequestKey')::uuid=any(keys)then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  ids:=array_append(ids,(item->>'launchId')::uuid);keys:=array_append(keys,(item->>'childRequestKey')::uuid);
 end loop;
end $$;

-- The only allowed draft rewrite at acceptance is spelling the established
-- protocol defaults. The selected CAS and acceptance increment cover it once.
create function private.normalize_launch_batch_config(p_config jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p_config->>'method'='catalog' and jsonb_typeof(p_config->'catalog')='object'
 then jsonb_set(p_config,'{catalog}',p_config->'catalog'||jsonb_build_object(
 'catalogVideoProtocolVersion',1,'videoVariationCount',coalesce(p_config#>'{catalog,videoVariationCount}','1'::jsonb),
 'videoPublication',coalesce(p_config#>'{catalog,videoPublication}','{"mode":"immediate"}'::jsonb))) else p_config end
$$;

create function private.launch_batch_json(p_batch uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',b.id,'teamId',b.team_id,'requestKey',b.request_key,'createdAt',b.created_at,'cancelRequestedAt',b.cancel_requested_at,
 'items',(select jsonb_agg(jsonb_build_object('launchId',i.launch_id,'expectedVersion',i.expected_version,'childRequestKey',i.child_request_key,
 'admission',case when i.admission_pending then 'pending' when i.generation_id is null then 'refused' else 'accepted' end,'errorCode',i.error_code,'generationId',i.generation_id,
 'cancelPending',i.cancel_pending,'cancelErrorCode',i.cancel_error_code,
 'admissionAttempts',i.admission_attempts,'admissionNextAttemptAt',i.admission_next_attempt_at,
 'offer',coalesce(i.identity_snapshot->>'offer',''),'social',coalesce(i.identity_snapshot->>'social',''),'agentId',coalesce(i.identity_snapshot->>'agentId',''),
 'agentSuffix',nullif(right(coalesce(i.identity_snapshot->>'agentId',''),3),''),
 'generation',(select jsonb_build_object('id',g.id,'state',g.state,'stage',g.stage,'stateVersion',g.state_version::text,'requestKey',g.request_key,
 'inputVersion',g.input_version,'attemptNo',g.attempt_no,'startedAt',case when coalesce(g.attempt_no,1)<=1 then g.created_at else(select min(st.created_at)from public.team_launch_generation_steps st where st.generation_id=g.id and st.attempt_no=g.attempt_no)end,'errorCode',g.safe_error_code,'childOperationIds','[]'::jsonb,
 'progress',coalesce((select jsonb_build_object('completed',(select count(*) from private.catalog_video_variants v where v.video_set_id=s.id and v.state='registered'),'total',s.requested_count,'unit','videos','source','registered_video_variants') from private.launch_catalog_video_contexts c join private.catalog_video_sets s on s.id=c.video_set_id where c.generation_id=g.id),g.progress),
 'videoGeneration',(select jsonb_build_object('setId',s.id,'state',s.state,'requestedCount',s.requested_count,'registeredCount',(select count(*) from private.catalog_video_variants v where v.video_set_id=s.id and v.state='registered')) from private.launch_catalog_video_contexts c join private.catalog_video_sets s on s.id=c.video_set_id where c.generation_id=g.id))
 from public.team_launch_generations g where g.id=i.generation_id and g.team_id=b.team_id and g.actor_id=b.actor_id)) order by i.ordinal)from private.launch_batch_items i where i.batch_id=b.id))
 from private.launch_batches b where b.id=p_batch
$$;
create function public.get_launch_batch(p_team uuid,p_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform private.launch_access(p_team,'view');
 return private.launch_batch_json((select id from private.launch_batches where team_id=p_team and actor_id=auth.uid() and request_key=p_key));
end $$;
create function public.list_launch_batches(p_team uuid,p_limit integer default 10,p_before timestamptz default null,p_before_id uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;more boolean;last_row jsonb;
begin
 perform private.launch_access(p_team,'view');
 if p_limit is null or p_limit not between 1 and 20 or (p_before is null)<>(p_before_id is null)then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select coalesce(jsonb_agg(private.launch_batch_json(id)order by created_at desc,id desc),'[]')into rows from(
  select id,created_at from private.launch_batches where team_id=p_team and actor_id=auth.uid() and(p_before is null or(created_at,id)<(p_before,p_before_id))order by created_at desc,id desc limit p_limit+1)x;
 more:=jsonb_array_length(rows)>p_limit;if more then rows:=rows-p_limit;end if;last_row:=rows->(jsonb_array_length(rows)-1);
 return jsonb_build_object('items',rows,'hasMore',more,'nextCursor',case when more then jsonb_build_object('createdAt',last_row->'createdAt','id',last_row->'id')else null end);
end $$;

create function public.service_launch_batch_context(p_team uuid,p_actor uuid,p_key uuid,p_intent jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.launch_batches%rowtype;l public.team_launches%rowtype;item jsonb;rows jsonb:='[]';source jsonb;failure_code text;
begin
 if p_actor is null or p_intent->>'expectedActorId'is distinct from p_actor::text or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform private.validate_launch_batch_intent(p_team,p_key,p_intent);
 select*into b from private.launch_batches where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if b.id is not null then
  if b.intent<>p_intent then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return jsonb_build_object('batch',private.launch_batch_json(b.id));
 end if;
 for item in select value from jsonb_array_elements(p_intent->'items')loop
  source:=null;failure_code:=null;l:=null;
  begin
   select*into l from public.team_launches where team_id=p_team and id=(item->>'launchId')::uuid and archived_at is null;
   if l.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
   if l.aggregate_version::text<>item->>'expectedVersion'then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
   if l.active_revision_id is not null or exists(select 1 from public.team_launch_generations where launch_id=l.id)then raise exception 'LAUNCH_BUSY' using errcode='55000';end if;
   source:=public.service_launch_sources(p_team,l.id,p_actor);
  exception when others then
   get stacked diagnostics failure_code=message_text;
   if not exists(select 1 from public.team_error_codes where team_error_codes.code=failure_code)then failure_code:='LAUNCH_INTERNAL_ERROR';end if;
  end;
  rows:=rows||jsonb_build_array(item||jsonb_build_object('config',private.normalize_launch_batch_config(l.draft_config),'sources',source,'errorCode',failure_code));
 end loop;
 return jsonb_build_object('items',rows);
end $$;

-- Both first admission and automatic retries use the selected immutable CAS.
-- Only a bounded pending-member lease can turn a stored pending item into an
-- accepted generation; every definitive outcome is retained independently.
create function private.accept_launch_batch(p_team uuid,p_actor uuid,p_key uuid,p_intent jsonb,p_prepared jsonb,p_resume boolean,p_owner uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare b private.launch_batches%rowtype;l public.team_launches%rowtype;member private.launch_batch_items%rowtype;
 item jsonb;prepared jsonb;row_entry record;receipt jsonb;failure_code text;identity_value jsonb;gid uuid;pending boolean;attempt integer;
begin
 if p_actor is null or p_intent->>'expectedActorId'is distinct from p_actor::text or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform private.validate_launch_batch_intent(p_team,p_key,p_intent);
 perform pg_advisory_xact_lock(hashtextextended('launch-batch:'||p_team::text||p_actor::text||p_key::text,0));
 select*into b from private.launch_batches where team_id=p_team and actor_id=p_actor and request_key=p_key for update;
 if b.id is not null then
  if b.intent<>p_intent then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  if not p_resume or b.cancel_requested_at is not null then return private.launch_batch_json(b.id);end if;
 elsif p_resume then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 if p_resume and p_owner is null then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 if jsonb_typeof(p_prepared)is distinct from 'array' or jsonb_array_length(p_prepared)<>jsonb_array_length(p_intent->'items')or octet_length(p_prepared::text)>16777216 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- Stable request-before-aggregate lock order, shared with single acceptance.
 for item in select value from jsonb_array_elements(p_intent->'items')order by value->>'childRequestKey'loop
  perform pg_advisory_xact_lock(hashtextextended(p_team::text||(item->>'childRequestKey'),0));
 end loop;
 if b.id is null then
  insert into private.launch_batches(team_id,actor_id,request_key,intent)values(p_team,p_actor,p_key,p_intent)returning*into b;
 end if;
 for row_entry in select value,ordinality from jsonb_array_elements(p_intent->'items')with ordinality order by value->>'launchId'loop
  item:=row_entry.value;prepared:=p_prepared->(row_entry.ordinality::integer-1);gid:=null;failure_code:=null;identity_value:='{}';attempt:=1;
  if prepared->>'launchId'is distinct from item->>'launchId'or prepared->>'childRequestKey'is distinct from item->>'childRequestKey'or prepared->>'expectedVersion'is distinct from item->>'expectedVersion'then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if p_resume then
   select*into member from private.launch_batch_items where batch_id=b.id and ordinal=row_entry.ordinality for update;
   if not member.admission_pending or member.admission_lease_owner is distinct from p_owner or member.admission_lease_expires_at is null or member.admission_lease_expires_at<=clock_timestamp()or prepared->'skip'='true'::jsonb then continue;end if;
   attempt:=member.admission_attempts+1;identity_value:=member.identity_snapshot;
  elsif prepared ? 'skip' then raise exception 'INVALID_INPUT'using errcode='22023';end if;
  begin
   select*into l from public.team_launches where team_id=p_team and id=(item->>'launchId')::uuid and archived_at is null for update;
   if l.id is null then raise exception 'NOT_FOUND'using errcode='P0002';end if;
   identity_value:=jsonb_build_object('offer',coalesce(prepared#>>'{sources,offer}',l.expected_source_snapshot->>'offer',''),'social',coalesce(prepared#>>'{sources,social}',l.expected_source_snapshot->>'social',''),'agentId',coalesce(prepared#>>'{sources,agentId}',l.expected_source_snapshot->>'agentId',''));
   if l.aggregate_version::text<>item->>'expectedVersion'then raise exception 'LAUNCH_VERSION_CONFLICT'using errcode='40001';end if;
   if l.active_revision_id is not null or exists(select 1 from public.team_launch_generations where launch_id=l.id)then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
   if prepared->>'errorCode'is not null then raise exception '%',prepared->>'errorCode'using errcode='55000';end if;
   if prepared->'config'is distinct from private.normalize_launch_batch_config(l.draft_config)then raise exception 'LAUNCH_VERSION_CONFLICT'using errcode='40001';end if;
   if l.draft_config is distinct from prepared->'config'then
    update public.team_launches set draft_config=prepared->'config',draft_version=draft_version+1 where id=l.id;
   end if;
   if prepared#>>'{config,method}'='catalog'then
    receipt:=public.service_accept_launch_catalog_video_generation(p_team,l.id,p_actor,item->>'expectedVersion',item->>'childRequestKey',prepared->>'digest',prepared->'config',prepared->'sources',prepared->'preview',prepared->'video');
   else
    receipt:=public.service_accept_launch_generation(p_team,l.id,p_actor,item->>'expectedVersion',item->>'childRequestKey',prepared->>'digest',prepared->'config',prepared->'sources',prepared->'preview');
   end if;
   gid:=(receipt->>'id')::uuid;
  exception when others then
   get stacked diagnostics failure_code=message_text;
   if not exists(select 1 from public.team_error_codes where team_error_codes.code=failure_code)then failure_code:='LAUNCH_INTERNAL_ERROR';end if;
  end;
  pending:=coalesce(failure_code in('TEAM_TRANSPORT_UNAVAILABLE','DRIVE_UNAVAILABLE','RATE_LIMITED','NO_WORK','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','PROCESS_RESULT_UNCERTAIN','AGENT_REQUIRED','AGENT_UPDATE_REQUIRED','INVALID_RESPONSE'),false);
  if p_resume then
   update private.launch_batch_items set generation_id=gid,error_code=failure_code,identity_snapshot=identity_value,
    admission_pending=pending,admission_attempts=attempt,admission_next_attempt_at=case when pending then clock_timestamp()+make_interval(secs=>least(900,30*power(2,least(attempt-1,5)))::double precision)else null end,
    admission_lease_owner=null,admission_lease_expires_at=null where batch_id=b.id and ordinal=row_entry.ordinality;
   -- The existing workspace signal refreshes the batch projection even if a
   -- retry is still waiting for setup and has no generation to emit a signal.
   if gid is null and l.id is not null then perform private.launch_signal(p_team,l.id,l.aggregate_version);end if;
  else
   insert into private.launch_batch_items(batch_id,ordinal,launch_id,expected_version,child_request_key,generation_id,error_code,identity_snapshot,admission_pending,admission_attempts,admission_next_attempt_at)
    values(b.id,row_entry.ordinality,(item->>'launchId')::uuid,item->>'expectedVersion',(item->>'childRequestKey')::uuid,gid,failure_code,identity_value,pending,attempt,case when pending then clock_timestamp()+interval '30 seconds'else null end);
  end if;
 end loop;
 begin perform private.invoke_catalog_updater_worker();exception when others then null;end;
 return private.launch_batch_json(b.id);
end $$;
create function public.service_accept_launch_batch(p_team uuid,p_actor uuid,p_key uuid,p_intent jsonb,p_prepared jsonb)returns jsonb language sql security definer set search_path=''as $$
 select private.accept_launch_batch(p_team,p_actor,p_key,p_intent,p_prepared,false,null)
$$;
create function public.service_retry_launch_batch_admission(p_team uuid,p_actor uuid,p_key uuid,p_intent jsonb,p_prepared jsonb,p_owner uuid)returns jsonb language sql security definer set search_path=''as $$
 select private.accept_launch_batch(p_team,p_actor,p_key,p_intent,p_prepared,true,p_owner)
$$;
create function public.service_claim_launch_batch_admission_recovery(p_limit integer default 3)returns jsonb language plpgsql security definer set search_path=''as $$
declare b private.launch_batches%rowtype;l public.team_launches%rowtype;member record;selected jsonb;rows jsonb:='[]';source jsonb;failure_code text;
 owner uuid:=gen_random_uuid();ordinals integer[]:='{}';entry record;
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 select*into b from private.launch_batches batch where batch.cancel_requested_at is null and exists(
  select 1 from private.launch_batch_items i where i.batch_id=batch.id and i.admission_pending and i.admission_next_attempt_at<=clock_timestamp()
   and(i.admission_lease_expires_at is null or i.admission_lease_expires_at<=clock_timestamp()))
  order by admission_last_claim_at nulls first,created_at,id for update skip locked limit 1;
 if b.id is null then return null;end if;
 if private.can(b.team_id,'edit',b.actor_id)is not true then
  update private.launch_batch_items set admission_pending=false,error_code='PERMISSION_DENIED',admission_next_attempt_at=null,admission_lease_owner=null,admission_lease_expires_at=null where batch_id=b.id and admission_pending;
  return null;
 end if;
 for member in select ordinal from private.launch_batch_items where batch_id=b.id and admission_pending and admission_next_attempt_at<=clock_timestamp()
  and(admission_lease_expires_at is null or admission_lease_expires_at<=clock_timestamp())order by admission_next_attempt_at,ordinal for update skip locked limit p_limit loop
  ordinals:=array_append(ordinals,member.ordinal);
  update private.launch_batch_items set admission_lease_owner=owner,admission_lease_expires_at=clock_timestamp()+interval '60 seconds'where batch_id=b.id and ordinal=member.ordinal;
 end loop;
 update private.launch_batches set admission_last_claim_at=clock_timestamp()where id=b.id;
 for entry in select value,ordinality from jsonb_array_elements(b.intent->'items')with ordinality loop
  selected:=entry.value;
  if not entry.ordinality::integer=any(ordinals)then rows:=rows||jsonb_build_array(selected||jsonb_build_object('skip',true));continue;end if;
  source:=null;failure_code:=null;l:=null;
  begin
   select*into l from public.team_launches where team_id=b.team_id and id=(selected->>'launchId')::uuid and archived_at is null;
   if l.id is null then raise exception 'NOT_FOUND'using errcode='P0002';end if;
   if l.aggregate_version::text<>selected->>'expectedVersion'then raise exception 'LAUNCH_VERSION_CONFLICT'using errcode='40001';end if;
   if l.active_revision_id is not null or exists(select 1 from public.team_launch_generations where launch_id=l.id)then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
   source:=public.service_launch_sources(b.team_id,l.id,b.actor_id);
  exception when others then
   get stacked diagnostics failure_code=message_text;
   if not exists(select 1 from public.team_error_codes where team_error_codes.code=failure_code)then failure_code:='LAUNCH_INTERNAL_ERROR';end if;
  end;
  rows:=rows||jsonb_build_array(selected||jsonb_build_object('config',private.normalize_launch_batch_config(l.draft_config),'sources',source,'errorCode',failure_code));
 end loop;
 return jsonb_build_object('command',b.intent,'owner',owner,'context',jsonb_build_object('items',rows));
end $$;

-- The batch stores cancellation before trying each child. A transient fence or
-- publication readback failure only defers that child, never its siblings.
create function private.apply_launch_batch_cancellation(p_batch uuid,p_ordinal integer) returns void
language plpgsql security definer set search_path='' as $$
declare item private.launch_batch_items%rowtype;b private.launch_batches%rowtype;
 l public.team_launches%rowtype;g public.team_launch_generations%rowtype;failure_code text;
begin
 select*into item from private.launch_batch_items where batch_id=p_batch and ordinal=p_ordinal and cancel_pending for update skip locked;
 if not found then return;end if;
 select*into b from private.launch_batches where id=p_batch;
 begin
  if private.can(b.team_id,'edit',b.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
  select*into l from public.team_launches where id=item.launch_id and team_id=b.team_id for update;
  select*into g from public.team_launch_generations where id=item.generation_id and launch_id=l.id and team_id=b.team_id and actor_id=b.actor_id for update;
  if g.id is null then raise exception 'NOT_FOUND'using errcode='P0002';end if;
  if g.state='succeeded' then
   if exists(select 1 from private.launch_catalog_video_contexts c join private.catalog_video_sets s on s.id=c.video_set_id where c.generation_id=g.id and s.state not in('ready','canceled'))then
    perform public.service_created_launch_catalog_video(b.team_id,b.actor_id,g.id,'cancel',item.cancel_command_id);
   end if;
  elsif g.state not in('canceled','cancel_requested','canceled_with_cleanup_pending')then
   -- Identical generation/child cancellation fences to single-launch cancel.
   -- No readback of an archived aggregate is required to acknowledge its stop.
   update public.team_launch_generations set state=case when exists(select 1 from public.team_launch_generation_steps where generation_id=g.id)then 'cancel_requested'else 'canceled'end,
    stage='cancel',cancel_requested_at=clock_timestamp(),fence=fence+1,state_version=state_version+1,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()where id=g.id;
   update public.team_launches set aggregate_version=aggregate_version+1,updated_at=clock_timestamp()where id=l.id returning*into l;
   perform private.launch_signal(b.team_id,l.id,l.aggregate_version);
  end if;
  update private.launch_batch_items set cancel_pending=false,cancel_error_code=null,cancel_next_attempt_at=null where batch_id=p_batch and ordinal=p_ordinal;
 exception when others then
  get stacked diagnostics failure_code=message_text;
  if not exists(select 1 from public.team_error_codes where team_error_codes.code=failure_code)then failure_code:='LAUNCH_INTERNAL_ERROR';end if;
  update private.launch_batch_items set cancel_error_code=failure_code,
   cancel_pending=failure_code not in('PERMISSION_DENIED','NOT_FOUND'),
   cancel_next_attempt_at=case when failure_code not in('PERMISSION_DENIED','NOT_FOUND')then clock_timestamp()+interval '30 seconds'else null end
   where batch_id=p_batch and ordinal=p_ordinal;
 end;
end $$;
create function public.cancel_launch_batch(p_team uuid,p_key uuid,p_cancel_key uuid,p_expected_actor uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare b private.launch_batches%rowtype;item private.launch_batch_items%rowtype;
begin
 perform private.launch_access(p_team,'edit');if p_expected_actor is distinct from auth.uid()then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;if p_cancel_key is null then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 select*into b from private.launch_batches where team_id=p_team and actor_id=auth.uid()and request_key=p_key for update;
 if b.id is null then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 if b.cancel_requested_at is null then
  update private.launch_batches set cancel_requested_at=clock_timestamp()where id=b.id;
  update private.launch_batch_items set admission_pending=false,error_code='PROCESS_CANCELED',admission_next_attempt_at=null,admission_lease_owner=null,admission_lease_expires_at=null where batch_id=b.id and admission_pending;
  update private.launch_batch_items set cancel_pending=true where batch_id=b.id and generation_id is not null;
 end if;
 for item in select*from private.launch_batch_items where batch_id=b.id and cancel_pending order by launch_id loop
  perform private.apply_launch_batch_cancellation(b.id,item.ordinal);
 end loop;
 begin perform private.invoke_catalog_updater_worker();exception when others then null;end;
 return private.launch_batch_json(b.id);
end $$;
create function public.service_settle_launch_batch_cancellations(p_limit integer default 3)returns integer language plpgsql security definer set search_path=''as $$
declare item record;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 for item in select batch_id,ordinal from private.launch_batch_items where cancel_pending and(cancel_next_attempt_at is null or cancel_next_attempt_at<=clock_timestamp())order by cancel_next_attempt_at nulls first,batch_id,ordinal limit p_limit loop
  perform private.apply_launch_batch_cancellation(item.batch_id,item.ordinal);n:=n+1;
 end loop;
 return n;
end $$;

-- Non-catalog bulk work has the same durable source-proof-before-publish lane.
create function public.service_list_launch_batch_other_recovery(p_limit integer default 3)returns jsonb language plpgsql stable security definer set search_path=''as $$
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',g.team_id,'actorId',g.actor_id,'generationId',g.id))from(
 select g.*from public.team_launch_generations g join private.launch_batch_items i on i.generation_id=g.id join public.team_launch_revisions r on r.id=g.revision_id join public.team_launches l on l.id=g.launch_id
 where r.config->>'method'='other'and l.archived_at is null and private.can(g.team_id,'edit',g.actor_id)and g.state in('accepted','running','interrupted')
 and(g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())and(g.next_attempt_at is null or g.next_attempt_at<=clock_timestamp())
 and(g.safe_error_code is null or g.safe_error_code in('TEAM_TRANSPORT_UNAVAILABLE','DRIVE_UNAVAILABLE','RATE_LIMITED','NO_WORK','LAUNCH_INTERNAL_ERROR','LAUNCH_RESULT_UNCERTAIN','PROCESS_RESULT_UNCERTAIN','UNKNOWN'))order by coalesce(g.next_attempt_at,g.created_at),g.id limit p_limit)g),'[]');
end $$;
-- Continue a completed bounded slice through the established dispatcher. The
-- due list excludes leased, delayed, archived and unauthorized children; a
-- queue containing only those cases never creates an immediate wake-up loop.
create function public.service_continue_launch_batch_recovery()returns bigint language plpgsql security definer set search_path=''as $$
begin
 if jsonb_array_length(public.service_list_launch_batch_other_recovery(1))=0 then return null;end if;
 return private.invoke_catalog_updater_worker();
end $$;
-- A recovered Other generation is publishable only after the trusted Edge has
-- proved the frozen source under its current lease. Legacy sweepers and stale
-- single-launch retries cannot publish a batch child around that proof.
create table private.launch_batch_other_proofs (
 generation_id uuid primary key references public.team_launch_generations(id), fence bigint not null
);
alter table private.launch_batch_other_proofs enable row level security;
alter table private.launch_batch_other_proofs force row level security;
revoke all on private.launch_batch_other_proofs from public,anon,authenticated,service_role;
create function private.require_launch_batch_other_proof()returns trigger language plpgsql security definer set search_path=''as $$
begin
 -- A row selected before another worker recorded backoff cannot bypass that floor.
 if new.state='running'and old.state='interrupted'and old.next_attempt_at>clock_timestamp()
  and exists(select 1 from private.launch_batch_items i where i.generation_id=new.id)then
  raise exception 'NO_WORK'using errcode='55000';
 end if;
 if new.state='succeeded'and old.state<>'succeeded'
  and exists(select 1 from private.launch_batch_items i join public.team_launch_revisions r on r.id=new.revision_id where i.generation_id=new.id and r.config->>'method'='other')
  and not exists(select 1 from private.launch_batch_other_proofs p where p.generation_id=new.id and p.fence=new.fence)then
  raise exception 'WRONG_STATE'using errcode='55000';
 end if;
 return new;
end $$;
create trigger launch_batch_other_proof before update of state on public.team_launch_generations for each row execute function private.require_launch_batch_other_proof();
create function public.service_publish_launch_batch_other_generation(p_team uuid,p_actor uuid,p_generation uuid,p_owner text,p_fence text)returns jsonb language plpgsql security definer set search_path=''as $$
declare g public.team_launch_generations%rowtype;
begin
 if private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 perform 1 from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team)for update;
 select*into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or g.actor_id<>p_actor or g.state<>'running'or g.lease_owner is distinct from p_owner or g.fence::text is distinct from p_fence or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from private.launch_batch_items i join public.team_launch_revisions r on r.id=g.revision_id where i.generation_id=g.id and r.config->>'method'='other')then raise exception 'LEASE_MISMATCH'using errcode='55000';end if;
 insert into private.launch_batch_other_proofs(generation_id,fence)values(g.id,g.fence)on conflict(generation_id)do update set fence=excluded.fence;
 return public.service_publish_launch_generation(p_team,p_generation,p_actor,p_fence);
end $$;
do $settler$declare d text;needle text:='(r.config->>''method''=''other'' or exists';begin
 select pg_get_functiondef('public.service_settle_launch_batch(integer)'::regprocedure)into d;
 if strpos(d,needle)=0 then raise exception 'LAUNCH_BATCH_SETTLER_SEAM_CHANGED';end if;
 d:=replace(d,needle,'((r.config->>''method''=''other'' and not exists(select 1 from private.launch_batch_items batch_member where batch_member.generation_id=x.id)) or exists');
 execute d;
end $settler$;
-- Wrap the established due predicate in-place without renaming a live function.
create function public.service_record_launch_batch_other_failure(p_team uuid,p_actor uuid,p_generation uuid,p_owner text,p_fence text,p_code text,p_transient boolean,p_retry_after_ms integer default 0)returns void language plpgsql security definer set search_path=''as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;
begin
 if p_actor is null or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select*into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team)for update;
 select*into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or g.actor_id<>p_actor or g.state<>'running'or g.lease_owner is distinct from p_owner or g.fence::text is distinct from p_fence or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from private.launch_batch_items i join public.team_launch_revisions r on r.id=g.revision_id where i.generation_id=g.id and r.config->>'method'='other')then raise exception 'LEASE_MISMATCH'using errcode='55000';end if;
 if p_retry_after_ms is null or p_retry_after_ms not between 0 and 1000000000 or not exists(select 1 from public.team_error_codes where code=p_code)then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 update public.team_launch_generations set state=case when p_transient then 'interrupted'else 'failed'end,safe_error_code=p_code,retryable=p_transient,
  lease_owner=null,lease_expires_at=null,next_attempt_at=case when p_transient then clock_timestamp()+make_interval(secs=>greatest(30,p_retry_after_ms/1000.0)::double precision)else null end,state_version=state_version+1,updated_at=clock_timestamp()where id=g.id;
 perform private.launch_signal(p_team,l.id,l.aggregate_version);
end $$;
-- Preserve the provider floor in the same transaction as interruption. The
-- original command remains available for callers without a provider cooldown.
create function public.service_interrupt_launch_generation_with_backoff(p_team uuid,p_generation uuid,p_actor uuid,p_owner text,p_fence text,p_code text,p_retry_after_ms integer)returns void language plpgsql security definer set search_path=''as $$
declare g public.team_launch_generations%rowtype;
begin
 if p_actor is null or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if p_retry_after_ms is null or p_retry_after_ms not between 0 and 1000000000 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 perform 1 from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team)for update;
 select*into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or g.actor_id<>p_actor or g.state<>'running'or g.lease_owner is distinct from p_owner or g.fence::text is distinct from p_fence or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()then raise exception 'LEASE_MISMATCH'using errcode='55000';end if;
 perform public.service_interrupt_launch_generation(p_team,p_generation,p_actor,p_owner,p_fence,p_code);
 update public.team_launch_generations set next_attempt_at=greatest(next_attempt_at,clock_timestamp()+make_interval(secs=>p_retry_after_ms/1000.0::double precision))where id=g.id;
end $$;
revoke all on function public.service_interrupt_launch_generation_with_backoff(uuid,uuid,uuid,text,text,text,integer)from public,anon,authenticated;
grant execute on function public.service_interrupt_launch_generation_with_backoff(uuid,uuid,uuid,text,text,text,integer)to service_role;
do $due$declare body text;begin
 select prosrc into body from pg_proc where oid='private.launch_catalog_recovery_due()'::regprocedure;
 body:=regexp_replace(btrim(body),';[[:space:]]*$','');
 execute format('create or replace function private.launch_catalog_recovery_due()returns boolean language sql stable security definer set search_path='''' as %L','select ('||body||') or jsonb_array_length(public.service_list_launch_batch_other_recovery(1))>0 or exists(select 1 from private.launch_batch_items where admission_pending and admission_next_attempt_at<=clock_timestamp()and(admission_lease_expires_at is null or admission_lease_expires_at<=clock_timestamp())) or exists(select 1 from private.launch_batch_items where cancel_pending and(cancel_next_attempt_at is null or cancel_next_attempt_at<=clock_timestamp()))');
end $due$;
revoke all on function private.validate_launch_batch_intent(uuid,uuid,jsonb),private.normalize_launch_batch_config(jsonb),private.launch_batch_json(uuid)from public,anon,authenticated,service_role;
revoke all on function public.service_launch_batch_context(uuid,uuid,uuid,jsonb),public.service_accept_launch_batch(uuid,uuid,uuid,jsonb,jsonb),public.service_list_launch_batch_other_recovery(integer)from public,anon,authenticated;
grant execute on function public.service_launch_batch_context(uuid,uuid,uuid,jsonb),public.service_accept_launch_batch(uuid,uuid,uuid,jsonb,jsonb),public.service_list_launch_batch_other_recovery(integer)to service_role;
revoke all on function public.service_record_launch_batch_other_failure(uuid,uuid,uuid,text,text,text,boolean,integer)from public,anon,authenticated;
grant execute on function public.service_record_launch_batch_other_failure(uuid,uuid,uuid,text,text,text,boolean,integer)to service_role;
revoke all on function public.service_continue_launch_batch_recovery()from public,anon,authenticated;
grant execute on function public.service_continue_launch_batch_recovery()to service_role;
revoke all on function public.get_launch_batch(uuid,uuid),public.list_launch_batches(uuid,integer,timestamptz,uuid),public.cancel_launch_batch(uuid,uuid,uuid,uuid)from public,anon;
grant execute on function public.get_launch_batch(uuid,uuid),public.list_launch_batches(uuid,integer,timestamptz,uuid),public.cancel_launch_batch(uuid,uuid,uuid,uuid)to authenticated;
revoke all on function private.apply_launch_batch_cancellation(uuid,integer),private.require_launch_batch_other_proof()from public,anon,authenticated,service_role;
revoke all on function public.service_settle_launch_batch_cancellations(integer),public.service_publish_launch_batch_other_generation(uuid,uuid,uuid,text,text)from public,anon,authenticated;
grant execute on function public.service_settle_launch_batch_cancellations(integer),public.service_publish_launch_batch_other_generation(uuid,uuid,uuid,text,text)to service_role;
create function private.touch_launch_batch_item()returns trigger language plpgsql set search_path=''as $$begin new.updated_at:=clock_timestamp();return new;end$$;
create trigger launch_batch_item_updated before update of generation_id,error_code,admission_pending,admission_attempts,cancel_pending,cancel_error_code on private.launch_batch_items for each row execute function private.touch_launch_batch_item();
revoke all on function private.touch_launch_batch_item()from public,anon,authenticated,service_role;
-- Content-free command evidence with the exact canonical child joins. A current
-- snapshot is not transition history; timestamps let diagnosis retain that gap.
create view public.analytics_launch_batches with(security_barrier=true)as
 select b.id batch_id,b.team_id,b.actor_id,b.request_key,b.created_at,b.cancel_requested_at,
 i.ordinal,i.launch_id,i.child_request_key,i.generation_id,
 case when i.admission_pending then 'pending'when i.generation_id is null then 'refused'else 'accepted'end admission,
 i.error_code,i.cancel_pending,i.cancel_error_code,i.cancel_next_attempt_at,i.admission_attempts,i.admission_next_attempt_at,
 i.updated_at member_updated_at,count(*)over(partition by b.id)::integer member_count,
 g.state generation_state,g.stage generation_stage,g.safe_error_code generation_error_code,g.updated_at generation_updated_at,
 s.id video_set_id,s.state video_state,s.requested_count video_requested_count,
 case when s.id is not null then(select count(*)::integer from private.catalog_video_variants v where v.video_set_id=s.id and v.state='registered')else null end video_registered_count,
 s.updated_at video_updated_at
 from private.launch_batches b join private.launch_batch_items i on i.batch_id=b.id
 left join public.analytics_launch_generations g on g.generation_id=i.generation_id and g.team_id=b.team_id and g.actor_id=b.actor_id
 left join private.launch_catalog_video_contexts c on c.generation_id=i.generation_id and c.team_id=b.team_id and c.actor_id=b.actor_id
 left join private.catalog_video_sets s on s.id=c.video_set_id and s.team_id=b.team_id and s.actor_id=b.actor_id;
revoke all on public.analytics_launch_batches from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_launch_batches to wishly_analytics_ro;end if;end$$;
revoke all on function private.accept_launch_batch(uuid,uuid,uuid,jsonb,jsonb,boolean,uuid)from public,anon,authenticated,service_role;
revoke all on function public.service_retry_launch_batch_admission(uuid,uuid,uuid,jsonb,jsonb,uuid),public.service_claim_launch_batch_admission_recovery(integer)from public,anon,authenticated;
grant execute on function public.service_retry_launch_batch_admission(uuid,uuid,uuid,jsonb,jsonb,uuid),public.service_claim_launch_batch_admission_recovery(integer)to service_role;
-- Durable commands are conservative material consumers, including references
-- inside frozen JSON. Keep cleanup coverage and its late-reference lock fence.
create trigger task_cleanup_reference_fence before insert or update on private.launch_batches for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.launch_batch_items for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.launch_batch_other_proofs for each row execute function private.guard_task_cleanup_reference();
commit;
