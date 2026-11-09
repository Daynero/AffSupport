begin;
-- Metadata on the existing original attempt, never an alternative execution queue.
create table private.catalog_variant_round_snapshots(
 attempt_id uuid primary key,team_id uuid not null,actor_id uuid not null references auth.users(id),catalog_material_id uuid not null,source_material_id uuid,
 requested_count integer not null check(requested_count between 1 and 400),product_count integer not null check(product_count between 1 and 400),profile_version bigint not null,
 source_kind text not null default 'updater' check(source_kind in('updater','manager')),regular_released boolean not null default false,regular_verified_at timestamptz,
 settings_snapshot jsonb not null,source_snapshot jsonb,set_id uuid not null unique default gen_random_uuid(),recipe_row_ids jsonb not null,child_request_ids jsonb not null,assignment_seed text not null,
 failure_code text check(failure_code in('AGENT_REQUIRED','AGENT_ID_CONFLICT','PERMISSION_DENIED','SOURCE_CHANGED','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN')),created_at timestamptz not null default clock_timestamp(),
 foreign key(attempt_id,team_id)references public.team_catalog_update_attempts(attempt_id,team_id),foreign key(catalog_material_id,team_id)references public.team_materials(id,team_id),foreign key(source_material_id,team_id)references public.team_materials(id,team_id),check(requested_count<=product_count)
);
alter table private.catalog_variant_round_snapshots enable row level security;
alter table private.catalog_variant_round_snapshots force row level security;
revoke all on private.catalog_variant_round_snapshots from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_variant_round_snapshots for each row execute function private.guard_task_cleanup_reference();
create function private.freeze_catalog_round_variant_profile()returns trigger language plpgsql security definer set search_path='' as $$
declare p public.team_catalog_update_profiles%rowtype;actor uuid;
begin
 select *into p from public.team_catalog_update_profiles where catalog_material_id=new.catalog_material_id and team_id=new.team_id for share;
 if p.catalog_material_id is null then return new;end if;
 actor:=auth.uid();
 if actor is null then actor:=nullif(current_setting('soty.catalog_video_actor',true),'')::uuid;end if;
 if actor is null then select coalesce(u.started_by,c.created_by,t.owner_id)into actor from public.team_product_catalogs c join public.teams t on t.id=c.team_id left join public.team_catalog_updaters u on u.team_id=c.team_id where c.material_id=new.catalog_material_id and c.team_id=new.team_id;end if;
 new.profile_version:=p.version;
 new.profile_snapshot:=coalesce(new.profile_snapshot,'{}'::jsonb)||jsonb_build_object('refreshImages',p.refresh_images,'refreshTexts',p.refresh_texts,'growProducts',p.grow_products,'randomLinkVariation',p.random_link_variation,'restitch',p.restitch,'videoVariantCount',p.video_variant_count);
 if p.restitch and (p.video_variant_count>1 or exists(select 1 from private.catalog_video_publication_policies policy where policy.catalog_material_id=new.catalog_material_id and policy.team_id=new.team_id)) then new.profile_snapshot:=new.profile_snapshot||jsonb_build_object('catalogVideoProtocolVersion',1,'catalogVideoActorId',actor);end if;
 return new;
end;$$;
create trigger catalog_round_variant_profile before insert on public.team_catalog_update_attempts for each row execute function private.freeze_catalog_round_variant_profile();
revoke all on function private.freeze_catalog_round_variant_profile()from public,anon,authenticated,service_role;
create function private.capture_catalog_round_video_snapshot()returns trigger language plpgsql security definer set search_path='' as $$
declare c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;actor uuid;n integer;products integer;rows jsonb;children jsonb;
begin
 if new.profile_snapshot->>'catalogVideoProtocolVersion' is distinct from '1'then return new;end if;
 actor:=(new.profile_snapshot->>'catalogVideoActorId')::uuid;n:=(new.profile_snapshot->>'videoVariantCount')::integer;
 select *into c from public.team_product_catalogs where material_id=new.catalog_material_id and team_id=new.team_id;
 select *into m from public.team_materials where id=c.video_material_id and team_id=new.team_id;
 products:=least(400,c.product_count+case when new.profile_snapshot->>'growProducts'='true'then 1 else 0 end);
 select jsonb_agg(gen_random_uuid())into rows from generate_series(1,products);
 select jsonb_agg(gen_random_uuid())into children from generate_series(1,n);
 insert into private.catalog_variant_round_snapshots(attempt_id,team_id,actor_id,catalog_material_id,source_material_id,requested_count,product_count,profile_version,settings_snapshot,source_snapshot,recipe_row_ids,child_request_ids,assignment_seed,source_kind)
 values(new.attempt_id,new.team_id,actor,new.catalog_material_id,c.video_material_id,n,products,new.profile_version,coalesce(private.effective_restitch_defaults_json(new.team_id,actor),'{}'::jsonb),case when m.id is not null then jsonb_build_object('materialId',m.id,'connectionId',m.connection_id,'fileId',m.drive_file_id,'version',m.drive_version)end,rows,children,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),case when nullif(current_setting('soty.catalog_video_actor',true),'') is not null then 'manager'else 'updater'end);
 return new;
