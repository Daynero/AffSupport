begin;
alter table public.team_catalog_update_profiles add column video_variant_count integer not null default 1 check(video_variant_count between 1 and 400);
create table private.catalog_updater_variant_requests(
 request_id uuid primary key,team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),catalog_material_id uuid not null,attempt_id uuid not null unique,
 set_id uuid not null unique default gen_random_uuid(),source_material_id uuid not null,requested_count integer not null check(requested_count between 1 and 400),product_count integer not null check(product_count between 1 and 400),
 publication_request_id uuid not null default gen_random_uuid(),publication_cancel_id uuid not null default gen_random_uuid(),publication_revision bigint not null default 0,publication_mode text not null default 'immediate',publication_due timestamptz,publication_zone text,publication_receipt jsonb,
 profile_version bigint not null,executor_id uuid not null,settings_snapshot jsonb not null,provider_context jsonb not null,recipe_row_ids jsonb not null,child_request_ids jsonb not null,assignment_seed text not null,
 last_proven_stage text not null default 'admitted' check(last_proven_stage in('admitted','source_proven','set_admitted')),failure_code text check(failure_code in('RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_INVALID','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED')),last_error_at timestamptz,
 canceled_at timestamptz,created_at timestamptz not null default clock_timestamp(),
 foreign key(catalog_material_id,team_id)references public.team_materials(id,team_id),foreign key(attempt_id,team_id)references public.team_catalog_update_attempts(attempt_id,team_id),foreign key(source_material_id,team_id)references public.team_materials(id,team_id),check(requested_count<=product_count)
);
alter table private.catalog_updater_variant_requests enable row level security;
alter table private.catalog_updater_variant_requests force row level security;
revoke all on private.catalog_updater_variant_requests from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_updater_variant_requests for each row execute function private.guard_task_cleanup_reference();
create function public.service_read_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;s private.catalog_video_sets%rowtype;ready integer;
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_updater_variant_requests where team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog and(p_request is null or request_id=p_request)order by created_at desc limit 1;
 if r.request_id is null then return null;end if;
 select * into s from private.catalog_video_sets where id=r.set_id and team_id=p_team;
 select count(*)into ready from private.catalog_video_variants where video_set_id=r.set_id and state='registered';
 return jsonb_build_object('requestId',r.request_id,'setId',r.set_id,'state',case when r.canceled_at is not null then 'canceled' else coalesce(s.state,'accepted')end,'requestedCount',r.requested_count,'registeredCount',ready,'recipeRevision',1,'profileVersion',r.profile_version,'publicationBlockedReason',(select j.blocked_reason from private.catalog_video_publication_jobs j where j.command_id=r.publication_request_id order by j.created_at desc limit 1),'publicationState',(select j.state from private.catalog_video_publication_jobs j where j.command_id=r.publication_request_id order by j.created_at desc limit 1),'lastProvenStage',r.last_proven_stage,'failureCode',coalesce(r.failure_code,private.catalog_video_failure_code(r.set_id)),'serverNow',floor(extract(epoch from clock_timestamp())*1000)::bigint);
