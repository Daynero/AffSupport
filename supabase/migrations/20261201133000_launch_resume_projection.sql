-- Protected detail carries the accepted request identity so a reload can resume it, not create another intent.
create or replace function public.get_launch(p_team uuid,p_launch uuid,p_revision uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.team_launches%rowtype;g jsonb;
begin
 perform private.launch_access(p_team,'view');select * into r from public.team_launches where team_id=p_team and id=p_launch;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 if p_revision is not null and not exists(select 1 from public.team_launch_revisions where id=p_revision and launch_id=p_launch and team_id=p_team) then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select jsonb_build_object('id',id,'state',state,'stage',stage,'stateVersion',state_version::text,'requestKey',request_key,'inputVersion',input_version,'progress',progress,'errorCode',safe_error_code,'childOperationIds',coalesce((select jsonb_agg(s.team_operation_id) from public.team_launch_generation_steps s where s.generation_id=generation.id and s.team_operation_id is not null),'[]')) into g from public.team_launch_generations generation where generation.launch_id=p_launch order by created_at desc,id desc limit 1;
 return jsonb_build_object('id',r.id,'version',r.aggregate_version::text,'draft',r.draft_config,'expectedSourceSnapshot',r.expected_source_snapshot,'assigneeId',r.assignee_id,'workStatus',r.work_status,'activeRevision',private.launch_revision_json(p_team,coalesce(p_revision,r.active_revision_id)),'generation',g);
end $$;