end;$$;
create trigger catalog_round_video_snapshot after insert on public.team_catalog_update_attempts for each row execute function private.capture_catalog_round_video_snapshot();
revoke all on function private.capture_catalog_round_video_snapshot()from public,anon,authenticated,service_role;
create function private.note_catalog_variant_round_wait(p_attempt uuid,p_code text)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_variant_round_snapshots%rowtype;
begin
 if p_code not in('AGENT_REQUIRED','AGENT_ID_CONFLICT','PERMISSION_DENIED','SOURCE_CHANGED','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN')or p_code is null then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 update private.catalog_variant_round_snapshots set failure_code=p_code where attempt_id=p_attempt returning *into r;
 update public.team_catalog_update_attempts set failure_code=p_code where attempt_id=p_attempt and result='running';
 update public.team_catalog_updater_items set next_attempt_at=clock_timestamp()+interval '1 minute'where catalog_material_id=r.catalog_material_id and team_id=r.team_id and round_due_at=(select round_due_at from public.team_catalog_update_attempts where attempt_id=p_attempt);
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(r.team_id,r.catalog_material_id,'sync_state');
 return jsonb_build_object('outcome','blocked','failureCode',p_code,'requestId',p_attempt);
end;$$;
revoke all on function private.note_catalog_variant_round_wait(uuid,text)from public,anon,authenticated,service_role;
create function public.service_adopt_catalog_variant_round(p_team uuid,p_actor uuid,p_catalog uuid,p_attempt uuid,p_executor uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare snap private.catalog_variant_round_snapshots%rowtype;r private.catalog_updater_variant_requests%rowtype;a public.team_catalog_update_attempts%rowtype;i public.team_catalog_updater_items%rowtype;m public.team_materials%rowtype;ctx jsonb;executors integer;host uuid;policy private.catalog_video_publication_policies%rowtype;
begin
 perform 1 from public.team_catalog_updaters where team_id=p_team for update;
 select *into i from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team for update;
 select *into a from public.team_catalog_update_attempts where attempt_id=p_attempt and team_id=p_team and catalog_material_id=p_catalog for update;
 select *into snap from private.catalog_variant_round_snapshots where attempt_id=p_attempt and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog;
 if snap.attempt_id is null then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select *into r from private.catalog_updater_variant_requests where attempt_id=p_attempt;
 if r.request_id is not null then if r.team_id<>p_team or r.actor_id<>p_actor then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;return to_jsonb(r);end if;
 if a.result is distinct from 'running'or i.round_due_at is distinct from a.round_due_at or i.reconciliation_required or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog)or(i.lease_expires_at>clock_timestamp()and i.lease_owner is not null)then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then return private.note_catalog_variant_round_wait(p_attempt,'PERMISSION_DENIED');end if;
 if not private.team_workspace_allowed(p_team)then return private.note_catalog_variant_round_wait(p_attempt,'PERMISSION_DENIED');end if;
 select *into m from public.team_materials where id=snap.source_material_id and team_id=p_team and lifecycle='active'and category='video';
 if m.id is null or snap.source_snapshot is null or m.connection_id is distinct from(snap.source_snapshot->>'connectionId')::uuid or m.drive_file_id is distinct from snap.source_snapshot->>'fileId' or not exists(select 1 from private.live_product_catalogs(p_team)live where live.catalog_material_id=p_catalog and live.video_material_id=snap.source_material_id)then return private.note_catalog_variant_round_wait(p_attempt,'SOURCE_CHANGED');end if;
 select count(*)::integer,min(d.installation_id::text)::uuid into executors,host from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null and d.expires_at>clock_timestamp()and(p_executor is null or d.installation_id=p_executor);
 if executors=0 then return private.note_catalog_variant_round_wait(p_attempt,'AGENT_REQUIRED');end if;
 if executors<>1 then return private.note_catalog_variant_round_wait(p_attempt,'AGENT_REQUIRED');end if;
 ctx:=public.service_initial_catalog_video_context(p_team,p_actor,snap.source_material_id,host,true);
 select *into policy from private.catalog_video_publication_policies where catalog_material_id=p_catalog and team_id=p_team;
 insert into private.catalog_updater_variant_requests(request_id,team_id,actor_id,catalog_material_id,attempt_id,set_id,source_material_id,requested_count,product_count,profile_version,executor_id,settings_snapshot,provider_context,recipe_row_ids,child_request_ids,assignment_seed,publication_revision,publication_mode,publication_due,publication_zone)
 values(p_attempt,p_team,p_actor,p_catalog,p_attempt,snap.set_id,snap.source_material_id,snap.requested_count,snap.product_count,snap.profile_version,host,snap.settings_snapshot,ctx->'material',snap.recipe_row_ids,snap.child_request_ids,snap.assignment_seed,coalesce(policy.revision,0),coalesce(policy.mode,'immediate'),policy.due_at,policy.time_zone)returning *into r;
 update public.team_catalog_updater_items set lease_owner='catalog-variants:'||p_attempt::text,lease_expires_at='infinity',next_attempt_at=clock_timestamp()+interval '1 minute'where catalog_material_id=p_catalog and team_id=p_team and round_due_at=a.round_due_at;
 update private.catalog_variant_round_snapshots set failure_code=null where attempt_id=p_attempt;
 update public.team_catalog_update_attempts set failure_code=null where attempt_id=p_attempt;
 return to_jsonb(r);
