-- A marked native upload can be removed only while its canceled Launch owns
-- the exact terminal operation and no material was registered from the file.
alter table private.team_operation_intents
  drop constraint team_operation_intents_launch_upload_phase_check;
alter table private.team_operation_intents
  add constraint team_operation_intents_launch_upload_phase_check
  check (launch_upload_phase in ('not_started','started','cleaned'));

create function public.service_claim_launch_video_cleanup(p_owner uuid,p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;l public.team_launches%rowtype;g public.team_launch_generations%rowtype;
 o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
 credential uuid;parent_id text;plans jsonb:='[]'::jsonb;
begin
 if p_owner is null or p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id,p.operation_id,p.process_key from public.team_launch_generations x
  join private.launch_restitch_preparations p on p.generation_id=x.id
  where x.state in('cancel_requested','canceled_with_cleanup_pending')
   and (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_generation_intents c where c.team_id=x.team_id
    and c.request_key='launch:'||x.id::text||':catalog')
  order by x.updated_at,x.id limit p_limit*4
 loop
  exit when jsonb_array_length(plans)>=p_limit;
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;
  if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending')
   or g.next_attempt_at>clock_timestamp() or g.lease_expires_at>clock_timestamp() then continue;end if;
  select * into o from public.team_operations child where child.team_id=g.team_id and child.actor_id=g.actor_id
   and (child.id=candidate.operation_id or child.idempotency_key=candidate.process_key)
   order by child.created_at desc,child.id desc limit 1 for update skip locked;
  if not found or o.kind<>'process' or o.state not in('failed','canceled')
   or o.result_material_id is not null then continue;end if;
  select * into i from private.team_operation_intents where operation_id=o.id and team_id=g.team_id for update skip locked;
  if not found or i.tool_id is distinct from 'restitch' or i.launch_upload_phase is distinct from 'started'
   or i.expected_size is null then continue;end if;
  select c.credential_id,coalesce(folder.drive_file_id,c.root_folder_id) into credential,parent_id
   from public.team_materials source
   join public.team_drive_connections c on c.id=source.connection_id and c.team_id=g.team_id
   left join public.team_materials folder on folder.id=o.destination_folder_id
    and folder.team_id=g.team_id and folder.connection_id=c.id and folder.kind='folder'
   where source.id=o.source_material_id and source.team_id=g.team_id
    and (o.destination_folder_id is null or folder.id is not null);
  if credential is null or parent_id is null then continue;end if;
  update public.team_launch_generations set state='canceled_with_cleanup_pending',stage='cleanup',
   lease_owner=p_owner::text,lease_expires_at=clock_timestamp()+interval '180 seconds',
   next_attempt_at=clock_timestamp()+interval '180 seconds',fence=fence+1,state_version=state_version+1,
   updated_at=clock_timestamp() where id=g.id returning * into g;
  plans:=plans||jsonb_build_array(jsonb_build_object('teamId',g.team_id,'generationId',g.id,
   'operationId',o.id,'fence',g.fence::text,'credentialId',credential,'parentId',parent_id));
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);
 end loop;
 return plans;
end $$;

create function public.service_authorize_launch_video_cleanup(p_team uuid,p_generation uuid,
 p_operation uuid,p_owner uuid,p_fence text,p_file text)
returns text language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;p private.launch_restitch_preparations%rowtype;
 o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
begin
 if p_team is null or p_generation is null or p_operation is null or p_owner is null
  or p_fence is null or p_file is null or char_length(p_file) not between 1 and 200 then return 'unknown';end if;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 if g.id is null or g.state<>'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text
  or g.fence::text is distinct from p_fence or g.lease_expires_at is null
  or g.lease_expires_at<=clock_timestamp() then return 'unknown';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id;
 select * into o from public.team_operations where id=p_operation and team_id=p_team and actor_id=g.actor_id;
 select * into i from private.team_operation_intents where operation_id=p_operation and team_id=p_team;
 if p.generation_id is null or not (p.operation_id=o.id or p.process_key=o.idempotency_key)
  or o.id is null or o.kind<>'process' or o.state not in('failed','canceled')
  or o.result_material_id is not null or i.operation_id is null or i.tool_id is distinct from 'restitch'
  or i.launch_upload_phase is distinct from 'started' or i.expected_size is null
  or (i.provider_result_id is not null and i.provider_result_id is distinct from p_file)
  or exists(select 1 from public.team_materials m where m.drive_file_id=p_file)
 then return 'unknown';end if;
 return 'owned_unpublished';
end $$;