end;$$;
create function public.service_accept_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid,p_count integer,p_profile_version bigint,p_executor uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;c public.team_product_catalogs%rowtype;p public.team_catalog_update_profiles%rowtype;i public.team_catalog_updater_items%rowtype;ctx jsonb;attempt uuid;rows jsonb;children jsonb;
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
 perform pg_catalog.set_config('soty.catalog_manual_run','on',true);
 update public.team_catalog_updater_items set round_due_at=clock_timestamp(),next_attempt_at='infinity',lease_owner='catalog-variants:'||p_request::text,lease_expires_at='infinity',attempts=0 where catalog_material_id=p_catalog returning * into i;
 perform pg_catalog.set_config('soty.catalog_manual_run','off',true);
 select attempt_id into attempt from public.team_catalog_update_attempts where catalog_material_id=p_catalog and team_id=p_team and round_due_at=i.round_due_at;
 if attempt is null then raise exception 'INVALID_RESPONSE' using errcode='55000';end if;
 select jsonb_agg(gen_random_uuid())into rows from generate_series(1,c.product_count);
 select jsonb_agg(gen_random_uuid())into children from generate_series(1,p_count);
 insert into private.catalog_updater_variant_requests(request_id,team_id,actor_id,catalog_material_id,attempt_id,source_material_id,requested_count,product_count,profile_version,executor_id,settings_snapshot,provider_context,recipe_row_ids,child_request_ids,assignment_seed)
 values(p_request,p_team,p_actor,p_catalog,attempt,c.video_material_id,p_count,c.product_count,p.version+1,(ctx->>'executorId')::uuid,ctx->'defaults',ctx->'material',rows,children,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text))returning * into r;
 update private.catalog_updater_variant_requests v set publication_revision=coalesce(policy_snapshot.revision,0),publication_mode=coalesce(policy_snapshot.mode,'immediate'),publication_due=policy_snapshot.due_at,publication_zone=policy_snapshot.time_zone from(select pol.revision,pol.mode,pol.due_at,pol.time_zone from(values(1))singleton(n)left join private.catalog_video_publication_policies pol on pol.catalog_material_id=p_catalog)policy_snapshot where v.request_id=p_request returning v.*into r;
 return to_jsonb(r);