end;$$;
revoke all on function public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_adopt_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)to service_role;
create function public.service_list_catalog_variant_rounds(p_limit integer default 3)returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'actorId',x.actor_id,'catalogMaterialId',x.catalog_material_id,'attemptId',x.request_id))from(
 select s.team_id,s.actor_id,s.catalog_material_id,s.attempt_id request_id,s.created_at from private.catalog_variant_round_snapshots s join public.team_catalog_update_attempts a on a.attempt_id=s.attempt_id and a.team_id=s.team_id join public.team_catalog_updater_items i on i.catalog_material_id=s.catalog_material_id and i.team_id=s.team_id and i.round_due_at=a.round_due_at where a.result='running'and i.next_attempt_at<=clock_timestamp()and(i.lease_expires_at is null or i.lease_expires_at<=clock_timestamp())and not i.reconciliation_required and not exists(select 1 from private.catalog_update_reconciliations q where q.catalog_material_id=s.catalog_material_id)and not exists(select 1 from private.catalog_updater_variant_requests r where r.attempt_id=s.attempt_id)
 union all select r.team_id,r.actor_id,r.catalog_material_id,r.request_id,r.created_at from private.catalog_updater_variant_requests r join public.team_catalog_update_attempts a on a.attempt_id=r.attempt_id join public.team_catalog_updater_items i on i.catalog_material_id=r.catalog_material_id and i.team_id=r.team_id and i.round_due_at=a.round_due_at where a.result='running'and r.canceled_at is null and not exists(select 1 from private.catalog_video_sets s where s.id=r.set_id)and i.next_attempt_at<=clock_timestamp()and i.lease_owner='catalog-variants:'||r.request_id::text and not i.reconciliation_required
 order by created_at,request_id limit p_limit)x),'[]'::jsonb);
end;$$;
revoke all on function public.service_list_catalog_variant_rounds(integer)from public,anon,authenticated;
grant execute on function public.service_list_catalog_variant_rounds(integer)to service_role;

