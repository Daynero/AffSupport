-- Explicit permanent deletion removes money; archival is the retaining alternative.
-- Existing public RPCs retain authorization, topology locking and their wire contract.
begin;

drop trigger account_lifecycle_delete_guard on public.team_accounts;
drop trigger account_lifecycle_delete_guard on public.team_account_agents;
drop trigger account_assignment_delete_guard on public.team_accounts;
drop trigger account_assignment_delete_guard on public.team_account_agents;

create function private.account_delete_finance_history(p_team uuid,p_agent uuid,p_account uuid)
returns void language plpgsql security definer set search_path='' as $$
declare identity_text text:=coalesce(p_agent,p_account)::text;
begin
 -- Keep only content-free request tombstones: an old retry/undo must never
 -- replay removed money, including a bulk request that touched this identity.
 update public.team_agent_finance_requests
 set payload='["deleted-account-history"]'::jsonb,result='{"deleted":true}'::jsonb,
     undone_by_request_id=null
 where team_id=p_team and
 (position(identity_text in payload::text)>0 or position(identity_text in result::text)>0);
 delete from public.team_agent_finance_values where team_id=p_team and
   (agent_row_id=p_agent or (p_agent is null and account_id=p_account));
 delete from public.team_agent_finance_events where team_id=p_team and
   (agent_row_id=p_agent or (p_agent is null and account_id=p_account));
 delete from public.team_agent_finance_legacy where team_id=p_team and
   (agent_row_id=p_agent or (p_agent is null and account_id=p_account));
 if p_agent is not null then
   delete from public.team_agent_transfer_events where team_id=p_team and agent_row_id=p_agent;
 end if;
end $$;

create or replace function private.finance_agent_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare assignment record; next_version bigint;
begin
 if tg_op='UPDATE' then
   if new.balance is distinct from old.balance or new.topup is distinct from old.topup then
     raise exception 'FINANCE_CLIENT_UPGRADE_REQUIRED' using errcode='22023';
   end if;
   return new;
 end if;
 if not exists(select 1 from public.teams where id=old.team_id) then return old;end if;
 -- Release current holds, retaining immutable Launch sources and release receipts.
 -- Public mutation entry points already hold the shared workspace topology lock.
 for assignment in
   select x.* from private.team_launch_assignments x
   join public.team_launches l on l.id=x.launch_id and l.team_id=x.team_id
   where x.team_id=old.team_id and x.agent_row_id=old.id
   order by x.launch_id for update of l,x
 loop
   next_version:=assignment.version+1;
   update private.team_launch_assignments set agent_row_id=null,state='released',
     version=next_version,updated_at=clock_timestamp(),updated_by=auth.uid()
   where launch_id=assignment.launch_id and team_id=old.team_id;
   insert into private.team_launch_assignment_events
     (team_id,launch_id,agent_row_id,previous_agent_row_id,state,previous_state,
      version,actor_id,action,request_key)
   values(old.team_id,assignment.launch_id,null,old.id,'released',assignment.state,
     next_version,auth.uid(),'release',gen_random_uuid()::text);
   update public.team_launches set aggregate_version=aggregate_version+1,
     updated_at=clock_timestamp() where id=assignment.launch_id
     returning aggregate_version into next_version;
   perform private.launch_signal(old.team_id,assignment.launch_id,next_version);
 end loop;
 perform private.account_delete_finance_history(old.team_id,old.id,null);
 delete from public.team_account_lifecycle_events where team_id=old.team_id and entity_id=old.id;
 delete from public.team_account_parent_history where team_id=old.team_id and agent_row_id=old.id;
 return old;
end $$;

create or replace function private.finance_account_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.teams where id=old.team_id) then return old;end if;
 perform private.account_delete_finance_history(old.team_id,null,old.id);
 delete from public.team_account_lifecycle_events where team_id=old.team_id and entity_id=old.id;
 delete from public.team_account_parent_history where team_id=old.team_id and account_id=old.id;
 -- Child RK triggers delete their own history and release holds. A moved RK
 -- remains elsewhere; its historical transfer snapshots survive SET NULL FKs.
 return old;
end $$;

revoke all on function private.account_delete_finance_history(uuid,uuid,uuid),
 private.finance_agent_guard(),private.finance_account_guard() from public,anon,authenticated;
commit;
