-- Durable tariff pause provenance and a single recovery lifecycle. No user content.
begin;
create table private.workspace_pauses (
  id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
  epoch bigint generated always as identity, captured_at timestamptz not null default clock_timestamp(),
  state text not null default 'captured' check(state in ('captured','recovery_registered','superseded')),
  unique(id,team_id), unique(team_id,epoch)
);
create unique index workspace_pause_current on private.workspace_pauses(team_id) where state='captured';
create table private.workspace_pause_items (
  id uuid primary key default gen_random_uuid(), pause_id uuid not null, team_id uuid not null,
  kind text not null check(kind in ('catalog_schedule','catalog_round','sync','restitch','preview','archive','cleanup','agent_operation')),
  resource_id uuid not null, operation_id uuid, actor_id uuid,
  config_generation bigint not null default 0, previous_interval text,
  round_due_at timestamptz, next_run_at timestamptz, source_version text, source_material_id uuid,
  captured_at timestamptz not null default clock_timestamp(),
  foreign key(pause_id,team_id) references private.workspace_pauses(id,team_id) on delete cascade,
  unique(id,team_id), unique(pause_id,kind,resource_id)
);
create table private.workspace_recoveries (
  id uuid primary key default gen_random_uuid(), pause_id uuid not null unique, team_id uuid not null,
  epoch bigint not null, registered_at timestamptz not null default clock_timestamp(),
  last_progress_at timestamptz not null default clock_timestamp(),
  state text not null default 'registered' check(state in ('registered','running','waiting_dependency','partial','completed','superseded')),
  foreign key(pause_id,team_id) references private.workspace_pauses(id,team_id) on delete cascade,
  unique(id,team_id), unique(team_id,epoch)
);
create table private.workspace_recovery_items (
  id uuid primary key default gen_random_uuid(), recovery_id uuid not null, pause_item_id uuid not null unique,
  team_id uuid not null, state text not null default 'pending'
    check(state in ('pending','leased','waiting_dependency','resumed','completed','skipped_manual','blocked','superseded')),
  stage text not null default 'registered' check(stage in ('registered','queued','claimed','started','terminal','delivered')),
  reason_code text check(reason_code in ('waiting_agent','waiting_drive','needs_agent_setup','permission_revoked',
    'manually_disabled','user_cancelled','source_changed','source_missing','checkpoint_unavailable',
    'queue_registration_failed','retry_exhausted','superseded','unknown')),
  operation_id uuid, attempt_id uuid, attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  started_at timestamptz, finished_at timestamptz, delivered_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(recovery_id,team_id) references private.workspace_recoveries(id,team_id) on delete cascade,
  foreign key(pause_item_id,team_id) references private.workspace_pause_items(id,team_id) on delete cascade,
  unique(recovery_id,pause_item_id)
);
create index workspace_recovery_due on private.workspace_recovery_items(next_attempt_at) where state in ('pending','waiting_dependency');
do $$ declare t text; begin
  foreach t in array array['workspace_pauses','workspace_pause_items','workspace_recoveries','workspace_recovery_items'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('alter table private.%I force row level security',t);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;
alter table public.team_catalog_updater_items
  add column tariff_pause_id uuid references private.workspace_pauses(id),
  add column tariff_paused_round_at timestamptz,
  add column config_generation bigint not null default 0;
alter table public.team_catalog_update_attempts add column requested_by uuid;

-- User changes override a saved pause. Internal pause/restore changes the pause
-- identity in the same statement; no user-controlled session flag authorizes it.
create function private.catalog_recovery_config_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.tariff_pause_id is not distinct from old.tariff_pause_id and
     (new.update_interval is distinct from old.update_interval
      or (old.paused_interval is not null and new.paused_interval is null)
      or (new.round_due_at is distinct from old.round_due_at and auth.uid() is not null)) then
    new.config_generation := old.config_generation+1;
    if old.tariff_pause_id is not null then
      new.tariff_pause_id:=null; new.tariff_paused_round_at:=null; new.paused_interval:=null;
    end if;
  end if;
  return new;
end $$;
create trigger catalog_recovery_config_change before update on public.team_catalog_updater_items
for each row execute function private.catalog_recovery_config_change();

create function private.capture_workspace_pause(p_team uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare pause_id uuid;
begin
  select id into pause_id from private.workspace_pauses where team_id=p_team and state='captured';
  if pause_id is not null then return pause_id; end if;
  update private.workspace_recoveries set state='superseded',last_progress_at=clock_timestamp()
   where team_id=p_team and state<>'superseded';
  update private.workspace_recovery_items set state='superseded',reason_code='superseded',updated_at=clock_timestamp()
   where team_id=p_team and state not in ('completed','skipped_manual','superseded');
  insert into private.workspace_pauses(team_id) values(p_team) returning id into pause_id;
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,actor_id,
    config_generation,previous_interval,round_due_at,next_run_at)
  select pause_id,p_team,case when coalesce(item.update_interval,item.paused_interval) is not null then 'catalog_schedule' else 'catalog_round' end,
    item.catalog_material_id,case when item.update_interval is not null or item.paused_interval is not null
      then (select owner_id from public.teams where id=p_team)
      else coalesce(attempt.requested_by,profile.updated_by) end,
    item.config_generation,coalesce(item.update_interval,item.paused_interval),item.round_due_at,item.next_run_at
  from public.team_catalog_updater_items item
  left join public.team_catalog_update_profiles profile on profile.catalog_material_id=item.catalog_material_id
  left join public.team_catalog_update_attempts attempt on attempt.catalog_material_id=item.catalog_material_id and attempt.round_due_at=item.round_due_at
  where item.team_id=p_team and (item.update_interval is not null or item.paused_interval is not null or item.round_due_at is not null);
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,operation_id,source_material_id,source_version,config_generation)
  select pause_id,p_team,'restitch',item.catalog_material_id,job.operation_id,video.id,video.drive_version,item.config_generation
  from public.team_catalog_updater_items item join public.team_catalog_update_profiles profile on profile.catalog_material_id=item.catalog_material_id
  left join private.catalog_restitch_jobs job on job.catalog_material_id=item.catalog_material_id
  join public.team_materials sheet on sheet.id=item.catalog_material_id
  join public.team_materials video on video.id=sheet.companion_of
  where item.team_id=p_team and profile.restitch and (item.update_interval is not null or item.round_due_at is not null)
    and not exists(select 1 from public.team_catalog_restitch_copies where catalog_material_id=item.catalog_material_id and role='spare');
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id)
  select pause_id,p_team,'sync',id from public.team_drive_connections where team_id=p_team and state<>'detached';
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,operation_id,actor_id,source_version)
  select pause_id,p_team,'agent_operation',id,id,actor_id,
    (select drive_version from public.team_materials where id=operation.source_material_id)
  from public.team_operations operation where team_id=p_team and kind='process' and state in ('pending','running');
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,source_version)
  select pause_id,p_team,'preview',id,drive_version from public.team_materials
   where team_id=p_team and lifecycle='active' and provider_thumbnail_state='pending';
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id,source_version)
  select pause_id,p_team,'archive',id,drive_version from public.team_materials
   where team_id=p_team and lifecycle='active' and category='archive' and landing_validation_state is null;
  insert into private.workspace_pause_items(pause_id,team_id,kind,resource_id)
  select pause_id,p_team,'cleanup',material_id from public.team_catalog_restitch_copies where team_id=p_team and role='retired';
  return pause_id;