create or replace function private.claim_catalog_updater_items(
  p_worker text, p_limit integer default 10, p_lease_seconds integer default 60
)
returns setof public.team_catalog_updater_items
language plpgsql security definer set search_path = '' as $$
declare slots integer; gone record;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(72301500) then return; end if;
  for gone in
    delete from public.team_catalog_updater_items as item
    where item.round_due_at is not null
      and not exists (select 1 from private.catalog_update_reconciliations pending
        where pending.catalog_material_id=item.catalog_material_id)
      and not exists (
        select 1 from private.live_product_catalogs(item.team_id) as live
        where live.catalog_material_id = item.catalog_material_id
      )
    returning item.team_id, item.catalog_material_id
  loop
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (gone.team_id, gone.catalog_material_id, 'upserted');
    perform private.sync_catalog_updater(gone.team_id);
  end loop;

  -- A prepared file may be removed between preparation and the next worker tick.
  for gone in
    select distinct copy.team_id from public.team_catalog_restitch_copies as copy
    where copy.role = 'spare' and not private.catalog_has_usable_spare(copy.catalog_material_id)
  loop
    perform private.queue_restitch_jobs(gone.team_id);
  end loop;

  select greatest(0, 12 - count(*)::integer) into slots
  from public.team_catalog_updater_items where lease_expires_at > clock_timestamp()and coalesce(lease_owner,'')not like 'catalog-variants:%';
  if slots = 0 then return; end if;

  return query
  with candidates as (
    select item.catalog_material_id
    from public.team_catalog_updater_items as item
    join public.team_catalog_update_profiles as profile
      on profile.catalog_material_id = item.catalog_material_id
    left join public.team_catalog_update_attempts as attempt
      on attempt.catalog_material_id = item.catalog_material_id
     and attempt.round_due_at = item.round_due_at
    left join private.catalog_restitch_jobs as job
      on job.catalog_material_id = item.catalog_material_id
    where item.round_due_at is not null
      and not exists(select 1 from private.catalog_variant_round_snapshots n where n.attempt_id=attempt.attempt_id and n.team_id=item.team_id and (not n.regular_released or n.regular_verified_at is not null))
      and not exists (select 1 from private.catalog_update_reconciliations pending
        where pending.catalog_material_id=item.catalog_material_id)
      and not item.reconciliation_required
      and item.next_attempt_at <= clock_timestamp()
      and (item.lease_expires_at is null or item.lease_expires_at <= clock_timestamp())
      and private.team_workspace_allowed(item.team_id)
      and (
        (item.update_interval is not null and coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry'))
        or not coalesce((attempt.profile_snapshot ->> 'restitch')::boolean, profile.restitch)
        or exists(select 1 from private.catalog_variant_round_snapshots n where n.attempt_id=attempt.attempt_id and n.team_id=item.team_id and n.regular_released and n.regular_verified_at is null)
        or private.catalog_has_usable_spare(item.catalog_material_id)
        or (coalesce(attempt.trigger_kind, 'unknown') not in ('manual', 'retry')
            and item.round_due_at <= clock_timestamp() - interval '30 minutes'
            and (job.catalog_material_id is null or job.state <> 'leased'
                 or job.lease_expires_at <= clock_timestamp()))
      )
    order by item.next_attempt_at, item.round_due_at
    for update of item skip locked
    limit least(greatest(p_limit, 1), slots)
  )
  update public.team_catalog_updater_items as item
     set lease_owner = p_worker,
         lease_expires_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         next_attempt_at = clock_timestamp()
           + make_interval(secs => least(greatest(p_lease_seconds, 10), 300)),
         attempts = item.attempts + 1
    from candidates
   where item.catalog_material_id = candidates.catalog_material_id
  returning item.*;
end;
$$;

create or replace function private.catalog_restitch_job_blockers(p_catalog uuid)
returns text[] language sql stable security definer set search_path='' as $$
 select array_remove(array[
 case when exists(select 1 from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id where v.catalog_material_id=p_catalog and v.canceled_at is null and a.result in('running','unknown'))or exists(select 1 from private.catalog_variant_round_snapshots n join public.team_catalog_update_attempts a on a.attempt_id=n.attempt_id where n.catalog_material_id=p_catalog and a.result='running'and a.round_due_at=item.round_due_at)or(not exists(select 1 from public.team_catalog_update_attempts active where active.catalog_material_id=p_catalog and active.round_due_at=item.round_due_at and active.result='running')and exists(select 1 from public.team_catalog_update_profiles p where p.catalog_material_id=p_catalog and p.restitch and(p.video_variant_count>1 or exists(select 1 from private.catalog_video_publication_policies pol where pol.catalog_material_id=p_catalog))))then 'job_leased'end,
 case when job.catalog_material_id is null then 'job_missing' end,
 case when updater.state is distinct from 'running' then 'updater_stopped' end,
 case when item.catalog_material_id is null then 'item_missing' end,
 case when not private.catalog_wants_restitch(p_catalog) then 'restitch_not_requested' end,
 case when exists(select 1 from private.workspace_pause_items snapshot
      join private.workspace_recovery_items recovery on recovery.pause_item_id=snapshot.id
      join private.workspace_recoveries cycle on cycle.id=recovery.recovery_id
      where snapshot.kind='restitch' and snapshot.resource_id=job.catalog_material_id
        and snapshot.config_generation=item.config_generation and cycle.state<>'superseded'
        and (recovery.state in ('blocked','skipped_manual') or exists(
          select 1 from public.team_operations operation where operation.id=coalesce(recovery.operation_id,snapshot.operation_id)
            and (operation.state='canceled' or (operation.state='failed' and not operation.retryable))) or not exists(
          select 1 from public.team_materials sheet join public.team_materials source on source.id=sheet.companion_of
          where sheet.id=snapshot.resource_id and source.id=snapshot.source_material_id and source.lifecycle='active'
            and source.drive_version is not distinct from snapshot.source_version))) then 'recovery_blocked' end,
 case when exists(select 1 from private.catalog_restitch_operations previous
  join public.team_operations operation on operation.id=previous.operation_id
  where previous.catalog_material_id=p_catalog and operation.state in ('pending','running')) then 'previous_operation_open' end,
 case when exists(select 1 from private.catalog_restitch_operations original
  join public.team_operations finished on finished.id=original.operation_id
  where original.catalog_material_id=p_catalog and finished.state='succeeded' and finished.result_material_id is not null
   and original.output_recorded_at is null
   and not exists(select 1 from public.team_catalog_restitch_copies receipt where receipt.operation_id=finished.id))
  then 'output_receipt_missing' end,
 case when job.next_attempt_at>clock_timestamp() then 'retry_backoff' end,
 case when job.state='leased' and job.lease_expires_at>clock_timestamp() then 'job_leased' end,
 case when not exists(select 1 from private.live_product_catalogs(catalog.team_id) live where live.catalog_material_id=p_catalog)
  then 'source_link_unavailable' end
 ]::text[],null)
 from public.team_product_catalogs catalog
 left join private.catalog_restitch_jobs job on job.catalog_material_id=catalog.material_id
 left join public.team_catalog_updaters updater on updater.team_id=catalog.team_id
 left join public.team_catalog_updater_items item on item.catalog_material_id=catalog.material_id
 where catalog.material_id=p_catalog;
$$;

create or replace function public.service_accept_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid,p_count integer,p_profile_version bigint,p_executor uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;c public.team_product_catalogs%rowtype;p public.team_catalog_update_profiles%rowtype;i public.team_catalog_updater_items%rowtype;ctx jsonb;attempt uuid;rows jsonb;children jsonb;previous_actor text;
begin
 if p_request is null or private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request::text,172));
 select * into r from private.catalog_updater_variant_requests where request_id=p_request;
 if r.request_id is not null then
  if r.team_id<>p_team or r.actor_id<>p_actor or r.catalog_material_id<>p_catalog or r.requested_count<>p_count or r.profile_version<>p_profile_version+1 or(p_executor is not null and p_executor<>r.executor_id)then raise exception 'REQUEST_REUSE_CONFLICT' using errcode='55000';end if;
  return to_jsonb(r);
 end if;
 insert into public.team_catalog_updaters(team_id)values(p_team)on conflict do nothing;
 perform 1 from public.team_catalog_updaters where team_id=p_team for update;
 select * into c from public.team_product_catalogs where material_id=p_catalog and team_id=p_team for update;
 select * into p from public.team_catalog_update_profiles where catalog_material_id=p_catalog and team_id=p_team for update;
 if c.material_id is null or c.video_material_id is null or not exists(select 1 from private.live_product_catalogs(p_team)live where live.catalog_material_id=p_catalog and live.video_material_id=c.video_material_id)or p.catalog_material_id is null or p.version is distinct from p_profile_version then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_count is null or p_count not between 1 and c.product_count then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 ctx:=public.service_initial_catalog_video_context(p_team,p_actor,c.video_material_id,p_executor,true);
 if ctx#>>'{defaults,configured}' is distinct from 'true' then raise exception 'RESTITCH_INVALID' using errcode='55000';end if;
 insert into public.team_catalog_updater_items(catalog_material_id,team_id)values(p_catalog,p_team)on conflict do nothing;
 select * into i from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team for update;
 if i.round_due_at is not null or i.reconciliation_required or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog)or exists(select 1 from private.catalog_restitch_jobs where catalog_material_id=p_catalog and state='leased' and lease_expires_at>clock_timestamp())or exists(select 1 from private.catalog_restitch_operations x join public.team_operations o on o.id=x.operation_id where x.catalog_material_id=p_catalog and o.state in('pending','running'))then raise exception 'WRONG_STATE' using errcode='55000';end if;
 update public.team_catalog_update_profiles set video_variant_count=p_count,version=version+1,updated_by=p_actor,updated_at=clock_timestamp()where catalog_material_id=p_catalog;
 previous_actor:=current_setting('soty.catalog_video_actor',true);
 perform pg_catalog.set_config('soty.catalog_video_actor',p_actor::text,true);
 perform pg_catalog.set_config('soty.catalog_manual_run','on',true);
 update public.team_catalog_updater_items set round_due_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '1 minute',lease_owner='catalog-variants:'||p_request::text,lease_expires_at='infinity',attempts=0 where catalog_material_id=p_catalog returning * into i;
 perform pg_catalog.set_config('soty.catalog_manual_run','off',true);
 perform pg_catalog.set_config('soty.catalog_video_actor',coalesce(previous_actor,''),true);
 select attempt_id into attempt from public.team_catalog_update_attempts where catalog_material_id=p_catalog and team_id=p_team and round_due_at=i.round_due_at;
 if attempt is null then raise exception 'INVALID_RESPONSE' using errcode='55000';end if;
 select jsonb_agg(gen_random_uuid())into rows from generate_series(1,c.product_count);
 select jsonb_agg(gen_random_uuid())into children from generate_series(1,p_count);
 insert into private.catalog_updater_variant_requests(request_id,team_id,actor_id,catalog_material_id,attempt_id,source_material_id,requested_count,product_count,profile_version,executor_id,settings_snapshot,provider_context,recipe_row_ids,child_request_ids,assignment_seed)
 values(p_request,p_team,p_actor,p_catalog,attempt,c.video_material_id,p_count,c.product_count,p.version+1,(ctx->>'executorId')::uuid,ctx->'defaults',ctx->'material',rows,children,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text))returning * into r;
 update private.catalog_updater_variant_requests v set publication_revision=coalesce(policy_snapshot.revision,0),publication_mode=coalesce(policy_snapshot.mode,'immediate'),publication_due=policy_snapshot.due_at,publication_zone=policy_snapshot.time_zone from(select pol.revision,pol.mode,pol.due_at,pol.time_zone from(values(1))singleton(n)left join private.catalog_video_publication_policies pol on pol.catalog_material_id=p_catalog)policy_snapshot where v.request_id=p_request returning v.*into r;
 return to_jsonb(r);
