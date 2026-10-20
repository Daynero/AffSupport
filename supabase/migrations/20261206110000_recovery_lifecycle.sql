-- Observe existing queue receipts; never infer output delivery from a queued job.
begin;
-- Permission revocation must survive a later re-add, even while the tariff is paused.
-- This helper only revokes; actual execution still uses canonical effective_permissions.
create function private.recovery_member_allowed(p_team uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select private.team_profile_active(p_actor) and team.status='active'
   and coalesce(case when team.owner_id<>p_actor then (member.permission_overrides->>'process')::boolean end,permission.allowed,false)
 from public.teams team join public.team_members member on member.team_id=team.id and member.user_id=p_actor and member.status='active'
 left join public.role_permissions permission on permission.permission='process'
   and permission.role=case when team.owner_id=p_actor then 'owner' else member.base_role end
 where team.id=p_team),false);
$$;
create function private.revoke_invalid_recovery_delegations()
returns trigger language plpgsql security definer set search_path='' as $$
declare changed jsonb; actor uuid; team uuid;
begin
 changed:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name='team_members' then actor:=(changed->>'user_id')::uuid;team:=(changed->>'team_id')::uuid;
 elsif tg_table_name='profiles' then actor:=(changed->>'id')::uuid;
 elsif tg_table_name='teams' then team:=(changed->>'id')::uuid;
 end if;
 update private.team_recovery_delegations delegation set revoked_at=clock_timestamp(),version=version+1
 where revoked_at is null and (actor is null or delegation.actor_id=actor) and (team is null or delegation.team_id=team)
   and not private.recovery_member_allowed(delegation.team_id,delegation.actor_id);
 return null;
end $$;
create trigger recovery_membership_revoked after update of status,base_role,permission_overrides or delete on public.team_members
for each row execute function private.revoke_invalid_recovery_delegations();
create trigger recovery_profile_revoked after update of account_status or delete on public.profiles
for each row execute function private.revoke_invalid_recovery_delegations();
create trigger recovery_role_revoked after update of allowed or delete on public.role_permissions
for each row execute function private.revoke_invalid_recovery_delegations();
create trigger recovery_team_revoked after update of status,owner_id on public.teams
for each row execute function private.revoke_invalid_recovery_delegations();
revoke all on function private.recovery_member_allowed(uuid,uuid),private.revoke_invalid_recovery_delegations() from public,anon,authenticated,service_role;

create function private.observe_workspace_dependencies(p_team uuid)
returns void language plpgsql security definer set search_path='' as $$
declare item record; reason text;
begin
 for item in select recovery.id as recovery_item_id,recovery.operation_id as recovery_operation_id,snapshot.* from private.workspace_recovery_items recovery
   join private.workspace_pause_items snapshot on snapshot.id=recovery.pause_item_id
   join private.workspace_recoveries cycle on cycle.id=recovery.recovery_id
   where recovery.team_id=p_team and cycle.state<>'superseded' and recovery.state not in ('completed','skipped_manual','superseded')
 loop
  reason:=null;
  if item.kind='restitch' then
   if exists(select 1 from public.team_catalog_updater_items where catalog_material_id=item.resource_id and config_generation<>item.config_generation) then
    update private.workspace_recovery_items set state='superseded',stage='terminal',reason_code='superseded',updated_at=clock_timestamp() where id=item.recovery_item_id;
    continue;
   end if;
   if not exists(select 1 from public.team_materials source where source.id=item.source_material_id and source.lifecycle='active') then reason:='source_missing';
   elsif not exists(select 1 from public.team_materials sheet join public.team_materials source on source.id=sheet.companion_of
     where sheet.id=item.resource_id and source.id=item.source_material_id and source.drive_version is not distinct from item.source_version) then reason:='source_changed';
   elsif exists(select 1 from public.team_catalog_restitch_copies where catalog_material_id=item.resource_id and role='spare') then
    update private.workspace_recovery_items set state='completed',stage='terminal',reason_code=null,finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=item.recovery_item_id;
    continue;
   elsif exists(select 1 from public.team_operations where id=coalesce(item.recovery_operation_id,item.operation_id) and state='canceled') then reason:='user_cancelled';
   elsif exists(select 1 from public.team_operations where id=coalesce(item.recovery_operation_id,item.operation_id) and state='failed' and not retryable) then reason:='unknown';
   elsif not exists(select 1 from public.team_catalog_updater_items where catalog_material_id=item.resource_id and (update_interval is not null or round_due_at is not null or tariff_pause_id is not null)) then reason:='manually_disabled';
   elsif not exists(select 1 from private.team_recovery_delegations delegation where team_id=p_team and revoked_at is null and expires_at>clock_timestamp()
     and private.recovery_actor_allowed(p_team,delegation.actor_id)) then reason:='needs_agent_setup';
   elsif not exists(select 1 from private.team_recovery_delegations where team_id=p_team and revoked_at is null
     and greatest(last_claim_at,last_probe_at)>clock_timestamp()-interval '90 seconds') then reason:='waiting_agent';
   elsif exists(select 1 from private.catalog_restitch_operations previous join public.team_operations operation on operation.id=previous.operation_id
     where previous.catalog_material_id=item.resource_id and operation.state in ('pending','running')
      and not exists(select 1 from private.team_recovery_credentials credential where credential.operation_id=operation.id and audience='execute' and credential.expires_at>clock_timestamp())) then reason:='checkpoint_unavailable';
   else
    update private.workspace_recovery_items set state='leased',reason_code=null,stage='queued',updated_at=clock_timestamp() where id=item.recovery_item_id and state='waiting_dependency';
    continue;
   end if;
  elsif item.kind in ('preview','archive') then
   if not exists(select 1 from public.team_materials where id=item.resource_id and lifecycle='active') then reason:='source_missing';
   elsif exists(select 1 from public.team_materials where id=item.resource_id and drive_version is distinct from item.source_version) then reason:='source_changed';
   elsif exists(select 1 from public.team_materials where id=item.resource_id and
     ((item.kind='preview' and provider_thumbnail_state='ready') or (item.kind='archive' and landing_validation_state is not null))) then
    update private.workspace_recovery_items set state='completed',stage='terminal',finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=item.recovery_item_id;continue;
   end if;
  elsif item.kind='sync' then
   if exists(select 1 from private.catalog_sync_jobs where connection_id=item.resource_id and state='succeeded' and completed_at>=item.captured_at) then
    update private.workspace_recovery_items set state='completed',stage='terminal',finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=item.recovery_item_id;continue;
   elsif exists(select 1 from private.catalog_sync_jobs where connection_id=item.resource_id and state='leased') then
    update private.workspace_recovery_items set state='resumed',stage='started',started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() where id=item.recovery_item_id and state='leased';continue;
   end if;
  elsif item.kind='cleanup' then
   if exists(select 1 from public.team_operations where team_id=p_team and source_material_id=item.resource_id and kind='trash' and state='succeeded' and finished_at>=item.captured_at) then
    update private.workspace_recovery_items set state='completed',stage='terminal',finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=item.recovery_item_id;continue;
   end if;
  end if;
  if reason is not null then
   update private.workspace_recovery_items set state=case when reason in ('manually_disabled','user_cancelled') then 'skipped_manual' when reason in ('source_missing','source_changed','checkpoint_unavailable','unknown') then 'blocked' else 'waiting_dependency' end,
    reason_code=reason,updated_at=clock_timestamp() where id=item.recovery_item_id and reason_code is distinct from reason;
  end if;
 end loop;
 perform private.refresh_workspace_recovery(p_team);
