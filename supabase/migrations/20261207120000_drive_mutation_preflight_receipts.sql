-- Only a fresh operation still awaiting metadata preflight can be refused.
-- The row lock serializes this decision against the existing running transition.
create function public.service_fail_drive_mutation_preflight(
 p_operation uuid,p_actor uuid,p_error_code text,p_retryable boolean default false
) returns boolean language plpgsql security definer set search_path='' as $$
declare operation_row public.team_operations%rowtype;
begin
 if p_error_code is null or p_error_code not in (
  'AUTH_REQUIRED','PERMISSION_DENIED','NOT_FOUND','ROOT_ESCAPE','UNSUPPORTED_MEDIA',
  'INVALID_INPUT','INVALID_RESPONSE','NEEDS_REAUTH','DRIVE_UNAVAILABLE','RATE_LIMITED','SPACE_BLOCKED'
 ) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 select * into operation_row from public.team_operations
 where id=p_operation and actor_id=p_actor for update;
 if not found or operation_row.kind not in ('trash','restore')
   or not private.can(operation_row.team_id,'delete',p_actor)
 then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if operation_row.state<>'pending' or exists(
   select 1 from private.team_material_group_intents where operation_id=p_operation
 ) then return false; end if;
 return public.service_transition_team_operation(
   p_operation,'failed','failed',100,null,p_error_code,coalesce(p_retryable,false)
 );
end $$;
revoke all on function public.service_fail_drive_mutation_preflight(uuid,uuid,text,boolean)
 from public,anon,authenticated,service_role;
grant execute on function public.service_fail_drive_mutation_preflight(uuid,uuid,text,boolean) to service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  revoke all on function public.service_fail_drive_mutation_preflight(uuid,uuid,text,boolean) from wishly_analytics_ro;
 end if;
end $$;
