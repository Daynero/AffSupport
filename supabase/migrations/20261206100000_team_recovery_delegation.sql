-- Scoped desktop delegation. Handles are hashes; replay responses are encrypted in Vault.
begin;
create table private.team_recovery_enrollments (
 id uuid primary key default gen_random_uuid(),team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,installation_id uuid not null,
 ticket_hash bytea not null check(octet_length(ticket_hash)=32),expires_at timestamptz not null default clock_timestamp()+interval '120 seconds',consumed_at timestamptz
);
create table private.team_recovery_delegations (
 id uuid primary key default gen_random_uuid(),team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,installation_id uuid not null,
 refresh_hash bytea not null unique check(octet_length(refresh_hash)=32),previous_hash bytea,
 rotation_id uuid,rotation_secret_id uuid,rotation_replay_until timestamptz,
 version bigint not null default 1,expires_at timestamptz not null default clock_timestamp()+interval '30 days',
 revoked_at timestamptz,last_claim_at timestamptz,last_probe_at timestamptz,last_rotation_at timestamptz,
 created_at timestamptz not null default clock_timestamp(),unique(id,team_id)
);
create unique index recovery_one_installation on private.team_recovery_delegations(team_id,actor_id,installation_id) where revoked_at is null;
create table private.team_recovery_credentials (
 hash bytea primary key check(octet_length(hash)=32),delegation_id uuid not null references private.team_recovery_delegations(id) on delete cascade,
 version bigint not null,audience text not null check(audience in ('claim','execute')),expires_at timestamptz not null,
 operation_id uuid,job_id uuid,epoch bigint not null default 0,
 check((audience='claim' and operation_id is null and job_id is null) or (audience='execute' and operation_id is not null and job_id is not null))
);
create table private.team_recovery_claim_receipts (
 delegation_id uuid not null references private.team_recovery_delegations(id) on delete cascade,
 request_id uuid not null,state text not null default 'pending' check(state in ('pending','confirmed')),
 response_secret_id uuid,operation_id uuid,created_at timestamptz not null default clock_timestamp(),
 primary key(delegation_id,request_id)
);
create table private.team_recovery_rate_buckets (
 installation_id uuid not null,minute timestamptz not null,kind text not null check(kind in ('claim','probe')),
 count integer not null default 0,primary key(installation_id,minute,kind)
);
do $$ declare name text; begin
 foreach name in array array['team_recovery_enrollments','team_recovery_delegations','team_recovery_credentials','team_recovery_claim_receipts','team_recovery_rate_buckets'] loop
  execute format('alter table private.%I enable row level security',name);
  execute format('alter table private.%I force row level security',name);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',name);
 end loop;
end $$;