end $$;

create function private.recovery_dependency_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform private.observe_workspace_dependencies(new.team_id);return null;
end $$;
create trigger recovery_material_progress after update of provider_thumbnail_state,landing_validation_state,lifecycle on public.team_materials
for each row execute function private.recovery_dependency_changed();
create trigger recovery_copy_progress after insert on public.team_catalog_restitch_copies
for each row execute function private.recovery_dependency_changed();

create function public.retry_workspace_recovery(p_recovery uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare team uuid;
begin
 select team_id into team from private.workspace_recoveries where id=p_recovery;
 if not private.can(team,'process',auth.uid()) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 update private.workspace_recovery_items set state='pending',stage='registered',reason_code=null,attempts=0,next_attempt_at=clock_timestamp()
 where recovery_id=p_recovery and reason_code in ('retry_exhausted','queue_registration_failed');
 perform private.dispatch_workspace_recovery(team);return true;
end $$;
revoke all on function public.retry_workspace_recovery(uuid) from public,anon;
grant execute on function public.retry_workspace_recovery(uuid) to authenticated;
revoke all on function private.observe_workspace_dependencies(uuid),private.recovery_dependency_changed() from public,anon,authenticated,service_role;

-- Read-only diagnostics can resolve a member without accessing membership tables directly.
create or replace view public.analytics_workspace_recovery as
select recovery.id recovery_id,recovery.team_id,recovery.epoch,recovery.state recovery_state,
 recovery.registered_at,recovery.last_progress_at,item.id item_id,item.state,item.stage,item.reason_code,
 item.operation_id,item.attempt_id,item.attempts,item.started_at,item.finished_at,item.delivered_at,item.updated_at,
 snapshot.kind,snapshot.resource_id,snapshot.actor_id,
 array(select user_id from public.team_members where team_id=recovery.team_id and status='active') member_ids
from private.workspace_recoveries recovery join private.workspace_recovery_items item on item.recovery_id=recovery.id
join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id;
create or replace function private.sweep_workspace_recovery()
returns void language plpgsql security definer set search_path='' as $$
declare candidate record;
begin
  perform private.apply_tariff_pauses(null);
  for candidate in select distinct team_id from private.workspace_recoveries where state not in ('completed','superseded') loop
    perform private.dispatch_workspace_recovery(candidate.team_id);
    perform private.observe_workspace_dependencies(candidate.team_id);
  end loop;
  -- Secret-bearing replay receipts have a bounded lifetime. Unresolved operation metadata
  -- remains in the recovery tables; expired native credentials cannot authorize it.
  delete from vault.secrets where id in (
    select rotation_secret_id from private.team_recovery_delegations
      where rotation_replay_until<clock_timestamp()
    union all select response_secret_id from private.team_recovery_claim_receipts
      where created_at<clock_timestamp()-interval '30 days'
  );
  update private.team_recovery_delegations set rotation_secret_id=null
    where rotation_replay_until<clock_timestamp() and rotation_secret_id is not null;
  delete from private.team_recovery_claim_receipts where created_at<clock_timestamp()-interval '30 days';
  delete from private.team_recovery_credentials where expires_at<clock_timestamp();
  delete from private.team_recovery_enrollments where expires_at<clock_timestamp();
  delete from private.team_recovery_rate_buckets where minute<clock_timestamp()-interval '2 minutes';
  -- Retain unresolved pauses forever; only terminal histories are eligible.
  delete from private.workspace_pauses paused using private.workspace_recoveries recovery
   where recovery.pause_id=paused.id and recovery.state in ('completed','superseded')
    and recovery.last_progress_at<clock_timestamp()-interval '30 days'
    and not exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id and state not in ('completed','skipped_manual','superseded'))
    and not exists(select 1 from public.team_catalog_updater_items where tariff_pause_id=paused.id);
end $$;
commit;
