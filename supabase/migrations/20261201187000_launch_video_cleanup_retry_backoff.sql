-- Unknown Drive results are retryable, but not on every scheduler tick.
-- A confirmed trash wakes provider-free settlement on the next tick.
create or replace function public.service_finish_launch_video_cleanup(p_team uuid,p_generation uuid,
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
  lease_owner=null,lease_expires_at=null,
  next_attempt_at=case when p_cleaned_file is null then clock_timestamp()+interval '5 minutes'
   else clock_timestamp() end,
  state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 return case when p_cleaned_file is null then 'pending' else 'cleaned' end;
end $$;
