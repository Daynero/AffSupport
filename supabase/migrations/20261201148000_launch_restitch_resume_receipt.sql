-- Read the frozen child preparation without rewinding the parent stage on browser resume.
create function public.get_launch_restitch_preparation(p_team uuid,p_generation uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare g public.team_launch_generations%rowtype;p private.launch_restitch_preparations%rowtype;r public.team_launch_revisions%rowtype;operation uuid;
begin
 perform private.launch_access(p_team,'edit');
 select * into g from public.team_launch_generations where id=p_generation and team_id=p_team;
 if g.id is null or g.actor_id is distinct from auth.uid() then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if g.state in('cancel_requested','canceled_with_cleanup_pending','canceled') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from public.team_launch_revisions where id=g.revision_id;
 if r.config->>'method'<>'catalog' or r.config->'catalog'->>'restitchEnabled'<>'true' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into p from private.launch_restitch_preparations where generation_id=g.id;
 if p.generation_id is null then return null;end if;
 operation:=p.operation_id;
 if operation is null then
  select id into operation from public.team_operations where team_id=p_team and actor_id=g.actor_id and kind='process' and idempotency_key=p.process_key;
 end if;
 return jsonb_build_object('defaults',p.defaults,'draw',p.draw,'processKey',p.process_key,'operationId',operation);
end $$;
revoke all on function public.get_launch_restitch_preparation(uuid,uuid) from public,anon;
grant execute on function public.get_launch_restitch_preparation(uuid,uuid) to authenticated;