end;$$;

create or replace function public.service_read_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;s private.catalog_video_sets%rowtype;ready integer;wanted uuid;snap private.catalog_variant_round_snapshots%rowtype;original_state text;
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_request is null then
  select x.request_id into wanted from(select v.request_id,v.created_at from private.catalog_updater_variant_requests v where v.team_id=p_team and v.actor_id=p_actor and v.catalog_material_id=p_catalog union all select n.attempt_id,n.created_at from private.catalog_variant_round_snapshots n where n.team_id=p_team and n.actor_id=p_actor and n.catalog_material_id=p_catalog and not exists(select 1 from private.catalog_updater_variant_requests v where v.attempt_id=n.attempt_id))x order by x.created_at desc,x.request_id desc limit 1;
  if wanted is null then return null;end if;
  return public.service_read_catalog_updater_variants(p_team,p_actor,p_catalog,wanted);
 end if;
 select * into r from private.catalog_updater_variant_requests where team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog and(p_request is null or request_id=p_request)order by created_at desc limit 1;
 if r.request_id is null then
  select *into snap from private.catalog_variant_round_snapshots where attempt_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog;
  if snap.attempt_id is null then return null;end if;
  select result into original_state from public.team_catalog_update_attempts where attempt_id=snap.attempt_id;
  return jsonb_build_object('requestId',snap.attempt_id,'setId',snap.set_id,'state',case when original_state='cancelled'then 'canceled'else 'accepted'end,'requestedCount',snap.requested_count,'registeredCount',0,'recipeRevision',1,'profileVersion',snap.profile_version,'lastProvenStage','admitted','failureCode',snap.failure_code,'publicationBlockedReason',null,'publicationState',null,'serverNow',floor(extract(epoch from clock_timestamp())*1000)::bigint);
 end if;
 select * into s from private.catalog_video_sets where id=r.set_id and team_id=p_team;
 select count(*)into ready from private.catalog_video_variants where video_set_id=r.set_id and state='registered';
 return jsonb_build_object('requestId',r.request_id,'setId',r.set_id,'state',case when r.canceled_at is not null then 'canceled' else coalesce(s.state,'accepted')end,'requestedCount',r.requested_count,'registeredCount',ready,'recipeRevision',1,'profileVersion',r.profile_version,'publicationBlockedReason',(select j.blocked_reason from private.catalog_video_publication_jobs j where j.command_id=r.publication_request_id order by j.created_at desc limit 1),'publicationState',(select j.state from private.catalog_video_publication_jobs j where j.command_id=r.publication_request_id order by j.created_at desc limit 1),'lastProvenStage',r.last_proven_stage,'failureCode',coalesce(r.failure_code,private.catalog_video_failure_code(r.set_id)),'serverNow',floor(extract(epoch from clock_timestamp())*1000)::bigint);
