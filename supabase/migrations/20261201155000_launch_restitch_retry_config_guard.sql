-- A retry consumes the accepted configuration, never silently discards newer saved edits.
create or replace function public.retry_launch_restitch(p_team uuid,p_generation uuid,p_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;l public.team_launches%rowtype;r public.team_launch_revisions%rowtype;
 p private.launch_restitch_preparations%rowtype;o public.team_operations%rowtype;payload jsonb:=jsonb_build_array(p_generation);replay jsonb;result jsonb;fresh jsonb;
begin
 perform private.launch_access(p_team,'edit');
 if not private.can(p_team,'download',auth.uid()) or not private.can(p_team,'upload',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 replay:=private.launch_request(p_team,p_key,'restitch-retry',payload);if replay is not null then return replay;end if;
 select * into l from public.team_launches where id=(select launch_id from public.team_launch_generations where id=p_generation and team_id=p_team) and archived_at is null for update;
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team for update;
 if g.id is null or l.id is null or g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state<>'failed' or g.stage<>'restitch_processing' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id for update;
 select * into o from public.team_operations where id=p.operation_id and team_id=p_team for update;
 if o.id is null or o.state not in('failed','canceled') or p.process_attempt>=100 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if l.draft_config is distinct from r.config then raise exception 'LAUNCH_VERSION_CONFLICT' using errcode='40001';end if;
 fresh:=private.launch_sources_from_config(p_team,r.config,auth.uid());
 if private.launch_material_identity(fresh) is null or private.launch_material_identity(fresh) is distinct from private.launch_material_identity(r.sources) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.launch_restitch_preparations set process_attempt=process_attempt+1,
  process_key='launch-restitch:'||g.id::text||':'||(process_attempt+1)::text,operation_id=null,updated_at=clock_timestamp() where generation_id=g.id returning * into p;
 update public.team_launch_generations set state='waiting_dependency',stage='restitch_preparing',safe_error_code=null,retryable=false,
  lease_owner=null,lease_expires_at=null,next_attempt_at=null,fence=fence+1,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
 result:=jsonb_build_object('generationId',g.id,'processKey',p.process_key);
 perform private.launch_signal(p_team,g.launch_id,l.aggregate_version);
 perform private.launch_remember(p_team,p_key,'restitch-retry',payload,result);
 return result;
end $$;
