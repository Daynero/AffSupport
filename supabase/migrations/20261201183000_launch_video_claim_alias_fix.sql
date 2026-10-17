-- Preserve a forward correction for local stacks that applied 182000 before its claim query alias was fixed.
create or replace function public.service_claim_launch_video_cleanup(p_owner uuid,p_limit integer default 3)
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