end;$$;

create or replace function public.service_resume_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog and canceled_at is null;
 if r.request_id is null then return public.service_adopt_catalog_variant_round(p_team,p_actor,p_catalog,p_request);end if;
 return to_jsonb(r);
end;$$;

create or replace function public.service_cancel_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;snap private.catalog_variant_round_snapshots%rowtype;a public.team_catalog_update_attempts%rowtype;item public.team_catalog_updater_items%rowtype;
begin
 if private.can(p_team,'process',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform 1 from public.team_catalog_updaters where team_id=p_team for update;
 perform 1 from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team for update;
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog for update;
 if r.request_id is null then
  select *into snap from private.catalog_variant_round_snapshots where attempt_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog;
  if snap.attempt_id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
  select *into a from public.team_catalog_update_attempts where attempt_id=p_request and team_id=p_team for update;
  if a.result='cancelled'then return public.service_read_catalog_updater_variants(p_team,p_actor,p_catalog,p_request);end if;
  select *into item from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team;
  if a.result<>'running'or item.round_due_at is distinct from a.round_due_at or item.reconciliation_required or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog)or(item.lease_expires_at>clock_timestamp()and item.lease_owner is not null)then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
  update public.team_catalog_update_attempts set result='cancelled',ended_at=clock_timestamp()where attempt_id=p_request;
  update public.team_catalog_updater_items set round_due_at=null,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()where catalog_material_id=p_catalog and team_id=p_team and round_due_at=a.round_due_at;
  insert into public.team_catalog_events(team_id,material_id,event_kind)values(p_team,p_catalog,'sync_state');
  return public.service_read_catalog_updater_variants(p_team,p_actor,p_catalog,p_request);
 end if;
 perform private.hold_catalog_updater_variant_publication(r);
 update private.catalog_updater_variant_requests set canceled_at=coalesce(canceled_at,clock_timestamp())where request_id=p_request;
 update public.team_catalog_update_attempts set result='cancelled',ended_at=coalesce(ended_at,clock_timestamp())where attempt_id=r.attempt_id and result='running';
 update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');
 update public.team_catalog_updater_items set round_due_at=null,next_attempt_at=clock_timestamp(),lease_owner=null,lease_expires_at=null where catalog_material_id=p_catalog and team_id=p_team and lease_owner='catalog-variants:'||p_request::text;
 return public.service_read_catalog_updater_variants(p_team,p_actor,p_catalog,p_request);
end;$$;

create or replace view public.analytics_catalog_updater_video_requests with (security_barrier=true) as
select r.request_id,r.set_id video_set_id,r.team_id,r.actor_id,r.catalog_material_id,r.attempt_id,
 r.requested_count,r.profile_version,r.created_at,r.last_proven_stage,r.canceled_at is not null canceled,
 s.id is null set_admission_missing,coalesce(s.state,'accepted') state,
 to_jsonb(r)->>'failure_code' is not null failure_observed,
 case when to_jsonb(r)->>'failure_code' in('SOURCE_CHANGED','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','NOT_FOUND','RESTITCH_INVALID','PROCESS_RESULT_UNCERTAIN','RESTITCH_NO_SCREENS','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED','RESTITCH_CLIENT_OUTDATED','RESTITCH_FORBIDDEN','RESTITCH_POOL_EMPTY','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_SOURCE_FORBIDDEN') then to_jsonb(r)->>'failure_code' end safe_failure_code
from private.catalog_updater_variant_requests r left join private.catalog_video_sets s on s.id=r.set_id
union all
select n.attempt_id,n.set_id,n.team_id,n.actor_id,n.catalog_material_id,n.attempt_id,n.requested_count,n.profile_version,n.created_at,'admitted'::text,a.result='cancelled',true,case when a.result='cancelled'then 'canceled'else 'accepted'end,n.failure_code is not null,n.failure_code
from private.catalog_variant_round_snapshots n join public.team_catalog_update_attempts a on a.attempt_id=n.attempt_id and a.team_id=n.team_id where not exists(select 1 from private.catalog_updater_variant_requests r where r.attempt_id=n.attempt_id);

create function public.service_resume_catalog_variant_round(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid,p_executor uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select *into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog and canceled_at is null;
 if r.request_id is not null then return to_jsonb(r);end if;
 return public.service_adopt_catalog_variant_round(p_team,p_actor,p_catalog,p_request,p_executor);
end;$$;
revoke all on function public.service_resume_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_resume_catalog_variant_round(uuid,uuid,uuid,uuid,uuid)to service_role;

create function public.service_note_catalog_variant_round_failure(p_team uuid,p_actor uuid,p_attempt uuid,p_code text)returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.catalog_variant_round_snapshots n join public.team_catalog_update_attempts a on a.attempt_id=n.attempt_id where n.attempt_id=p_attempt and n.team_id=p_team and n.actor_id=p_actor and a.result='running')then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 perform private.note_catalog_variant_round_wait(p_attempt,p_code);
 update private.catalog_updater_variant_requests set failure_code='PROCESS_RESULT_UNCERTAIN',last_error_at=clock_timestamp()where attempt_id=p_attempt and team_id=p_team and actor_id=p_actor and canceled_at is null and failure_code is null;
