-- A canceled database operation is not proof that the native uploader has
-- stopped. Cleanup must wait for an explicit post-upload agent receipt.
alter table private.team_operation_intents
  add column launch_upload_quiesced_at timestamptz;

-- The finalization ticket proves possession of the original agent handoff. It
-- may already be revoked by parent cancellation; that revocation must not
-- prevent an acknowledgement that the local upload promise has settled.
create function public.service_ack_launch_upload_quiescence(p_operation uuid,p_token_hash bytea)
returns boolean language plpgsql security definer set search_path='' as $$
declare op public.team_operations%rowtype;
begin
 if p_operation is null or p_token_hash is null or octet_length(p_token_hash)<>32 then return false;end if;
 select * into op from public.team_operations where id=p_operation for update;
 if op.id is null or op.kind<>'process' then return false;end if;
 if not exists(select 1 from private.team_transfer_grants grant_row
   where grant_row.operation_id=op.id and grant_row.team_id=op.team_id
    and grant_row.actor_id=op.actor_id and grant_row.purpose='finalize'
    and grant_row.tool_id='restitch' and grant_row.token_hash=p_token_hash)
  or not exists(select 1 from private.launch_restitch_preparations preparation
    join public.team_launch_generations generation on generation.id=preparation.generation_id
    where generation.team_id=op.team_id and generation.actor_id=op.actor_id
      and (preparation.operation_id=op.id or preparation.process_key=op.idempotency_key))
 then return false;end if;
 update private.team_operation_intents set launch_upload_quiesced_at=coalesce(launch_upload_quiesced_at,clock_timestamp()),
  updated_at=clock_timestamp() where operation_id=op.id and team_id=op.team_id
   and tool_id='restitch' and launch_upload_phase='started';
 return found;
end $$;

revoke all on function public.service_ack_launch_upload_quiescence(uuid,bytea) from public,anon,authenticated;
grant execute on function public.service_ack_launch_upload_quiescence(uuid,bytea) to service_role;

create or replace function public.service_authorize_launch_video_cleanup(p_team uuid,p_generation uuid,
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
  or i.launch_upload_quiesced_at is null
  or (i.provider_result_id is not null and i.provider_result_id is distinct from p_file)
  or exists(select 1 from public.team_materials m where m.drive_file_id=p_file)
 then return 'unknown';end if;
 return 'owned_unpublished';
end $$;
