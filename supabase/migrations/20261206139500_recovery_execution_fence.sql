-- A local checkpoint can rewind after a host crash. Execution permission cannot.
begin;
alter function public.service_team_recovery(text,bytea,jsonb) set schema private;
alter function private.service_team_recovery(text,bytea,jsonb) rename to service_team_recovery_core;
revoke all on function private.service_team_recovery_core(text,bytea,jsonb)
 from public,anon,authenticated,service_role;
create table private.team_recovery_execution_fences (
 operation_id uuid primary key references public.team_operations(id) on delete cascade,
 team_id uuid not null,
 actor_id uuid not null,
 job_id uuid not null,
 started_at timestamptz not null default clock_timestamp()
);
alter table private.team_recovery_execution_fences enable row level security;
alter table private.team_recovery_execution_fences force row level security;
revoke all on private.team_recovery_execution_fences from public,anon,authenticated,service_role;

create function public.service_begin_team_recovery_execution(p_hash bytea,p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare authority jsonb; operation public.team_operations; inserted integer;
begin
 -- Reuse the exact credential/audience/epoch/job/current-rights boundary and its
 -- delegation lock. Concurrent starts for the same delegation serialize here.
 authority:=private.service_team_recovery_core('authorize_execute',p_hash,p_input);
 select * into operation from public.team_operations
  where id=(authority->>'operationId')::uuid
   and team_id=(authority->>'teamId')::uuid
   and actor_id=(authority->>'actorId')::uuid for update;
 if operation.id is null or operation.kind<>'process' or operation.state not in ('pending','running') then
  return jsonb_build_object('executionAllowed',false);
 end if;
 insert into private.team_recovery_execution_fences(operation_id,team_id,actor_id,job_id)
 values(operation.id,operation.team_id,operation.actor_id,(authority->>'jobId')::uuid)
 on conflict(operation_id) do nothing;
 get diagnostics inserted=row_count;
 if inserted<>1 then return jsonb_build_object('executionAllowed',false); end if;
 -- Commit the execution fence and normal lifecycle checkpoint together before
 -- replying. A lost response is uncertain, never a second permission to run.
 return private.service_team_recovery_core('checkpoint',p_hash,p_input)
  ||jsonb_build_object('executionAllowed',true);
end $$;
revoke all on function public.service_begin_team_recovery_execution(bytea,jsonb)
 from public,anon,authenticated;
grant execute on function public.service_begin_team_recovery_execution(bytea,jsonb) to service_role;

-- Keep the existing RPC signature fenced too: an older Edge cannot bypass the
-- reservation by calling the original checkpoint action and ignoring a flag.
create function public.service_team_recovery(p_action text,p_hash bytea,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare receipt jsonb;
begin
 if p_action='checkpoint' then
  receipt:=public.service_begin_team_recovery_execution(p_hash,p_input);
  if (receipt->>'executionAllowed')::boolean is distinct from true then
   raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
  end if;
  return receipt;
 end if;
 return private.service_team_recovery_core(p_action,p_hash,p_input);
end $$;
revoke all on function public.service_team_recovery(text,bytea,jsonb) from public,anon,authenticated;
grant execute on function public.service_team_recovery(text,bytea,jsonb) to service_role;

-- Immutable reservation time, not proof of native execution or output delivery.
create view public.analytics_recovery_execution as
 select fence.operation_id,fence.team_id,fence.actor_id,fence.started_at,
  array(select user_id from public.team_members where team_id=fence.team_id and status='active') member_ids
 from private.team_recovery_execution_fences fence;
revoke all on public.analytics_recovery_execution from public,anon,authenticated;
grant select on public.analytics_recovery_execution to service_role;
do $$ begin
 if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_recovery_execution to wishly_analytics_ro;
 end if;
end $$;
commit;