end;$$;
revoke all on function public.service_note_catalog_variant_round_failure(uuid,uuid,uuid,text)from public,anon,authenticated;
grant execute on function public.service_note_catalog_variant_round_failure(uuid,uuid,uuid,text)to service_role;

create or replace function private.cancel_displaced_catalog_variants()returns trigger language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if new.round_due_at is not distinct from old.round_due_at and new.lease_owner is null and exists(select 1 from private.catalog_updater_variant_requests v join private.catalog_variant_round_snapshots n on n.attempt_id=v.attempt_id where v.team_id=old.team_id and v.catalog_material_id=old.catalog_material_id and 'catalog-variants:'||v.request_id::text=old.lease_owner and n.source_kind='updater'and n.regular_released and n.regular_verified_at is null and v.canceled_at is null)then return new;end if;
 if old.lease_owner like 'catalog-variants:%' and(new.round_due_at is distinct from old.round_due_at or new.lease_owner is distinct from old.lease_owner)then
  for r in select * from private.catalog_updater_variant_requests where catalog_material_id=old.catalog_material_id and team_id=old.team_id and 'catalog-variants:'||request_id::text=old.lease_owner and canceled_at is null for update loop
   if exists(select 1 from public.team_catalog_update_attempts a join private.catalog_video_deliveries d on d.catalog_material_id=r.catalog_material_id and d.team_id=r.team_id join private.catalog_publication_targets t on t.id=d.target_id and t.team_id=d.team_id where a.attempt_id=r.attempt_id and a.result='success'and t.video_set_id=r.set_id and t.recipe_revision=1)then continue;end if;
   perform private.hold_catalog_updater_variant_publication(r);
   update private.catalog_updater_variant_requests set canceled_at=clock_timestamp()where request_id=r.request_id;
   update public.team_catalog_update_attempts set result='cancelled',ended_at=coalesce(ended_at,clock_timestamp())where attempt_id=r.attempt_id and result='running';
   update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');
  end loop;
 end if;
 return new;
end;$$;

-- Release only the original ordinary stage after its exact pending recipe is bound.
create function public.service_release_catalog_variant_regular(p_team uuid,p_request uuid)returns boolean language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;n private.catalog_variant_round_snapshots%rowtype;a public.team_catalog_update_attempts%rowtype;
begin
 perform 1 from public.team_catalog_updaters where team_id=p_team for update;
 select *into r from private.catalog_updater_variant_requests where team_id=p_team and request_id=p_request;
 if r.request_id is null then return false;end if;
 perform 1 from public.team_catalog_updater_items where team_id=p_team and catalog_material_id=r.catalog_material_id for update;
 select *into a from public.team_catalog_update_attempts where attempt_id=r.attempt_id and team_id=p_team for update;
 select *into n from private.catalog_variant_round_snapshots where attempt_id=r.attempt_id and team_id=p_team for update;
 if n.attempt_id is null or n.source_kind<>'updater'or n.regular_verified_at is not null or r.canceled_at is not null or a.result<>'running'or r.publication_receipt is null then return false;end if;
 if not exists(select 1 from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id join private.catalog_video_sets vs on vs.id=t.video_set_id and vs.team_id=t.team_id where p.catalog_material_id=r.catalog_material_id and p.team_id=p_team and t.video_set_id=r.set_id and t.recipe_revision=1 and vs.state='ready')then return false;end if;
 update private.catalog_variant_round_snapshots set regular_released=true where attempt_id=n.attempt_id;
 update public.team_catalog_updater_items set lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()where team_id=p_team and catalog_material_id=r.catalog_material_id and round_due_at=a.round_due_at and lease_owner='catalog-variants:'||r.request_id::text;
 return true;