end $$;

create or replace function private.apply_tariff_pauses(p_team uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
declare candidate record; pause_id uuid; count_paused integer:=0;
begin
  for candidate in
    select team.id from public.teams team where (p_team is null or team.id=p_team)
      and not private.team_workspace_allowed(team.id)
      and (exists(select 1 from public.team_catalog_updater_items where team_id=team.id and (update_interval is not null or round_due_at is not null))
        or (not exists(select 1 from private.workspace_pauses where team_id=team.id and state='captured')
          and (exists(select 1 from public.team_drive_connections where team_id=team.id and state<>'detached')
            or exists(select 1 from public.team_operations where team_id=team.id and state in ('pending','running')))))
    order by team.id
  loop
    begin
      perform 1 from public.space_tariffs where team_id=candidate.id order by id for update nowait;
    exception when lock_not_available then continue; end;
    perform 1 from public.team_catalog_updaters where team_id=candidate.id for update;
    if private.team_workspace_allowed(candidate.id) then continue; end if;
    pause_id:=private.capture_workspace_pause(candidate.id);
    update public.team_catalog_updater_items item set
      tariff_pause_id=pause_id, tariff_paused_round_at=item.round_due_at,
      paused_interval=coalesce(item.update_interval,item.paused_interval),update_interval=null,next_run_at=null,
      round_due_at=null,lease_owner=null,lease_expires_at=null
    where item.team_id=candidate.id;
    update public.team_catalog_updaters set paused_by_tariff_at=clock_timestamp() where team_id=candidate.id;
    perform private.sync_catalog_updater(candidate.id);
    count_paused:=count_paused+1;
  end loop;
  return count_paused;
end $$;

create function private.register_workspace_recovery(p_team uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare paused private.workspace_pauses; recovery uuid;
begin
  select * into paused from private.workspace_pauses where team_id=p_team and state='captured' for update;
  if paused.id is null then return null; end if;
  insert into private.workspace_recoveries(pause_id,team_id,epoch) values(paused.id,p_team,paused.epoch)
    on conflict(pause_id) do update set pause_id=excluded.pause_id returning id into recovery;
  insert into private.workspace_recovery_items(recovery_id,pause_item_id,team_id,operation_id)
    select recovery,id,team_id,operation_id from private.workspace_pause_items where pause_id=paused.id
    on conflict(pause_item_id) do nothing;
  update private.workspace_pauses set state='recovery_registered' where id=paused.id;
  return recovery;
end $$;

-- Aggregate only proven lifecycle states. Queued work cannot be completed.
create function private.refresh_workspace_recovery(p_team uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  with desired as (
    select recovery.id,case
      when exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id and state in ('blocked','waiting_dependency'))
        then case when exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id and state in ('resumed','completed')) then 'partial' else 'waiting_dependency' end
      when exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id and state in ('pending','leased','resumed')) then 'running'
      else 'completed' end as next_state,
      coalesce((select max(updated_at) from private.workspace_recovery_items where recovery_id=recovery.id),recovery.registered_at) as progress_at
    from private.workspace_recoveries recovery where recovery.team_id=p_team and recovery.state<>'superseded'
  )
  update private.workspace_recoveries recovery set state=desired.next_state,last_progress_at=desired.progress_at
    from desired where recovery.id=desired.id
      and (recovery.state,recovery.last_progress_at) is distinct from (desired.next_state,desired.progress_at);
  if found then
    insert into public.team_catalog_events(team_id,material_id,event_kind) values(p_team,null,'sync_state');
  end if;