create function public.service_finish_launch_video_cleanup(p_team uuid,p_generation uuid,
 p_operation uuid,p_owner uuid,p_fence text,p_cleaned_file text default null)
returns text language plpgsql security definer set search_path='' as $$
declare l public.team_launches%rowtype;g public.team_launch_generations%rowtype;
 o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
begin
 if p_owner is null or p_fence is null then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations
  where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into o from public.team_operations where id=p_operation and team_id=p_team for update;
 select * into i from private.team_operation_intents where operation_id=p_operation and team_id=p_team for update;
 if l.id is null or g.id is null or o.id is null or i.operation_id is null
  or g.state<>'canceled_with_cleanup_pending' or g.lease_owner is distinct from p_owner::text
  or g.fence::text is distinct from p_fence or g.lease_expires_at is null
  or g.lease_expires_at<=clock_timestamp() then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
 if p_cleaned_file is not null then
  if public.service_authorize_launch_video_cleanup(p_team,p_generation,p_operation,p_owner,p_fence,p_cleaned_file)<>'owned_unpublished'
   then raise exception 'LEASE_MISMATCH' using errcode='55000';end if;
  update private.team_operation_intents set launch_upload_phase='cleaned',updated_at=clock_timestamp()
   where operation_id=o.id;
 end if;
 update public.team_launch_generations set state='canceled_with_cleanup_pending',stage='cleanup',
  lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp(),state_version=state_version+1,
  updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return case when p_cleaned_file is null then 'pending' else 'cleaned' end;
end $$;

revoke all on function public.service_claim_launch_video_cleanup(uuid,integer),
 public.service_authorize_launch_video_cleanup(uuid,uuid,uuid,uuid,text,text),
 public.service_finish_launch_video_cleanup(uuid,uuid,uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.service_claim_launch_video_cleanup(uuid,integer),
 public.service_authorize_launch_video_cleanup(uuid,uuid,uuid,uuid,text,text),
 public.service_finish_launch_video_cleanup(uuid,uuid,uuid,uuid,text,text)
 to service_role;

create or replace function public.service_settle_launch_restitch_cancellations(p_limit integer default 3) returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record;g public.team_launch_generations%rowtype;l public.team_launches%rowtype;p private.launch_restitch_preparations%rowtype;op record;settled boolean;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id from public.team_launch_generations x join private.launch_restitch_preparations prep on prep.generation_id=x.id
  where x.state in('cancel_requested','canceled_with_cleanup_pending')
   and (x.next_attempt_at is null or x.next_attempt_at<=clock_timestamp())
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and not exists(select 1 from private.catalog_generation_intents i where i.team_id=x.team_id and i.request_key='launch:'||x.id::text||':catalog')
  order by x.updated_at,x.id limit p_limit
 loop
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('cancel_requested','canceled_with_cleanup_pending')
   or g.next_attempt_at>clock_timestamp() or g.lease_expires_at>clock_timestamp() then continue;end if;
  select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
  settled:=true;
  for op in select o.*,i.expected_size,i.provider_result_id,i.tool_id,i.launch_upload_phase from public.team_operations o
   left join private.team_operation_intents i on i.operation_id=o.id and i.team_id=g.team_id
   where o.team_id=g.team_id and (o.id=p.operation_id or o.idempotency_key=p.process_key or exists(
    select 1 from public.team_launch_generation_steps s where s.generation_id=g.id and s.team_operation_id=o.id))
   for update of o
  loop
   if op.actor_id is distinct from g.actor_id or op.kind<>'process' or op.tool_id is distinct from 'restitch'
    or op.state not in('failed','canceled') or
    (op.expected_size is not null and op.launch_upload_phase is distinct from 'not_started'
      and op.launch_upload_phase is distinct from 'cleaned')
    or (op.provider_result_id is not null and op.launch_upload_phase is distinct from 'cleaned')
    or op.result_material_id is not null then settled:=false;end if;
  end loop;
  update public.team_launch_generations set state=case when settled then 'canceled' else 'canceled_with_cleanup_pending' end,
   stage=case when settled then 'cancel' else 'cleanup' end,safe_error_code=case when settled then null else 'LAUNCH_RESULT_UNCERTAIN' end,
   state_version=state_version+1,next_attempt_at=case when settled then null else clock_timestamp()+interval '5 minutes' end,
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where id=g.id;
  if settled then update public.team_launch_generation_steps set state='canceled',updated_at=clock_timestamp() where generation_id=g.id and state in('pending','running');end if;
  perform private.launch_signal(g.team_id,g.launch_id,l.aggregate_version);n:=n+1;
 end loop;
 return n;
end $$;