end;$$;
revoke all on function public.service_release_catalog_variant_regular(uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_release_catalog_variant_regular(uuid,uuid)to service_role;
create function public.service_release_catalog_variant_regulars(p_limit integer default 3)returns integer language plpgsql security definer set search_path='' as $$
declare r record;k integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 for r in select v.team_id,v.request_id from private.catalog_updater_variant_requests v join private.catalog_variant_round_snapshots n on n.attempt_id=v.attempt_id where n.source_kind='updater'and not n.regular_released and n.regular_verified_at is null and v.publication_receipt is not null and v.canceled_at is null order by v.created_at,v.request_id limit p_limit loop
 if public.service_release_catalog_variant_regular(r.team_id,r.request_id)then k:=k+1;end if;
 end loop;return k;
end;$$;
revoke all on function public.service_release_catalog_variant_regulars(integer)from public,anon,authenticated;
grant execute on function public.service_release_catalog_variant_regulars(integer)to service_role;
-- Final delivery closes the SAME original attempt only after ordinary readback.
create function public.service_settle_catalog_variant_deliveries(p_limit integer default 3)returns integer language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;n private.catalog_variant_round_snapshots%rowtype;a public.team_catalog_update_attempts%rowtype;candidate record;settled integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 for candidate in select v.request_id,v.team_id,v.catalog_material_id from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a0 on a0.attempt_id=v.attempt_id join private.catalog_video_deliveries d on d.catalog_material_id=v.catalog_material_id and d.team_id=v.team_id join private.catalog_publication_targets t on t.id=d.target_id and t.team_id=d.team_id where t.video_set_id=v.set_id and t.recipe_revision=1 and v.canceled_at is null and a0.result='running'order by v.created_at,v.request_id limit p_limit loop
 perform 1 from public.team_catalog_updaters where team_id=candidate.team_id for update;
 perform 1 from public.team_catalog_updater_items where catalog_material_id=candidate.catalog_material_id and team_id=candidate.team_id for update;
 select *into r from private.catalog_updater_variant_requests where request_id=candidate.request_id for update;
 select *into a from public.team_catalog_update_attempts where attempt_id=r.attempt_id for update;
 select *into n from private.catalog_variant_round_snapshots where attempt_id=r.attempt_id;
 if r.canceled_at is not null or a.result<>'running'or(n.source_kind='updater'and n.regular_verified_at is null)then continue;end if;
 if not exists(select 1 from private.catalog_video_deliveries d join private.catalog_publication_targets t on t.id=d.target_id and t.team_id=d.team_id where d.catalog_material_id=r.catalog_material_id and d.team_id=r.team_id and t.video_set_id=r.set_id and t.recipe_revision=1)then continue;end if;
 update public.team_catalog_update_attempts set result='success',failure_code=null,ended_at=clock_timestamp()where attempt_id=a.attempt_id;
 update public.team_catalog_updater_items set round_due_at=null,lease_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()where team_id=r.team_id and catalog_material_id=r.catalog_material_id and round_due_at=a.round_due_at;
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(r.team_id,r.catalog_material_id,'sync_state');
 settled:=settled+1;
 end loop;
 return settled;
end;$$;
revoke all on function public.service_settle_catalog_variant_deliveries(integer)from public,anon,authenticated;
grant execute on function public.service_settle_catalog_variant_deliveries(integer)to service_role;
create function private.catalog_registry_video_generation(p_team uuid,p_catalog uuid)returns jsonb language plpgsql stable security definer set search_path='' as $$
declare sid uuid;n integer;st text;k integer;child uuid;
begin
 select v.set_id into sid from private.catalog_updater_variant_requests v join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id where v.team_id=p_team and v.catalog_material_id=p_catalog and a.result in('running','unknown')and v.canceled_at is null order by v.created_at desc limit 1;
 if sid is null then select n0.set_id into sid from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then select t.video_set_id into sid from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id where p.team_id=p_team and p.catalog_material_id=p_catalog and t.kind='video_set';end if;
 if sid is null then select s.id into sid from private.catalog_video_sets s join private.catalog_generation_intents g on g.id=s.catalog_intent_id where g.team_id=p_team and g.result->'catalog'->>'materialId'=p_catalog::text order by s.created_at desc limit 1;end if;
 if sid is null then select n0.set_id,n0.requested_count into sid,n from private.catalog_variant_round_snapshots n0 join public.team_catalog_update_attempts a on a.attempt_id=n0.attempt_id where n0.team_id=p_team and n0.catalog_material_id=p_catalog and a.result in('running','unknown')order by n0.created_at desc limit 1;end if;
 if sid is null then return null;end if;
 select s.requested_count,s.state into n,st from private.catalog_video_sets s where s.id=sid and s.team_id=p_team;
 if not found then select requested_count into n from private.catalog_variant_round_snapshots where set_id=sid and team_id=p_team;st:='accepted';end if;
 select count(*)::integer into k from private.catalog_video_variants where video_set_id=sid and state='registered';
 select operation_id into child from private.catalog_video_variants where video_set_id=sid and state in('working','unknown')order by video_variant_index limit 1;
 return jsonb_strip_nulls(jsonb_build_object('setId',sid,'requestedCount',n,'registeredCount',k,'state',st,'activeChildOperationId',child));
end;$$;
revoke all on function private.catalog_registry_video_generation(uuid,uuid)from public,anon,authenticated,service_role;
alter function private.launch_catalog_recovery_due()rename to launch_catalog_recovery_due_before_variant_rounds;
revoke all on function private.launch_catalog_recovery_due_before_variant_rounds()from public,anon,authenticated,service_role;
create function private.launch_catalog_recovery_due()returns boolean language sql stable security definer set search_path=''as $$
 select private.launch_catalog_recovery_due_before_variant_rounds()or jsonb_array_length(public.service_list_catalog_variant_rounds(1))>0 or exists(select 1 from private.catalog_updater_variant_requests v join private.catalog_variant_round_snapshots n on n.attempt_id=v.attempt_id join public.team_catalog_update_attempts a on a.attempt_id=v.attempt_id where a.result='running'and v.canceled_at is null and ((n.source_kind='updater'and not n.regular_released and v.publication_receipt is not null)or exists(select 1 from private.catalog_video_deliveries d join private.catalog_publication_targets t on t.id=d.target_id and t.team_id=d.team_id where d.catalog_material_id=v.catalog_material_id and d.team_id=v.team_id and t.video_set_id=v.set_id)))
$$;
revoke all on function private.launch_catalog_recovery_due()from public,anon,authenticated,service_role;
commit;