end $$;

create function private.dispatch_workspace_recovery(p_team uuid)
returns void language plpgsql security definer set search_path='' as $$
declare entry record; live public.team_catalog_updater_items; outcome text; sync_job uuid;
begin
  if not private.team_workspace_allowed(p_team) then return; end if;
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  for entry in
    select item.id as item_id,item.attempts,item.state,item.next_attempt_at,snapshot.*
    from private.workspace_recovery_items item join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id
    join private.workspace_recoveries recovery on recovery.id=item.recovery_id
    where item.team_id=p_team and recovery.state<>'superseded'
      and item.state in ('pending','waiting_dependency') and item.next_attempt_at<=clock_timestamp()
    order by snapshot.resource_id for update of item skip locked
  loop
    outcome:=null;
    if entry.actor_id is not null and not coalesce((private.effective_permissions(p_team,entry.actor_id)->>'process')::boolean,false) then outcome:='permission_revoked';
    elsif entry.kind in ('catalog_schedule','catalog_round') then
      select * into live from public.team_catalog_updater_items where catalog_material_id=entry.resource_id for update;
      if live.catalog_material_id is null or live.tariff_pause_id is distinct from entry.pause_id
         or live.config_generation<>entry.config_generation then outcome:='manually_disabled';
      elsif not exists(select 1 from private.live_product_catalogs(p_team) where catalog_material_id=entry.resource_id) then outcome:='source_missing';
      elsif entry.kind='catalog_round' and entry.actor_id is null then outcome:='checkpoint_unavailable';
      elsif exists(select 1 from public.team_catalog_update_attempts where catalog_material_id=entry.resource_id
        and round_due_at=entry.round_due_at and result in ('success','partial','failed','cancelled')) then outcome:='user_cancelled';
      elsif exists(select 1 from public.team_drive_connections connection join public.team_materials material on material.connection_id=connection.id
        where material.id=entry.resource_id and connection.state<>'connected') then outcome:='waiting_drive';
      else
        update public.team_catalog_updater_items set update_interval=entry.previous_interval,
          next_run_at=case when entry.previous_interval is not null then clock_timestamp() end,
          round_due_at=entry.round_due_at,tariff_pause_id=null,tariff_paused_round_at=null,paused_interval=null,
          next_attempt_at=clock_timestamp(),lease_owner=null,lease_expires_at=null
          where catalog_material_id=entry.resource_id;
      end if;
    elsif entry.kind='sync' then
      if not exists(select 1 from public.team_drive_connections where id=entry.resource_id and state='connected') then outcome:='waiting_drive';
      else
        begin sync_job:=private.resume_space_sync(p_team);
          if sync_job is null then outcome:='queue_registration_failed'; end if;
        exception when others then outcome:='queue_registration_failed'; end;
      end if;
    elsif entry.kind='restitch' then
      outcome:='waiting_agent';
    elsif entry.kind='agent_operation' then
      if exists(select 1 from public.team_operations where id=entry.operation_id and state='succeeded') then
        update private.workspace_recovery_items set state='completed',stage='terminal',finished_at=clock_timestamp(),updated_at=clock_timestamp()
         where id=entry.item_id; continue;
      elsif exists(select 1 from public.team_operations where id=entry.operation_id and state='canceled') then outcome:='user_cancelled';
      elsif exists(select 1 from public.team_operations where id=entry.operation_id and state='failed') then outcome:='unknown';
      else outcome:='checkpoint_unavailable'; end if;
    else
      -- Existing gated, version-aware queues own preview/archive/cleanup.
      if not exists(select 1 from public.team_drive_connections where team_id=p_team and state='connected') then outcome:='waiting_drive'; end if;
    end if;
    update private.workspace_recovery_items set
      state=case when outcome in ('manually_disabled','user_cancelled') then 'skipped_manual'
        when outcome in ('permission_revoked','source_missing','checkpoint_unavailable','unknown') then 'blocked'
        when outcome='queue_registration_failed' and attempts>=5 then 'blocked'
        when outcome is not null then 'waiting_dependency' else 'leased' end,
      stage=case when outcome in ('manually_disabled','user_cancelled','permission_revoked','source_missing','checkpoint_unavailable','unknown') then 'terminal' else 'queued' end,
      reason_code=case when outcome='queue_registration_failed' and attempts>=5 then 'retry_exhausted' else outcome end,attempts=attempts+case when outcome='queue_registration_failed' then 1 else 0 end,
      next_attempt_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
      where id=entry.item_id;
  end loop;
  perform private.clear_tariff_pause_mark(p_team);
  perform private.sync_catalog_updater(p_team);
  perform private.refresh_workspace_recovery(p_team);