end;$$;
create function public.service_cancel_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if private.can(p_team,'process',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform 1 from public.team_catalog_updaters where team_id=p_team for update;
 perform 1 from public.team_catalog_updater_items where catalog_material_id=p_catalog and team_id=p_team for update;
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog for update;
 if r.request_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 perform private.hold_catalog_updater_variant_publication(r);
 update private.catalog_updater_variant_requests set canceled_at=coalesce(canceled_at,clock_timestamp())where request_id=p_request;
 update public.team_catalog_update_attempts set result='cancelled',ended_at=coalesce(ended_at,clock_timestamp())where attempt_id=r.attempt_id and result='running';
 update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');
 update public.team_catalog_updater_items set round_due_at=null,next_attempt_at=clock_timestamp(),lease_owner=null,lease_expires_at=null where catalog_material_id=p_catalog and team_id=p_team and lease_owner='catalog-variants:'||p_request::text;
 return public.service_read_catalog_updater_variants(p_team,p_actor,p_catalog,p_request);
end;$$;
revoke all on function public.service_read_catalog_updater_variants(uuid,uuid,uuid,uuid),public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid),public.service_cancel_catalog_updater_variants(uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_read_catalog_updater_variants(uuid,uuid,uuid,uuid),public.service_accept_catalog_updater_variants(uuid,uuid,uuid,uuid,integer,bigint,uuid),public.service_cancel_catalog_updater_variants(uuid,uuid,uuid,uuid)to service_role;
create or replace function private.catalog_restitch_job_blockers(p_catalog uuid)
returns text[] language sql stable security definer set search_path='' as $$
 select array_remove(array[
 case when exists(select 1 from private.catalog_updater_variant_requests v where v.catalog_material_id=p_catalog and v.canceled_at is null)then 'job_leased'end,
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

create function private.cancel_displaced_catalog_variants()returns trigger language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if old.lease_owner like 'catalog-variants:%' and(new.round_due_at is distinct from old.round_due_at or new.lease_owner is distinct from old.lease_owner)then
  for r in select * from private.catalog_updater_variant_requests where catalog_material_id=old.catalog_material_id and team_id=old.team_id and 'catalog-variants:'||request_id::text=old.lease_owner and canceled_at is null for update loop
   perform private.hold_catalog_updater_variant_publication(r);
   update private.catalog_updater_variant_requests set canceled_at=clock_timestamp()where request_id=r.request_id;
   update public.team_catalog_update_attempts set result='cancelled',ended_at=coalesce(ended_at,clock_timestamp())where attempt_id=r.attempt_id and result='running';
   update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=r.set_id and state in('working','unknown'))then 'cancel_requested'else 'canceled'end,revision=revision+1 where id=r.set_id and state not in('cancel_requested','canceled');
  end loop;
 end if;
 return new;
end;$$;
create trigger catalog_variants_displaced after update on public.team_catalog_updater_items for each row execute function private.cancel_displaced_catalog_variants();
revoke all on function private.cancel_displaced_catalog_variants()from public,anon,authenticated,service_role;

create function public.service_catalog_updater_variant_outputs(p_team uuid,p_actor uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;outputs jsonb;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and canceled_at is null;
 if r.request_id is null or not exists(select 1 from private.catalog_video_sets s where s.id=r.set_id and s.team_id=p_team and s.state='ready')or not exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=r.set_id and ref.team_id=p_team and ref.recipe_revision=1 and ref.update_attempt_id=r.attempt_id and ref.actor_id=p_actor and ref.catalog_material_id=r.catalog_material_id)then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if(select count(*)from private.catalog_video_variants where video_set_id=r.set_id and state='registered')<>r.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team left join public.team_drive_connections c on c.id=m.connection_id and c.team_id=p_team where v.video_set_id=r.set_id and(v.state<>'registered'or m.lifecycle is distinct from 'active'or c.state is distinct from 'connected'))then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select jsonb_agg(jsonb_build_object('rowId',a.recipe_row_id,'ordinal',rowslot.ordinality,'materialId',m.id,'connectionId',m.connection_id,'sourceVersion',private.catalog_publication_source_version(m.id,p_team),'fileId',m.drive_file_id,'credentialId',c.credential_id,'rootFolderId',c.root_folder_id)order by rowslot.ordinality)into outputs
 from jsonb_array_elements_text(r.recipe_row_ids)with ordinality rowslot(id,ordinality)join private.catalog_video_assignments a on a.recipe_row_id=rowslot.id::uuid and a.video_set_id=r.set_id and a.recipe_revision=1 join private.catalog_video_variants v on v.video_set_id=a.video_set_id and v.video_variant_index=a.video_variant_index join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team join public.team_drive_connections c on c.id=m.connection_id and c.team_id=p_team;
 if jsonb_array_length(outputs)is distinct from r.product_count then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return outputs;
end;$$;
revoke all on function public.service_catalog_updater_variant_outputs(uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_catalog_updater_variant_outputs(uuid,uuid,uuid)to service_role;

create function public.service_resume_catalog_updater_variants(p_team uuid,p_actor uuid,p_catalog uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or private.can(p_team,'upload',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog and canceled_at is null;
 if r.request_id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return to_jsonb(r);
end;$$;
revoke all on function public.service_resume_catalog_updater_variants(uuid,uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_resume_catalog_updater_variants(uuid,uuid,uuid,uuid)to service_role;

create function public.service_note_catalog_updater_variant_admission(p_team uuid,p_actor uuid,p_request uuid,p_stage text,p_code text default null)returns void language plpgsql security definer set search_path='' as $$
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_stage not in('admitted','source_proven','set_admitted')or(p_code is not null and p_code not in('RESTITCH_SCREEN_SELECTION_LIMIT','RESTITCH_FORBIDDEN','RESTITCH_NO_SCREENS','RESTITCH_INVALID','RESTITCH_POOL_EMPTY','RESTITCH_SOURCE_FORBIDDEN','RESTITCH_SOURCES_INVALID','RESTITCH_SOURCES_TOO_MANY','RESTITCH_CLIENT_OUTDATED','RESTITCH_SCREEN_CANDIDATES_EXHAUSTED','RESTITCH_SCREEN_PREVIOUS_FAILURES','RESTITCH_SCREEN_BYTE_LIMIT','RESTITCH_SCREEN_IO_LIMIT','RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN','SOURCE_CHANGED','PERMISSION_DENIED','RESTITCH_INVALID','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE','SHARE_NOT_ALLOWED'))then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_updater_variant_requests set last_proven_stage=case when last_proven_stage='set_admitted'or p_stage='set_admitted'then 'set_admitted'when last_proven_stage='source_proven'or p_stage='source_proven'then 'source_proven'else 'admitted'end,failure_code=p_code,last_error_at=case when p_code is not null then clock_timestamp()else null end where team_id=p_team and actor_id=p_actor and request_id=p_request and canceled_at is null;
end;$$;
revoke all on function public.service_note_catalog_updater_variant_admission(uuid,uuid,uuid,text,text)from public,anon,authenticated;
grant execute on function public.service_note_catalog_updater_variant_admission(uuid,uuid,uuid,text,text)to service_role;

drop function public.list_team_catalog_update_profiles(uuid);
create function public.list_team_catalog_update_profiles(p_team uuid)
returns table (
  catalog_material_id uuid, refresh_images boolean, refresh_texts boolean,
  grow_products boolean, random_link_variation boolean, restitch boolean,
  version bigint, updated_at timestamptz, last_error_at timestamptz,
  restitch_status text, restitch_blocked_code text,
  reconciliation_required boolean,
  last_result text, latest_attempt_at timestamptz, last_successful_at timestamptz, schedule jsonb,video_variant_count integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can(p_team, 'view', auth.uid()) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return query
    select profile.catalog_material_id, profile.refresh_images, profile.refresh_texts,
           profile.grow_products, profile.random_link_variation, profile.restitch,
           profile.version, profile.updated_at, catalog.last_update_error_at,
           case when private.catalog_has_usable_spare(profile.catalog_material_id) then 'ready'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id and job.state = 'leased' and job.lease_expires_at > clock_timestamp()
           ) then 'preparing'
           when exists (
             select 1 from private.catalog_restitch_jobs as job
             where job.catalog_material_id = profile.catalog_material_id
               and private.catalog_restitch_visible_error(profile.catalog_material_id) is not null
           ) then 'blocked'
           else 'waiting' end,
           private.catalog_restitch_visible_error(profile.catalog_material_id), (coalesce(item.reconciliation_required, false) or exists (
             select 1 from private.catalog_update_reconciliations pending
             where pending.catalog_material_id=profile.catalog_material_id)),
           latest.result, latest.started_at,
           (select max(attempt.delivery_verified_at)
              from public.team_catalog_update_attempts as attempt
             where attempt.catalog_material_id = profile.catalog_material_id
               and attempt.team_id = p_team
               and attempt.result = 'success'
               and attempt.delivery_verified_at is not null), profile.schedule,profile.video_variant_count
    from public.team_catalog_update_profiles as profile
    join public.team_product_catalogs as catalog
      on catalog.material_id = profile.catalog_material_id
    join private.live_product_catalogs(p_team) as live
      on live.catalog_material_id = profile.catalog_material_id
    left join public.team_catalog_updater_items as item
      on item.catalog_material_id = profile.catalog_material_id
    left join lateral (
      select attempt.result, attempt.started_at
        from public.team_catalog_update_attempts as attempt
       where attempt.catalog_material_id = profile.catalog_material_id
         and attempt.team_id = p_team
       order by attempt.started_at desc, attempt.attempt_id desc
       limit 1
    ) as latest on true
    where profile.team_id = p_team;
end;
$$;
revoke all on function public.list_team_catalog_update_profiles(uuid)from public,anon,authenticated;
grant execute on function public.list_team_catalog_update_profiles(uuid)to authenticated;

create function private.seed_initial_catalog_variant_count()returns trigger language plpgsql security definer set search_path='' as $$
declare catalog uuid;count_value integer;
begin
 if new.state='registered'and old.state is distinct from 'registered'and new.request_payload->>'catalogVideoProtocolVersion'='1'then
  catalog:=coalesce(new.checkpoint->>'materialId',new.result#>>'{catalog,materialId}')::uuid;
  count_value:=(new.request_payload->>'videoVariationCount')::integer;
  if exists(select 1 from public.team_product_catalogs c where c.material_id=catalog and c.team_id=new.team_id and count_value between 1 and c.product_count)then update public.team_catalog_update_profiles set video_variant_count=count_value where catalog_material_id=catalog and team_id=new.team_id;end if;
 end if;
 return new;
end;$$;
create trigger catalog_initial_variant_count after update on private.catalog_generation_intents for each row execute function private.seed_initial_catalog_variant_count();
revoke all on function private.seed_initial_catalog_variant_count()from public,anon,authenticated,service_role;

create function public.service_attach_catalog_updater_variant_target(p_team uuid,p_actor uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.catalog_updater_variant_requests%rowtype;receipt jsonb;mode text;due timestamptz;zone text;
begin
 if private.can(p_team,'view',p_actor)is not true or private.can(p_team,'process',p_actor)is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select *into r from private.catalog_updater_variant_requests where request_id=p_request and team_id=p_team and actor_id=p_actor for update;
 if r.request_id is null or r.canceled_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if r.publication_receipt is not null then return public.service_read_catalog_publication(p_team,p_actor,r.catalog_material_id);end if;
 perform public.service_catalog_updater_variant_outputs(p_team,p_actor,p_request);
 mode:=r.publication_mode;due:=r.publication_due;zone:=r.publication_zone;
 if mode='scheduled'and due<=clock_timestamp()then mode:='immediate';due:=null;zone:=null;end if;
 receipt:=public.service_save_catalog_publication(p_team,p_actor,r.publication_request_id,r.catalog_material_id,r.publication_revision,mode,due,zone,jsonb_build_object('kind','video_set','videoSetId',r.set_id,'recipeRevision',1));
 update private.catalog_updater_variant_requests set publication_receipt=receipt,failure_code=null,last_error_at=null,last_proven_stage='set_admitted'where request_id=p_request;
 -- The current provider API has no ratified conditional video-cell writer.
 -- Existing active delivery stays intact; the new target remains explainable.
 update private.catalog_video_publication_jobs set state='blocked',blocked_reason='writer_unsupported'where command_id=r.publication_request_id and state='waiting'and mode='immediate';
 return public.service_read_catalog_publication(p_team,p_actor,r.catalog_material_id);
end;$$;
revoke all on function public.service_attach_catalog_updater_variant_target(uuid,uuid,uuid)from public,anon,authenticated;
grant execute on function public.service_attach_catalog_updater_variant_target(uuid,uuid,uuid)to service_role;

create function private.hold_catalog_updater_variant_publication(r private.catalog_updater_variant_requests)returns void language plpgsql security definer set search_path='' as $$
declare policy private.catalog_video_publication_policies%rowtype;
begin
 if r.publication_receipt is null then return;end if;
 select p.*into policy from private.catalog_video_publication_policies p join private.catalog_publication_targets t on t.id=p.target_id and t.team_id=p.team_id where p.catalog_material_id=r.catalog_material_id and p.team_id=r.team_id and t.kind='video_set'and t.video_set_id=r.set_id and t.recipe_revision=1 and exists(select 1 from private.catalog_video_publication_jobs j where j.catalog_material_id=p.catalog_material_id and j.revision=p.revision and j.command_id=r.publication_request_id);
 if policy.catalog_material_id is null then return;end if;
 if exists(select 1 from private.catalog_video_publication_jobs j where j.command_id=r.publication_request_id and(j.dispatched_at is not null or j.state in('applying','verifying','unknown','cancel_requested')))then raise exception 'PROCESS_RESULT_UNCERTAIN'using errcode='55000';end if;
 perform public.service_save_catalog_publication(r.team_id,r.actor_id,r.publication_cancel_id,r.catalog_material_id,policy.revision,'held',null,null,jsonb_build_object('kind','video_set','videoSetId',r.set_id,'recipeRevision',1));
end;$$;
revoke all on function private.hold_catalog_updater_variant_publication(private.catalog_updater_variant_requests)from public,anon,authenticated,service_role;

create function public.service_list_catalog_updater_variant_targets(p_limit integer default 3)returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',r.team_id,'actorId',r.actor_id,'catalogMaterialId',r.catalog_material_id,'requestId',r.request_id))from(select q.*from private.catalog_updater_variant_requests q join private.catalog_video_sets s on s.id=q.set_id and s.team_id=q.team_id where q.canceled_at is null and q.publication_receipt is null and s.state='ready'and private.can(q.team_id,'view',q.actor_id)and private.can(q.team_id,'process',q.actor_id)and private.can(q.team_id,'upload',q.actor_id)order by q.created_at,q.request_id limit p_limit)r),'[]'::jsonb);
end;$$;
revoke all on function public.service_list_catalog_updater_variant_targets(integer)from public,anon,authenticated;
grant execute on function public.service_list_catalog_updater_variant_targets(integer)to service_role;

create or replace function private.launch_catalog_recovery_due() returns boolean language sql stable security definer set search_path='' as $$
 select jsonb_array_length(public.service_list_catalog_updater_variant_targets(1))>0 or jsonb_array_length(public.service_list_launch_catalog_recovery(1))>0 or jsonb_array_length(public.service_list_initial_catalog_recovery(1))>0 or exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state in('waiting','preparing','retry_wait') and j.writer_fence is null and j.dispatched_at is null and not p.legacy_delivery_unverified and p.mode<>'held' and (p.mode='immediate' or p.due_at<=statement_timestamp()) and private.can(j.team_id,'view',j.actor_id) and (private.can(j.team_id,'process',j.actor_id) or exists(select 1 from private.catalog_generation_intents original where original.id=j.command_id and original.team_id=j.team_id and original.actor_id=j.actor_id and original.request_payload->>'catalogVideoProtocolVersion'='1' and original.request_payload->>'restitchEnabled'='false' and private.can(j.team_id,'upload',j.actor_id))) and not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id))
$$;
create function private.seed_new_catalog_profile_variant_count()returns trigger language plpgsql security definer set search_path='' as $$
declare accepted integer;
begin
 if new.video_variant_count=1 then
  select(i.request_payload->>'videoVariationCount')::integer into accepted from private.catalog_generation_intents i join public.team_product_catalogs c on c.material_id=new.catalog_material_id and c.team_id=new.team_id where i.team_id=new.team_id and i.state='registered'and i.request_payload->>'catalogVideoProtocolVersion'='1'and coalesce(i.checkpoint->>'materialId',i.result#>>'{catalog,materialId}')=new.catalog_material_id::text and(i.request_payload->>'videoVariationCount')::integer between 1 and c.product_count order by i.updated_at desc limit 1;
  if accepted is not null then new.video_variant_count:=accepted;end if;
 end if;
 return new;
end;$$;
create trigger catalog_profile_initial_variant_count before insert on public.team_catalog_update_profiles for each row execute function private.seed_new_catalog_profile_variant_count();
revoke all on function private.seed_new_catalog_profile_variant_count()from public,anon,authenticated,service_role;

create function private.notify_catalog_updater_variant_request()returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT'or new.last_proven_stage is distinct from old.last_proven_stage or new.failure_code is distinct from old.failure_code or new.canceled_at is distinct from old.canceled_at or new.publication_receipt is distinct from old.publication_receipt then
  insert into public.team_catalog_events(team_id,material_id,event_kind)values(new.team_id,new.catalog_material_id,'sync_state');
 end if;
 return new;
end;$$;
create trigger catalog_updater_variant_invalidation after insert or update on private.catalog_updater_variant_requests for each row execute function private.notify_catalog_updater_variant_request();
revoke all on function private.notify_catalog_updater_variant_request()from public,anon,authenticated,service_role;

commit;
