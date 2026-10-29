-- A lost agent quiescence acknowledgment must not permanently strand a fully
-- uploaded video. The service worker may prove completion from exact marked
-- provider metadata under its existing cleanup lease. Never infer it from time.
alter table private.team_operation_intents drop constraint team_operation_intents_launch_upload_phase_check;
alter table private.team_operation_intents add constraint team_operation_intents_launch_upload_phase_check
 check(launch_upload_phase in('not_started','started','cleaned','retained'));
create function public.service_prove_launch_video_upload(p_team uuid,p_generation uuid,p_operation uuid,
 p_owner uuid,p_fence text,p_file text,p_size bigint,p_checksum text,p_mime text) returns text
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
 retained boolean;
begin
 -- Match cleanup's aggregate/generation/operation lock order.
 perform 1 from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 select * into o from public.team_operations where id=p_operation and team_id=p_team for update;
 select * into i from private.team_operation_intents where operation_id=p_operation and team_id=p_team for update;
 if g.id is null or o.id is null or i.operation_id is null or g.state<>'canceled_with_cleanup_pending'
  or p_owner is null or p_fence is null or g.lease_owner is distinct from p_owner::text
  or g.fence::text is distinct from p_fence or g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp()
  or o.actor_id is distinct from g.actor_id or o.kind<>'process' or o.state not in('failed','canceled')
  or o.result_material_id is not null or i.tool_id is distinct from 'restitch' or i.launch_upload_phase is distinct from 'started'
  or p_file is null or char_length(p_file) not between 1 and 200
  or p_size is null or p_size<=0 or i.expected_size is distinct from p_size
  or p_checksum is null or p_checksum !~ '^[a-f0-9]{32}$' or i.mime_type is distinct from p_mime
  or (i.provider_result_id is not null and i.provider_result_id is distinct from p_file)
  or not exists(select 1 from private.launch_restitch_preparations p where p.generation_id=g.id and p.team_id=g.team_id
   and p.actor_id=g.actor_id and (p.operation_id=o.id or p.process_key=o.idempotency_key))
  or exists(select 1 from public.team_materials m where m.id=o.source_material_id and m.drive_file_id=p_file)
 then return 'unknown';end if;
 -- A cataloged file may already be in use. Retain it; cancellation must never
 -- trash a registered material merely because the original finalize failed.
 retained:=exists(select 1 from public.team_materials m where m.drive_file_id=p_file);
 update private.team_operation_intents set provider_result_id=p_file,
  launch_upload_quiesced_at=coalesce(launch_upload_quiesced_at,clock_timestamp()),
  launch_upload_phase=case when retained then 'retained' else 'started' end,updated_at=clock_timestamp()
  where operation_id=o.id;
 if retained then
  update public.team_launch_generation_steps set checkpoint=coalesce(checkpoint,'{}'::jsonb)||'{"cleanupOutcome":"retained_catalog_material"}'::jsonb,
   updated_at=clock_timestamp() where generation_id=g.id and team_operation_id=o.id;
 end if;
 return case when retained then 'retained' else 'complete' end;
end $$;
revoke all on function public.service_prove_launch_video_upload(uuid,uuid,uuid,uuid,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.service_prove_launch_video_upload(uuid,uuid,uuid,uuid,text,text,bigint,text,text) to service_role;

-- The worker may inspect provider completion even if the one-shot agent receipt
-- was lost. Incomplete bytes still stay pending with the existing bounded backoff.
do $migration$
declare d text;begin
 d:=pg_get_functiondef('public.service_claim_launch_video_cleanup(uuid,integer)'::regprocedure);
 if position('or i.launch_upload_quiesced_at is null' in d)=0 then raise exception 'Launch cleanup claim seam changed';end if;
 execute replace(d,'or i.launch_upload_quiesced_at is null','');
 d:=pg_get_functiondef('private.launch_cleanup_due()'::regprocedure);
 if position('and i.launch_upload_quiesced_at is not null' in d)=0 then raise exception 'Launch cleanup dispatch seam changed';end if;
 d:=replace(d,'and i.launch_upload_quiesced_at is not null','');
 d:=replace(d,'''not_started'',''cleaned''','''not_started'',''cleaned'',''retained''');
 execute d;
 d:=pg_get_functiondef('public.service_settle_launch_restitch_cancellations(integer)'::regprocedure);
 if position('op.launch_upload_phase is distinct from ''cleaned''' in d)=0 then raise exception 'Launch cancellation settlement seam changed';end if;
 d:=replace(d,'op.launch_upload_phase is distinct from ''cleaned''','op.launch_upload_phase is distinct from ''cleaned'' and op.launch_upload_phase is distinct from ''retained''');
 execute d;
 d:=pg_get_functiondef('public.service_finish_launch_video_cleanup(uuid,uuid,uuid,uuid,text,text)'::regprocedure);
 if position('when p_cleaned_file is null then clock_timestamp()' in d)=0 then raise exception 'Launch cleanup retry seam changed';end if;
 d:=replace(d,'when p_cleaned_file is null then clock_timestamp()',
   'when p_cleaned_file is null and i.launch_upload_phase is distinct from ''retained'' then clock_timestamp()');
 execute d;
end $migration$;