end $$;

create or replace function private.restore_tariff_catalog_schedules(p_team uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare restored integer;
begin
  perform 1 from public.space_tariffs where team_id=p_team and revoked_at is null order by id for update;
  perform 1 from public.team_catalog_updaters where team_id=p_team for update;
  if not private.team_workspace_allowed(p_team) then return 0; end if;
  perform private.register_workspace_recovery(p_team);
  select count(*) into restored from public.team_catalog_updater_items where team_id=p_team and tariff_pause_id is not null;
  perform private.dispatch_workspace_recovery(p_team);
  return restored;
end $$;

create or replace function private.after_space_tariff_change(p_team uuid,p_was_allowed boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_team is null then return; end if;
  if p_was_allowed and not private.team_workspace_allowed(p_team) then perform private.apply_tariff_pauses(p_team);
  elsif not p_was_allowed and private.team_workspace_allowed(p_team) then
    perform private.restore_tariff_catalog_schedules(p_team);
  end if;
end $$;

create function private.sweep_workspace_recovery()
returns void language plpgsql security definer set search_path='' as $$
declare candidate record;
begin
  perform private.apply_tariff_pauses(null);
  for candidate in select distinct team_id from private.workspace_recoveries where state not in ('completed','superseded') loop
    perform private.dispatch_workspace_recovery(candidate.team_id);
  end loop;
  -- Retain unresolved pauses forever; only terminal histories are eligible.
  delete from private.workspace_pauses paused using private.workspace_recoveries recovery
   where recovery.pause_id=paused.id and recovery.state in ('completed','superseded')
    and recovery.last_progress_at<clock_timestamp()-interval '30 days'
    and not exists(select 1 from private.workspace_recovery_items where recovery_id=recovery.id and state not in ('completed','skipped_manual','superseded'))
    and not exists(select 1 from public.team_catalog_updater_items where tariff_pause_id=paused.id);
end $$;
select cron.schedule('soty-workspace-recovery','* * * * *',$cron$select private.sweep_workspace_recovery()$cron$);

create function private.workspace_recovery_json(p_team uuid,p_actor uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('id',r.id,'epoch',r.epoch,'state',r.state,'registeredAt',r.registered_at,'lastProgressAt',r.last_progress_at,
    'counts',jsonb_build_object('pending',count(*) filter(where i.state='pending'),'running',count(*) filter(where i.state='leased'),
      'waiting',count(*) filter(where i.state='waiting_dependency'),'resumed',count(*) filter(where i.state='resumed'),
      'completed',count(*) filter(where i.state='completed'),'skipped',count(*) filter(where i.state in ('skipped_manual','superseded')),'blocked',count(*) filter(where i.state='blocked')),
    'reasons',coalesce((select jsonb_agg(jsonb_build_object('code',reason_code,'count',n,'action',case when reason_code='waiting_drive' then 'drive'
      when reason_code in ('waiting_agent','needs_agent_setup') then 'agent' when reason_code in ('retry_exhausted','queue_registration_failed') then 'retry' else 'none' end))
      from (select reason_code,count(*) n from private.workspace_recovery_items where recovery_id=r.id and reason_code is not null group by reason_code) reasons),'[]'::jsonb),
    'canManageRecovery',private.can(p_team,'process',p_actor))
  from private.workspace_recoveries r left join private.workspace_recovery_items i on i.recovery_id=r.id
  where r.team_id=p_team and r.state<>'superseded' and private.can(p_team,'view',p_actor)
  group by r.id order by r.registered_at desc limit 1;
$$;

create or replace function private.sync_catalog_updater(p_team uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare earliest timestamptz; preparing_one_off boolean;
begin
  delete from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is null and item.round_due_at is null
    and item.paused_interval is null and item.tariff_pause_id is null;

  select min(item.next_run_at) into earliest
  from public.team_catalog_updater_items as item
  where item.team_id = p_team and item.update_interval is not null;

  select exists (
    select 1 from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    where item.team_id = p_team
      and coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
      and item.round_due_at is not null
  ) into preparing_one_off;

  update public.team_catalog_updaters as updater
     set restitch = exists (
           select 1 from public.team_catalog_updater_items as item
           where item.team_id = p_team
             and private.catalog_wants_restitch(item.catalog_material_id)
         ),
         state = case when earliest is null and not preparing_one_off then 'stopped' else 'running' end,
         next_run_at = earliest,
         started_at = case
           when earliest is null and not preparing_one_off then updater.started_at
           when updater.state <> 'running' then clock_timestamp()
           else updater.started_at end,
         started_by = case
           when (earliest is not null or preparing_one_off) and updater.state <> 'running'
             then auth.uid() else updater.started_by end,
         updated_by = coalesce(auth.uid(), updater.updated_by),
         updated_at = clock_timestamp()
   where updater.team_id = p_team;

  if exists (select 1 from public.team_catalog_updaters
             where team_id = p_team and state = 'running') then
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true)
        and (item.update_interval is not null or item.round_due_at is not null
             or item.paused_interval is not null or item.tariff_pause_id is not null)
    ));
    perform private.queue_restitch_jobs(p_team);
  else
    perform private.retire_restitch_spares(p_team, array(
      select item.catalog_material_id from public.team_catalog_updater_items as item
      join public.team_catalog_update_profiles as profile
        on profile.catalog_material_id = item.catalog_material_id
      where item.team_id = p_team and private.catalog_wants_restitch(item.catalog_material_id, true) and (item.paused_interval is not null or item.tariff_pause_id is not null)
    ));
  end if;

  insert into public.team_catalog_events (team_id, material_id, event_kind)
  values (p_team, null, 'sync_state');
end;
$$;

create or replace function private.forget_unscheduled_catalog_item()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.round_due_at is null and new.update_interval is null and new.paused_interval is null and new.tariff_pause_id is null then
    delete from public.team_catalog_updater_items where catalog_material_id=new.catalog_material_id;
    perform private.sync_catalog_updater(new.team_id);
  end if;
  return null;
end $$;
create or replace function private.track_catalog_update_round()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.round_due_at is not null
     and (tg_op = 'INSERT' or old.round_due_at is distinct from new.round_due_at) then
    insert into public.team_catalog_update_attempts (
      catalog_material_id, team_id, round_due_at, trigger_kind, started_at,
      profile_version, profile_snapshot, source_attempt_id
    ) values (
      new.catalog_material_id, new.team_id, new.round_due_at,
      case when pg_catalog.current_setting('soty.catalog_retry_run', true) = 'on' then 'retry'
           when pg_catalog.current_setting('soty.catalog_manual_run', true) = 'on' then 'manual'
           else 'schedule' end,
      clock_timestamp(),
      (select profile.version from public.team_catalog_update_profiles as profile
       where profile.catalog_material_id = new.catalog_material_id),
      (select jsonb_build_object(
         'refreshImages', profile.refresh_images, 'refreshTexts', profile.refresh_texts,
         'growProducts', profile.grow_products,
         'randomLinkVariation', profile.random_link_variation,
         'restitch', profile.restitch, 'schedule', profile.schedule
       ) from public.team_catalog_update_profiles as profile
       where profile.catalog_material_id = new.catalog_material_id),
      nullif(pg_catalog.current_setting('soty.catalog_source_attempt', true), '')::uuid
    ) on conflict (catalog_material_id, round_due_at) do nothing;
  elsif tg_op = 'UPDATE' and old.round_due_at is not null and new.round_due_at is null and new.tariff_pause_id is null then
    update public.team_catalog_update_attempts
       set result = 'cancelled', ended_at = clock_timestamp()
     where catalog_material_id = new.catalog_material_id
       and round_due_at = old.round_due_at and result in ('running', 'unknown');
  end if;
  return new;
end;
$$;

create function private.recovery_attempt_actor()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.requested_by:=case when new.trigger_kind in ('manual','retry') then auth.uid()
    else (select owner_id from public.teams where id=new.team_id) end;
  return new;
end $$;
create trigger recovery_attempt_actor before insert on public.team_catalog_update_attempts for each row execute function private.recovery_attempt_actor();

create function private.recovery_catalog_claimed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.lease_owner is not null and new.round_due_at is not null then
    update private.workspace_recovery_items item set stage='claimed',attempt_id=attempt.attempt_id,updated_at=clock_timestamp()
    from private.workspace_pause_items snapshot,public.team_catalog_update_attempts attempt,
      private.workspace_recoveries recovery
    where snapshot.id=item.pause_item_id and recovery.id=item.recovery_id and recovery.state<>'superseded'
      and snapshot.resource_id=new.catalog_material_id and snapshot.kind in ('catalog_schedule','catalog_round')
      and attempt.catalog_material_id=new.catalog_material_id and attempt.round_due_at=new.round_due_at
      and item.state='leased' and item.stage='queued';
  end if;
  return null;
end $$;
create trigger recovery_catalog_claimed after update on public.team_catalog_updater_items for each row execute function private.recovery_catalog_claimed();

create function private.recovery_attempt_progress()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  update private.workspace_recovery_items set
    state=case when new.result='success' then 'completed' when new.result='cancelled' then 'skipped_manual'
      when new.result in ('partial','failed','unknown') and new.ended_at is not null then 'blocked' else 'resumed' end,
    stage=case when new.ended_at is not null then 'terminal' else 'started' end,
    reason_code=case when new.result='cancelled' then 'user_cancelled'
      when new.result in ('partial','failed','unknown') and new.ended_at is not null then 'unknown' end,
    started_at=coalesce(started_at,clock_timestamp()),finished_at=new.ended_at,updated_at=clock_timestamp()
    where attempt_id=new.attempt_id and state not in ('superseded','skipped_manual')
      and (new.stage_history is distinct from old.stage_history or new.result is distinct from old.result);
  if found then perform private.refresh_workspace_recovery(new.team_id); end if;
  return null;
end $$;
create trigger recovery_attempt_progress after update on public.team_catalog_update_attempts for each row execute function private.recovery_attempt_progress();

-- Runtime mutation authority is rechecked even for a worker leased before expiry.
create function private.guard_catalog_recovery_worker()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (new.reconciliation_required and not old.reconciliation_required)
     or (new.lease_owner is not null and new.lease_owner is distinct from old.lease_owner) then
    if not private.team_workspace_allowed(new.team_id) or new.tariff_pause_id is not null then
      raise exception 'SPACE_BLOCKED' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger guard_catalog_recovery_worker before update on public.team_catalog_updater_items for each row execute function private.guard_catalog_recovery_worker();
create or replace function private.team_tariff_json(p_team uuid, p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  st record;
  plan public.tariff_plans%rowtype;
  is_owner boolean;
  seat_limit integer;
begin
  select * into st from private.space_tariff_state(p_team, now());
  select tariff_plan.* into plan from public.tariff_plans as tariff_plan where tariff_plan.code = st.plan_code;
  select team.owner_id = p_user into is_owner from public.teams as team where team.id = p_team;
  is_owner := coalesce(is_owner, false);
  seat_limit := private.team_seat_limit(p_team);
  return jsonb_build_object(
    'state', st.state,
    'planCode', st.plan_code,
    'planNameUk', plan.name_uk,
    'planNameEn', plan.name_en,
    'seatsTotal', st.seats_total,
    'seatsUsed', st.seats_used,
    'pendingInvites', st.pending_invites,
    'canInvite', seat_limit is null or coalesce(plan.invites_allowed, false) or seat_limit > 1,
    'endsOn', case when is_owner then st.ends_on::text end,
    'endsAt', case when is_owner then to_jsonb(st.ends_at) end,
    'graceUntil', case when is_owner then (st.ends_on + 3)::text end,
    'daysLeft', case when is_owner then st.days_left end,
    'isOwner', is_owner,
    'updaterPausedByTariff', exists (
      select 1 from public.team_catalog_updaters as updater
      where updater.team_id = p_team and updater.paused_by_tariff_at is not null
    ),
    'recovery',private.workspace_recovery_json(p_team,p_user)
  );
end;
$$;


create view public.analytics_workspace_recovery as
select recovery.id recovery_id,recovery.team_id,recovery.epoch,recovery.state recovery_state,
  recovery.registered_at,recovery.last_progress_at,item.id item_id,item.state,item.stage,item.reason_code,
  item.operation_id,item.attempt_id,item.attempts,item.started_at,item.finished_at,item.delivered_at,item.updated_at,
  snapshot.kind,snapshot.resource_id,snapshot.actor_id
from private.workspace_recoveries recovery
join private.workspace_recovery_items item on item.recovery_id=recovery.id
join private.workspace_pause_items snapshot on snapshot.id=item.pause_item_id;
revoke all on public.analytics_workspace_recovery from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
    grant select on public.analytics_workspace_recovery to wishly_analytics_ro;
  end if;
end $$;
do $$ declare fn record; begin
  for fn in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.proname in ('capture_workspace_pause','register_workspace_recovery',
      'refresh_workspace_recovery','dispatch_workspace_recovery','sweep_workspace_recovery',
      'workspace_recovery_json','catalog_recovery_config_change','recovery_attempt_actor',
      'recovery_catalog_claimed','recovery_attempt_progress','guard_catalog_recovery_worker') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
  end loop;
end $$;
create or replace function private.resume_space_sync(p_team uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_connection uuid;
  queued_job uuid;
begin
  select connection.id into resolved_connection
  from public.team_drive_connections as connection
  where connection.team_id = p_team and connection.state = 'connected'
  order by connection.created_at desc
  limit 1;
  if resolved_connection is null then
    return null;
  end if;
  select job.id into queued_job
  from private.catalog_sync_jobs as job
  where job.connection_id = resolved_connection
    and job.job_kind in ('initial', 'reconcile')
    and job.requested_folder_id is null
    and job.state in ('pending', 'leased', 'retry')
  limit 1;
  if queued_job is not null then
    return queued_job;
  end if;
  queued_job := public.service_enqueue_catalog_reconciliation(resolved_connection);
  return queued_job;
end;
$$;

commit;
