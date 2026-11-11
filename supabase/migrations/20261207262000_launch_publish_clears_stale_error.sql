-- A launch generation can be interrupted by a lost lease (LEASE_MISMATCH)
-- while another executor carries it to the end. Publishing then marked it
-- succeeded but kept the stale safe_error_code and left the step that was
-- running when the lease moved ('catalog_sharing') in state 'running', so the
-- launch read as stopped with an error although its catalog was committed
-- (beta 2026-11-11, scenario S9b). A successful publish now clears the error
-- and settles every step that is still running.
begin;
do $publish$
declare d text;
begin
 select pg_get_functiondef('public.service_publish_launch_generation(uuid,uuid,uuid,text)'::regprocedure) into d;
 if strpos(d,$find$update public.team_launch_generations set state='succeeded',stage='result_committed',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;$find$)=0 then raise exception 'LAUNCH_PUBLISH_PATCH_MISSING';end if;
 d:=replace(d,$find$update public.team_launch_generations set state='succeeded',stage='result_committed',state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;$find$,$replace$update public.team_launch_generations set state='succeeded',stage='result_committed',safe_error_code=null,state_version=state_version+1,updated_at=clock_timestamp() where id=g.id;
  update public.team_launch_generation_steps set state='succeeded',updated_at=clock_timestamp() where generation_id=g.id and state='running';$replace$);
 execute d;
end $publish$;
commit;