create function private.recovery_actor_allowed(p_team uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select private.team_workspace_allowed(p_team) and coalesce((private.effective_permissions(p_team,p_actor)->>'process')::boolean,false);
$$;
create function private.recovery_rate(p_installation uuid,p_kind text,p_limit integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare used integer;
begin
 -- Serialize the installation across delegations; a minute boundary cannot double the budget.
 perform pg_advisory_xact_lock(hashtextextended(p_installation::text || ':' || p_kind,0));
 select coalesce(sum(count),0) into used from private.team_recovery_rate_buckets
 where installation_id=p_installation and kind=p_kind and minute>clock_timestamp()-interval '60 seconds';
 if used>=p_limit then return false; end if;
 insert into private.team_recovery_rate_buckets(installation_id,minute,kind,count)
 values(p_installation,date_trunc('second',clock_timestamp()),p_kind,1)
 on conflict(installation_id,minute,kind) do update set count=private.team_recovery_rate_buckets.count+1;
 return true;
end $$;

-- Every action is closed and credential-specific; only the Edge service can invoke this RPC.
create function public.service_team_recovery(p_action text,p_hash bytea,p_input jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare challenge private.team_recovery_enrollments; delegation private.team_recovery_delegations;
 credential private.team_recovery_credentials; receipt private.team_recovery_claim_receipts;
 resolved uuid; response jsonb; current_epoch bigint; actor uuid; team uuid; installation uuid;
begin
 if p_action not in ('delegate','redeem','rotate','probe','claim','authorize_claim','register_claim','authorize_execute','heartbeat','checkpoint','settle') then raise exception 'INVALID_INPUT'; end if;
 if p_input is null or jsonb_typeof(p_input)<>'object' or pg_column_size(p_input)>262144
  or (p_hash is not null and octet_length(p_hash)<>32) then raise exception 'INVALID_INPUT' using errcode='22023'; end if;
 if p_action='delegate' then
  actor:=(p_input->>'actorId')::uuid;team:=(p_input->>'teamId')::uuid;installation:=(p_input->>'installationId')::uuid;
  if not private.recovery_actor_allowed(team,actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if p_hash is null or installation is null then raise exception 'INVALID_INPUT'; end if;
  -- A fresh explicit setup replaces a lost/unfinished enrollment for this exact installation.
  update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1
   where team_id=team and actor_id=actor and installation_id=installation and revoked_at is null;
  delete from private.team_recovery_enrollments where team_id=team and actor_id=actor and installation_id=installation;
  insert into private.team_recovery_enrollments(team_id,actor_id,installation_id,ticket_hash)
   values(team,actor,installation,p_hash) returning id into resolved;
  return jsonb_build_object('challengeId',resolved);
 elsif p_action='redeem' then
  select * into challenge from private.team_recovery_enrollments where id=(p_input->>'challengeId')::uuid for update;
  if challenge.id is null or challenge.ticket_hash is distinct from p_hash or challenge.consumed_at is not null
    or challenge.expires_at<=clock_timestamp() then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if not private.recovery_actor_allowed(challenge.team_id,challenge.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
  if (p_input->>'refresh') !~ '^[A-Za-z0-9_-]{43}$' or (p_input->>'refreshHash') !~ '^\\x[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
  update private.team_recovery_enrollments set consumed_at=clock_timestamp() where id=challenge.id;
  insert into private.team_recovery_delegations(team_id,actor_id,installation_id,refresh_hash)
   values(challenge.team_id,challenge.actor_id,challenge.installation_id,(p_input->>'refreshHash')::bytea) returning * into delegation;
  return jsonb_build_object('delegationId',delegation.id,'teamId',delegation.team_id,'installationId',delegation.installation_id,
    'refresh',p_input->>'refresh','expiresAt',delegation.expires_at);
 elsif p_action in ('rotate','probe') then
  select * into delegation from private.team_recovery_delegations where refresh_hash=p_hash or previous_hash=p_hash for update;
 else
  select * into credential from private.team_recovery_credentials where hash=p_hash;
  select * into delegation from private.team_recovery_delegations where id=credential.delegation_id for update;
  if credential.hash is null or credential.expires_at<=clock_timestamp() or credential.version<>delegation.version then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 end if;
 if delegation.id is null or delegation.revoked_at is not null or delegation.expires_at<=clock_timestamp() then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 if p_action='probe' then
  if delegation.refresh_hash is distinct from p_hash then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if delegation.last_probe_at>clock_timestamp()-interval '1 minute' or not private.recovery_rate(delegation.installation_id,'probe',6) then raise exception 'RATE_LIMITED'; end if;
  update private.team_recovery_delegations set last_probe_at=clock_timestamp() where id=delegation.id;
  return jsonb_build_object('allowed',private.recovery_actor_allowed(delegation.team_id,delegation.actor_id),'delegationId',delegation.id);
 end if;
 if not private.recovery_actor_allowed(delegation.team_id,delegation.actor_id) then
  if not private.team_workspace_allowed(delegation.team_id) then raise exception 'SPACE_BLOCKED' using errcode='42501'; end if;
  raise exception 'PERMISSION_DENIED' using errcode='42501';
 end if;
 select coalesce(max(epoch),0) into current_epoch from private.workspace_pauses where team_id=delegation.team_id;
 if p_action='rotate' then
  if delegation.previous_hash=p_hash then
   if delegation.rotation_id=(p_input->>'rotationId')::uuid and delegation.rotation_replay_until>clock_timestamp() then
    select decrypted_secret::jsonb into response from vault.decrypted_secrets where id=delegation.rotation_secret_id;return response;
   end if;
   update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1 where id=delegation.id;
   return jsonb_build_object('error','AUTH_REQUIRED'); -- return rather than rollback the revocation
  end if;
  if delegation.last_rotation_at>clock_timestamp()-interval '4 minutes' then raise exception 'RATE_LIMITED'; end if;
  if (p_input->>'refresh') !~ '^[A-Za-z0-9_-]{43}$' or (p_input->>'claim') !~ '^[A-Za-z0-9_-]{43}$'
    or (p_input->>'rotationId') is null then raise exception 'INVALID_INPUT'; end if;
  response:=jsonb_build_object('refresh',p_input->>'refresh','claim',p_input->>'claim','claimExpiresAt',clock_timestamp()+interval '5 minutes',
    'expiresAt',delegation.expires_at,'delegationId',delegation.id);
  resolved:=vault.create_secret(response::text,'soty-recovery-rotation-'||gen_random_uuid()::text,'Scoped recovery replay');
  if delegation.rotation_secret_id is not null then delete from vault.secrets where id=delegation.rotation_secret_id; end if;
  update private.team_recovery_delegations set previous_hash=refresh_hash,refresh_hash=(p_input->>'refreshHash')::bytea,
   rotation_id=(p_input->>'rotationId')::uuid,rotation_secret_id=resolved,rotation_replay_until=clock_timestamp()+interval '60 seconds',
   last_rotation_at=clock_timestamp() where id=delegation.id;
  insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at)
   values((p_input->>'claimHash')::bytea,delegation.id,delegation.version,'claim',clock_timestamp()+interval '5 minutes');
  return response;
 end if;
 if p_action in ('claim','authorize_claim','register_claim') then
  if credential.audience<>'claim' then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 else
  if credential.audience<>'execute' or credential.epoch<>current_epoch
    or (p_input ? 'operationId' and credential.operation_id is distinct from (p_input->>'operationId')::uuid) then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
 end if;
 if p_action='claim' then
  select * into receipt from private.team_recovery_claim_receipts where delegation_id=delegation.id and request_id=(p_input->>'requestId')::uuid for update;
  if receipt.delegation_id is not null then
   if receipt.state='confirmed' then select decrypted_secret::jsonb into response from vault.decrypted_secrets where id=receipt.response_secret_id;return jsonb_build_object('replay',response); end if;
   return jsonb_build_object('pending',true);
  end if;
  if delegation.last_claim_at>clock_timestamp()-interval '30 seconds' or not private.recovery_rate(delegation.installation_id,'claim',12) then raise exception 'RATE_LIMITED'; end if;
  if exists(select 1 from private.team_recovery_claim_receipts where delegation_id=delegation.id and state='pending') then return jsonb_build_object('pending',true); end if;
  insert into private.team_recovery_claim_receipts(delegation_id,request_id) values(delegation.id,(p_input->>'requestId')::uuid);
  update private.team_recovery_delegations set last_claim_at=clock_timestamp() where id=delegation.id;
 elsif p_action='register_claim' then
  select * into receipt from private.team_recovery_claim_receipts where delegation_id=delegation.id and request_id=(p_input->>'requestId')::uuid for update;
  if receipt.delegation_id is null then raise exception 'NOT_FOUND'; end if;
  if receipt.state='confirmed' then select decrypted_secret::jsonb into response from vault.decrypted_secrets where id=receipt.response_secret_id;return response; end if;
  response:=p_input->'response';
  if jsonb_typeof(response)<>'object' then raise exception 'INVALID_INPUT'; end if;
  if response->'job' is distinct from 'null'::jsonb then
   if not exists(select 1 from public.team_operations where id=(response->'job'->>'operationId')::uuid and team_id=delegation.team_id and actor_id=delegation.actor_id) then raise exception 'PERMISSION_DENIED'; end if;
   insert into private.team_recovery_credentials(hash,delegation_id,version,audience,expires_at,operation_id,job_id,epoch)
    values((p_input->>'operationHash')::bytea,delegation.id,delegation.version,'execute',clock_timestamp()+interval '5 minutes',
      (response->'job'->>'operationId')::uuid,(response->'job'->>'jobId')::uuid,current_epoch);
  end if;
  resolved:=vault.create_secret(response::text,'soty-recovery-claim-'||gen_random_uuid()::text,'Scoped recovery claim');
  update private.team_recovery_claim_receipts set state='confirmed',response_secret_id=resolved,operation_id=(response->'job'->>'operationId')::uuid
    where delegation_id=delegation.id and request_id=receipt.request_id;
  return response;
 elsif p_action in ('authorize_execute','heartbeat','checkpoint','settle') then
  if credential.job_id is distinct from (p_input->>'jobId')::uuid then raise exception 'PERMISSION_DENIED'; end if;
  if p_action='heartbeat' then
   update private.team_recovery_credentials set expires_at=clock_timestamp()+interval '5 minutes' where hash=p_hash;
  elsif p_action='checkpoint' then
   update private.workspace_recovery_items item set operation_id=credential.operation_id,state='resumed',stage='started',
     started_at=coalesce(item.started_at,clock_timestamp()),updated_at=clock_timestamp()
    from private.workspace_pause_items snapshot where item.pause_item_id=snapshot.id and snapshot.resource_id=credential.job_id
     and snapshot.kind='restitch' and item.team_id=delegation.team_id and item.state in ('leased','resumed');
  elsif p_action='settle' then
   update private.team_recovery_credentials set expires_at=clock_timestamp() where hash=p_hash;
  end if;
 end if;
 return jsonb_build_object('actorId',delegation.actor_id,'teamId',delegation.team_id,'installationId',delegation.installation_id,
   'delegationId',delegation.id,'operationId',credential.operation_id,'jobId',credential.job_id,'operationState',(select state from public.team_operations where id=credential.operation_id),
   'outputRecorded',exists(select 1 from public.team_catalog_restitch_copies where operation_id=credential.operation_id));
end $$;
revoke all on function public.service_team_recovery(text,bytea,jsonb) from public,anon,authenticated;
grant execute on function public.service_team_recovery(text,bytea,jsonb) to service_role;
revoke all on function private.recovery_actor_allowed(uuid,uuid),private.recovery_rate(uuid,text,integer) from public,anon,authenticated,service_role;

create function public.revoke_team_recovery(p_team uuid,p_installation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 update private.team_recovery_delegations set revoked_at=clock_timestamp(),version=version+1
  where team_id=p_team and installation_id=p_installation and actor_id=auth.uid() and revoked_at is null;
 return true;
end $$;
revoke all on function public.revoke_team_recovery(uuid,uuid) from public,anon;
grant execute on function public.revoke_team_recovery(uuid,uuid) to authenticated;
create or replace function public.service_claim_restitch_job(
  p_team uuid,
  p_actor uuid,
  p_lease_token_hash bytea,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed private.catalog_restitch_jobs;
  result jsonb;
begin
  if p_actor is null or not private.can(p_team, 'process', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if p_lease_token_hash is null or octet_length(p_lease_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if exists(select 1 from private.team_recovery_delegations delegation
      where delegation.team_id=p_team and delegation.actor_id=p_actor and delegation.revoked_at is null
        and delegation.expires_at>clock_timestamp()
        and delegation.id::text is distinct from pg_catalog.current_setting('soty.background_recovery',true)) then
    return null;
  end if;
  -- One at a time per member: their own lease still running means their computer is still working.
  if exists (
    select 1 from private.catalog_restitch_jobs as job
    where job.team_id = p_team and job.lease_owner = p_actor and job.state = 'leased'
      and job.lease_expires_at > clock_timestamp()
  ) then return null; end if;

  select job.* into claimed
  from private.catalog_restitch_jobs as job
  join public.team_catalog_updaters as updater on updater.team_id = job.team_id
  join public.team_catalog_updater_items as item
    on item.catalog_material_id = job.catalog_material_id
  where job.team_id = p_team
    and updater.state = 'running'
    and private.catalog_wants_restitch(job.catalog_material_id)
    and not exists(select 1 from private.workspace_pause_items snapshot
      join private.workspace_recovery_items recovery on recovery.pause_item_id=snapshot.id
      join private.workspace_recoveries cycle on cycle.id=recovery.recovery_id
      where snapshot.kind='restitch' and snapshot.resource_id=job.catalog_material_id
        and snapshot.config_generation=item.config_generation and cycle.state<>'superseded'
        and (recovery.state in ('blocked','skipped_manual') or exists(
          select 1 from public.team_operations operation where operation.id=coalesce(recovery.operation_id,snapshot.operation_id)
            and (operation.state='canceled' or (operation.state='failed' and not operation.retryable))) or not exists(
          select 1 from public.team_materials sheet join public.team_materials source on source.id=sheet.companion_of
          where sheet.id=snapshot.resource_id and source.id=snapshot.source_material_id and source.lifecycle='active'
            and source.drive_version is not distinct from snapshot.source_version)))
    and not exists(select 1 from private.catalog_restitch_operations previous
      join public.team_operations operation on operation.id=previous.operation_id
      where previous.catalog_material_id=job.catalog_material_id and operation.state in ('pending','running'))
    and job.next_attempt_at <= clock_timestamp()
    and not exists (
      select 1 from private.catalog_restitch_operations original
      join public.team_operations finished on finished.id=original.operation_id
      where original.catalog_material_id=job.catalog_material_id and finished.state='succeeded'
        and finished.result_material_id is not null
        and not exists(select 1 from public.team_catalog_restitch_copies receipt where receipt.operation_id=finished.id)
    )
    and (job.state = 'queued' or job.lease_expires_at <= clock_timestamp())
    and exists (
      select 1 from private.live_product_catalogs(job.team_id) as live
      where live.catalog_material_id = job.catalog_material_id
    )
  order by job.next_attempt_at, job.created_at
  for update of job skip locked
  limit 1;
  if claimed.catalog_material_id is null then return null; end if;

  update private.catalog_restitch_jobs as job
     set state = 'leased',
         lease_owner = p_actor,
         operation_id = null,
         lease_token_hash = p_lease_token_hash,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 30), 600)),
         attempts = job.attempts + 1
   where job.catalog_material_id = claimed.catalog_material_id;

  select jsonb_build_object(
    'jobId', claimed.catalog_material_id,
    'teamId', claimed.team_id,
    'actorId', p_actor,
    'attempt', claimed.attempts + 1,
    -- Earlier attempts whose leases lapsed may have left processes open, holding the copy's name.
    'openOperationIds', coalesce((
      select jsonb_agg(started.operation_id)
      from private.catalog_restitch_operations as started
      join public.team_operations as operation on operation.id = started.operation_id
      where started.catalog_material_id = claimed.catalog_material_id
        and operation.state in ('pending', 'running')
    ), '[]'::jsonb),
    'videoMaterialId', video.id,
    'videoName', video.name,
    'videoDriveVersion', video.drive_version,
    'destinationFolderId', folder.id,
    'updateCount', record.update_count,
    -- In the shapes the app's restitch delegate reads (shared `parseTeamRestitchDefaults` and
    -- `parseMaterialRestitchPrep`), which are the web's mapped rows.
    'defaults', (
      select jsonb_build_object(
        'operation', defaults.operation,
        'startImageIds', to_jsonb(defaults.start_image_ids),
        'endImageIds', to_jsonb(defaults.end_image_ids),
        'fitMode', defaults.fit_mode,
        'finalDurationMode', defaults.final_duration_mode,
        'customFinalDurationSeconds', defaults.custom_final_duration_seconds,
        'configured', defaults.configured,
        'updatedAt', defaults.updated_at,
        'updatedBy', defaults.updated_by
      )
      from public.team_restitch_defaults as defaults
      where defaults.team_id = claimed.team_id
    ),
    'prepared', (
      select jsonb_build_object(
        'materialId', prep.material_id,
        'driveVersion', prep.drive_version,
        'detectorVersion', prep.detector_version,
        'detectedStartSeconds', prep.detected_start_seconds,
        'detectedEndSeconds', prep.detected_end_seconds,
        'profile', prep.source_profile,
        'unsupportedReason', prep.unsupported_reason,
        'preparedAt', prep.prepared_at
      )
      from public.team_material_restitch_prep as prep
      where prep.material_id = video.id
        and prep.drive_version is not distinct from video.drive_version
    )
  ) into result
  from public.team_materials as sheet
  join public.team_materials as video on video.id = sheet.companion_of
  join public.team_product_catalogs as record on record.material_id = sheet.id
  left join public.team_materials as folder
    on folder.team_id = video.team_id
   and folder.drive_file_id = video.parent_folder_id
   and folder.kind = 'folder'
   and folder.lifecycle = 'active'
  where sheet.id = claimed.catalog_material_id;
  return result;
end;
$$;


create function public.service_recovery_claim_restitch(p_hash bytea,p_team uuid,p_actor uuid,p_lease_token_hash bytea,p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 context:=public.service_team_recovery('authorize_claim',p_hash,'{}'::jsonb);
 if (context->>'teamId')::uuid is distinct from p_team or (context->>'actorId')::uuid is distinct from p_actor then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 perform pg_catalog.set_config('soty.background_recovery',context->>'delegationId',true);
 return public.service_claim_restitch_job(p_team,p_actor,p_lease_token_hash,p_lease_seconds);
end $$;
revoke all on function public.service_recovery_claim_restitch(bytea,uuid,uuid,bytea,integer) from public,anon,authenticated;
grant execute on function public.service_recovery_claim_restitch(bytea,uuid,uuid,bytea,integer) to service_role;
commit;
