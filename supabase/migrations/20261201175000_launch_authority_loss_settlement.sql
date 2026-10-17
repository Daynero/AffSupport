-- Revoked actors must not occupy every bounded recovery slot indefinitely.
-- This records lost authority, not completion of any still-running native child.
create function public.service_settle_launch_authority_losses(p_limit integer default 3) returns integer
language plpgsql security definer set search_path='' as $$
declare candidate record;l public.team_launches%rowtype;g public.team_launch_generations%rowtype;code text;n integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for candidate in select x.id,x.launch_id from public.team_launch_generations x
  where x.state in('accepted','running','waiting_dependency','interrupted')
   and (x.lease_expires_at is null or x.lease_expires_at<=clock_timestamp())
   and not private.can(x.team_id,'edit',x.actor_id)
  order by x.updated_at,x.id limit p_limit
 loop
  select * into l from public.team_launches where id=candidate.launch_id for update skip locked;
  if not found then continue;end if;
  select * into g from public.team_launch_generations where id=candidate.id for update skip locked;
  if not found or g.state not in('accepted','running','waiting_dependency','interrupted')
   or g.lease_expires_at>clock_timestamp() or private.can(g.team_id,'edit',g.actor_id) then continue;end if;
  code:=case when not private.team_workspace_allowed(g.team_id) then 'SPACE_BLOCKED' else 'PERMISSION_DENIED' end;
  update public.team_launch_generations set state='failed',safe_error_code=code,retryable=false,
   state_version=state_version+1,lease_owner=null,lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where id=g.id returning * into g;
  insert into public.team_launch_generation_steps(team_id,generation_id,stage,stable_step_key,state,fence,safe_error_code)
   values(g.team_id,g.id,g.stage,'authority:'||g.state_version::text,'failed',g.fence,code);
  perform private.launch_signal(g.team_id,l.id,l.aggregate_version);n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.service_settle_launch_authority_losses(integer) from public,anon,authenticated;
grant execute on function public.service_settle_launch_authority_losses(integer) to service_role;

alter function private.launch_catalog_recovery_due() rename to launch_catalog_recovery_due_without_authority;
create function private.launch_catalog_recovery_due() returns boolean
language sql stable security definer set search_path='' as $$
 select private.launch_catalog_recovery_due_without_authority() or exists(
  select 1 from public.team_launch_generations g
  where g.state in('accepted','running','waiting_dependency','interrupted')
   and (g.lease_expires_at is null or g.lease_expires_at<=clock_timestamp())
   and not private.can(g.team_id,'edit',g.actor_id))
$$;
revoke all on function private.launch_catalog_recovery_due() from public,anon,authenticated,service_role;
