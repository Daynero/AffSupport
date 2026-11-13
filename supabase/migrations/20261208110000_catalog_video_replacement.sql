-- A source-only publication over the existing video-cell writer. No catalog regeneration.
begin;
create table private.catalog_video_replacements (
 request_id uuid primary key,
 team_id uuid not null references public.teams(id),
 actor_id uuid not null references auth.users(id),
 catalog_material_id uuid not null references public.team_product_catalogs(material_id),
 source_material_id uuid not null references public.team_materials(id),
 old_video_material_id uuid not null references public.team_materials(id),
 request jsonb not null,
 source_version text not null,
 catalog_file_id text not null,
 catalog_name text not null,
 original_parent_id text not null,
 destination_parent_id text not null,
 connection_id uuid not null references public.team_drive_connections(id),
 move_to_video_folder boolean not null,
 publication_job_id uuid references private.catalog_video_publication_jobs(id),
 state text not null default 'publishing' check(state in('publishing','moving','confirmed','blocked')),
 error_code text check(error_code is null or error_code ~ '^[A-Z_]{2,64}$'),
 move_etag text,
 move_dispatched_at timestamptz,
 lease_owner uuid,
 lease_until timestamptz,
 next_check_at timestamptz not null default clock_timestamp(),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 confirmed_at timestamptz,
 check((state='confirmed')=(confirmed_at is not null))
);
create unique index catalog_video_replacement_active on private.catalog_video_replacements(catalog_material_id) where state<>'confirmed';
alter table private.catalog_video_replacements enable row level security;
alter table private.catalog_video_replacements force row level security;
revoke all on private.catalog_video_replacements from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_replacements for each row execute function private.guard_task_cleanup_reference();

create table private.catalog_video_replacement_absences(
 request_id uuid primary key,team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),catalog_material_id uuid not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(catalog_material_id,team_id)references public.team_materials(id,team_id)
);
alter table private.catalog_video_replacement_absences enable row level security;
alter table private.catalog_video_replacement_absences force row level security;
revoke all on private.catalog_video_replacement_absences from public,anon,authenticated,service_role;
create trigger task_cleanup_reference_fence before insert or update on private.catalog_video_replacement_absences for each row execute function private.guard_task_cleanup_reference();

create function private.catalog_video_replacement_receipt(p_request uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('teamId',r.team_id,'catalogId',r.catalog_material_id,'requestId',r.request_id,'newVideoId',r.source_material_id,'state',r.state,'errorCode',r.error_code)
 from private.catalog_video_replacements r where request_id=p_request
$$;
create function private.catalog_video_replacement_blocker(p_team uuid,p_catalog uuid) returns text language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from private.catalog_video_replacements where team_id=p_team and catalog_material_id=p_catalog and state<>'confirmed') then return 'pending';end if;
 if exists(select 1 from public.team_catalog_updater_items where catalog_material_id=p_catalog and (round_due_at is not null or reconciliation_required or lease_expires_at>clock_timestamp()))
 or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog)
 or exists(select 1 from public.team_operations where team_id=p_team and source_material_id=p_catalog and state in('pending','running'))
 or exists(select 1 from private.catalog_rename_requests where team_id=p_team and material_id=p_catalog and state='pending') then return 'updating';end if;
 if exists(select 1 from private.catalog_restitch_jobs where catalog_material_id=p_catalog and state='leased')
 or exists(select 1 from public.team_catalog_restitch_copies where catalog_material_id=p_catalog and role='spare')
 or exists(select 1 from private.catalog_updater_variant_requests where catalog_material_id=p_catalog and canceled_at is null)
 or exists(select 1 from private.catalog_restitch_operations h join public.team_operations o on o.id=h.operation_id where h.catalog_material_id=p_catalog and o.state in('pending','running')) then return 'restitch';end if;
 if not exists(select 1 from private.catalog_video_publication_policies p join private.catalog_video_deliveries d on d.catalog_material_id=p.catalog_material_id and d.target_id=p.target_id where p.catalog_material_id=p_catalog and p.mode='immediate' and not p.legacy_delivery_unverified) then return 'legacy';end if;
 if exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and state not in('published','superseded'))then return 'publication';end if;
 return null;
end $$;
create function public.service_catalog_video_replacement_context(p_team uuid,p_catalog uuid,p_actor uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.team_product_catalogs%rowtype;m public.team_materials%rowtype;v public.team_materials%rowtype;active uuid;version_token text;
begin
 if p_actor is null or private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select*into c from public.team_product_catalogs where material_id=p_catalog and team_id=p_team;
 select*into m from public.team_materials where id=p_catalog and team_id=p_team and lifecycle='active';
 select*into v from public.team_materials where id=c.video_material_id and team_id=p_team and lifecycle='active';
 if c.material_id is null or m.id is null or v.id is null then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 select request_id into active from private.catalog_video_replacements where catalog_material_id=p_catalog and state<>'confirmed';
 version_token:=encode(sha256(convert_to(jsonb_build_object('material',m.updated_at,'video',c.video_material_id,'profile',(select version from public.team_catalog_update_profiles where catalog_material_id=p_catalog),'publication',(select revision from private.catalog_video_publication_policies where catalog_material_id=p_catalog))::text,'UTF8')),'hex');
 return jsonb_build_object('teamId',p_team,'catalogId',p_catalog,'catalogName',m.name,'currentVideoId',v.id,'currentVideoName',v.name,'version',version_token,'blockedReason',private.catalog_video_replacement_blocker(p_team,p_catalog),'active',private.catalog_video_replacement_receipt(active));
end $$;

create function private.guard_catalog_video_replacement() returns trigger language plpgsql security definer set search_path='' as $$
declare catalog uuid;affected uuid[];r private.catalog_video_replacements%rowtype;allowed text:=current_setting('soty.catalog_video_replacement',true);
begin
 if tg_table_name='team_materials' then
  select*into r from private.catalog_video_replacements where team_id=new.team_id and state<>'confirmed' and new.id in(catalog_material_id,source_material_id) order by request_id limit 1;
  if r.request_id is null or allowed=r.request_id::text then return new;end if;
  if new.name is distinct from old.name or new.lifecycle is distinct from old.lifecycle or new.parent_folder_id is distinct from old.parent_folder_id or new.connection_id is distinct from old.connection_id or new.drive_file_id is distinct from old.drive_file_id or new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes or new.mime_type is distinct from old.mime_type then raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';end if;
  return new;
 elsif tg_table_name='team_operations' then
  if new.kind not in('rename','move','content_edit','new_version','trash')or new.source_material_id is null or new.state not in('pending','running') then return new;end if;
  perform m.id from public.team_materials m where m.team_id=new.team_id and m.id=new.source_material_id for update;
  with recursive descendants as (
   select id,drive_file_id,connection_id,kind from public.team_materials where team_id=new.team_id and id=new.source_material_id
   union select m.id,m.drive_file_id,m.connection_id,m.kind from public.team_materials m join descendants d on d.kind='folder'and m.parent_folder_id=d.drive_file_id and m.connection_id=d.connection_id where m.team_id=new.team_id
  )select array_agg(m.id)into affected from public.team_materials m where m.team_id=new.team_id and(m.id in(select id from descendants)or m.companion_of in(select id from descendants));
  perform m.id from public.team_materials m where m.id=any(affected)order by m.id for update;
  if exists(select 1 from private.catalog_video_replacements where team_id=new.team_id and state<>'confirmed'and(catalog_material_id=any(affected)or source_material_id=any(affected))) then raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';end if;
  return new;
 elsif tg_table_name='team_product_catalogs' then catalog:=new.material_id;
 else catalog:=new.catalog_material_id;end if;
 perform 1 from public.team_materials where id=catalog for update;
 select*into r from private.catalog_video_replacements where catalog_material_id=catalog and state<>'confirmed';
 if r.request_id is null or allowed=r.request_id::text then return new;end if;
 if tg_table_name='team_catalog_updater_items' then
  if tg_op='UPDATE'and to_jsonb(new)=to_jsonb(old) then return new;end if;
 elsif tg_table_name='catalog_video_publication_jobs' then
  if new.command_id=r.request_id then return new;end if;
 elsif tg_table_name='catalog_video_publication_policies' then
  if tg_op='UPDATE'and new.revision=old.revision and new.target_id=old.target_id and new.mode=old.mode and new.due_at is not distinct from old.due_at and new.actor_id=old.actor_id then return new;end if;
 end if;
 raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';
end $$;
create trigger video_replacement_material_fence before update on public.team_materials for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_catalog_fence before update on public.team_product_catalogs for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_operation_fence before insert or update on public.team_operations for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_updater_fence before insert or update on public.team_catalog_updater_items for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_profile_fence before update on public.team_catalog_update_profiles for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_policy_fence before insert or update on private.catalog_video_publication_policies for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_publication_fence before insert on private.catalog_video_publication_jobs for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_variants_fence before insert or update on private.catalog_updater_variant_requests for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_round_fence before insert or update on private.catalog_variant_round_snapshots for each row execute function private.guard_catalog_video_replacement();
create trigger video_replacement_r2_fence before insert or update on private.catalog_video_r2_preferences for each row execute function private.guard_catalog_video_replacement();

create or replace function private.catalog_restitch_job_blockers(p_catalog uuid)
returns text[] language sql stable security definer set search_path='' as $$
 select array_remove(array[
 case when exists(select 1 from private.catalog_video_replacements where catalog_material_id=p_catalog and state<>'confirmed')then 'job_leased'end,
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

-- Existing Launch generation/SUB-binding guards already lock these material rows.
create or replace function private.assert_catalogs_not_renaming(p_team uuid,p_materials uuid[])returns void language plpgsql security definer set search_path=''as $$
begin
 perform m.id from public.team_materials m where m.team_id=p_team and m.id=any(p_materials)order by m.id for update;
 if exists(select 1 from private.catalog_rename_requests where team_id=p_team and material_id=any(p_materials)and state='pending')then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
 if exists(select 1 from private.catalog_video_replacements where team_id=p_team and catalog_material_id=any(p_materials)and state<>'confirmed')then raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';end if;
end $$;

create function public.service_accept_catalog_video_replacement(p_team uuid,p_catalog uuid,p_actor uuid,p_request jsonb) returns jsonb language plpgsql security definer set search_path=''as $$
declare key uuid:=(p_request->>'requestId')::uuid;video uuid:=(p_request->>'newVideoId')::uuid;r private.catalog_video_replacements%rowtype;m public.team_materials%rowtype;v public.team_materials%rowtype;c public.team_product_catalogs%rowtype;context jsonb;p private.catalog_video_publication_policies%rowtype;job uuid;
begin
 if p_actor is null or private.can(p_team,'edit',p_actor)is not true or private.can(p_team,'process',p_actor)is not true or p_request->>'expectedActorId' is distinct from p_actor::text then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if key is null or video is null or p_request->>'teamId' is distinct from p_team::text or p_request->>'catalogId' is distinct from p_catalog::text or jsonb_typeof(p_request->'moveToVideoFolder')is distinct from 'boolean' then raise exception 'INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-replacement:'||key::text,0));
 if exists(select 1 from private.catalog_video_replacement_absences where request_id=key)then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 select*into r from private.catalog_video_replacements where request_id=key;
 if r.request_id is not null then
  if r.team_id<>p_team or r.actor_id<>p_actor or r.catalog_material_id<>p_catalog or r.request is distinct from p_request then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;
  return private.catalog_video_replacement_receipt(key);
 end if;
 perform id from public.team_materials where team_id=p_team and id in(p_catalog,video)order by id for update;
 select*into m from public.team_materials where id=p_catalog and team_id=p_team and lifecycle='active';
 select*into v from public.team_materials where id=video and team_id=p_team and lifecycle='active' and category='video' and kind='file';
 select*into c from public.team_product_catalogs where material_id=p_catalog and team_id=p_team for update;
 if m.id is null or v.id is null or c.material_id is null or c.video_material_id=video or m.connection_id<>v.connection_id or m.parent_folder_id is null or v.parent_folder_id is null or m.mime_type<>'application/vnd.google-apps.spreadsheet' then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 if exists(with recursive ancestors as(
  select id,connection_id,drive_file_id,parent_folder_id from public.team_materials where team_id=p_team and id in(p_catalog,video,c.video_material_id)
  union select parent.id,parent.connection_id,parent.drive_file_id,parent.parent_folder_id from public.team_materials parent join ancestors child on parent.connection_id=child.connection_id and parent.drive_file_id=child.parent_folder_id where parent.team_id=p_team and parent.kind='folder'
 )select 1 from public.team_operations where team_id=p_team and source_material_id in(select id from ancestors)and state in('pending','running')and kind in('rename','move','content_edit','new_version','trash')) then raise exception 'WRONG_STATE'using errcode='55000';end if;
 perform private.assert_catalog_rename_quiescent(p_team,p_catalog);
 context:=public.service_catalog_video_replacement_context(p_team,p_catalog,p_actor);
 if context->>'blockedReason'is not null then raise exception 'CATALOG_PUBLICATION_PENDING'using errcode='55000';end if;
 if context->>'version'is distinct from p_request->>'expectedVersion' then raise exception 'STALE_RESULT'using errcode='55000';end if;
 select*into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog for update;
 insert into private.catalog_video_replacements(request_id,team_id,actor_id,catalog_material_id,source_material_id,old_video_material_id,request,source_version,catalog_file_id,catalog_name,original_parent_id,destination_parent_id,connection_id,move_to_video_folder)
 values(key,p_team,p_actor,p_catalog,video,c.video_material_id,p_request,private.catalog_publication_source_version(video,p_team),m.drive_file_id,m.name,m.parent_folder_id,case when(p_request->>'moveToVideoFolder')::boolean then v.parent_folder_id else m.parent_folder_id end,m.connection_id,(p_request->>'moveToVideoFolder')::boolean);
 perform set_config('soty.catalog_video_replacement',key::text,true);
 update public.team_catalog_updater_items set reconciliation_required=true where catalog_material_id=p_catalog;
 perform public.service_save_catalog_publication(p_team,p_actor,key,p_catalog,p.revision,'immediate',null,null,jsonb_build_object('kind','source','materialId',video,'sourceVersion',private.catalog_publication_source_version(video,p_team)));
 select id into job from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and command_id=key;
 if job is null then raise exception 'INVALID_RESPONSE';end if;
 update private.catalog_video_replacements set publication_job_id=job where request_id=key;
 perform set_config('soty.catalog_video_replacement','',true);
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(p_team,p_catalog,'upserted');
 return private.catalog_video_replacement_receipt(key);
end $$;

create function public.service_catalog_video_replacement_status(p_team uuid,p_catalog uuid,p_actor uuid,p_request uuid)returns jsonb language plpgsql security definer set search_path=''as $$
begin
 if private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if not exists(select 1 from public.team_product_catalogs where material_id=p_catalog and team_id=p_team)then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-replacement:'||p_request::text,0));
 if not exists(select 1 from private.catalog_video_replacements where request_id=p_request)then
  insert into private.catalog_video_replacement_absences(request_id,team_id,actor_id,catalog_material_id)values(p_request,p_team,p_actor,p_catalog)on conflict do nothing;
  return null;
 end if;
 if not exists(select 1 from private.catalog_video_replacements where request_id=p_request and team_id=p_team and catalog_material_id=p_catalog)then raise exception 'REQUEST_REUSE_CONFLICT';end if;
 return private.catalog_video_replacement_receipt(p_request);
end $$;

create function public.service_claim_catalog_video_replacement(p_request uuid,p_worker uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_video_replacements%rowtype;j private.catalog_video_publication_jobs%rowtype;conn public.team_drive_connections%rowtype;
begin
 select*into r from private.catalog_video_replacements where request_id=p_request and state<>'confirmed'and next_check_at<=clock_timestamp()and(lease_until is null or lease_until<=clock_timestamp())for update skip locked;
 if r.request_id is null then return null;end if;
 if private.can(r.team_id,'edit',r.actor_id)is not true or private.can(r.team_id,'process',r.actor_id)is not true then update private.catalog_video_replacements set state='blocked',error_code='PERMISSION_DENIED',updated_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '60 seconds'where request_id=r.request_id;return null;end if;
 select*into j from private.catalog_video_publication_jobs where id=r.publication_job_id;
 if j.state<>'published' then
  update private.catalog_video_replacements set error_code=case when j.state in('blocked','unknown')then 'PROCESS_RESULT_UNCERTAIN'else null end,next_check_at=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()where request_id=r.request_id;
  return null;
 end if;
 if not private.catalog_publication_source_matches(r.source_material_id,r.team_id,r.source_version) then
  update private.catalog_video_replacements set state='blocked',error_code='SOURCE_CHANGED',updated_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '60 seconds'where request_id=r.request_id;return null;
 end if;
 select*into conn from public.team_drive_connections where id=r.connection_id and team_id=r.team_id and state='connected';
 if conn.id is null then update private.catalog_video_replacements set state='blocked',error_code='DRIVE_UNAVAILABLE',updated_at=clock_timestamp(),next_check_at=clock_timestamp()+interval '60 seconds'where request_id=r.request_id;return null;end if;
 update private.catalog_video_replacements set lease_owner=p_worker,lease_until=clock_timestamp()+interval '90 seconds',state='moving',updated_at=clock_timestamp()where request_id=r.request_id;
 return to_jsonb(r)||jsonb_build_object('rootFolderId',conn.root_folder_id,'credentialId',conn.credential_id,'sourceFileId',(select drive_file_id from public.team_materials where id=r.source_material_id),'sourceResourceKey',(select resource_key from public.team_materials where id=r.source_material_id),'frozen',(select payload from private.catalog_publication_cell_writes where job_id=j.id));
end $$;
create function public.service_prepare_catalog_video_move(p_request uuid,p_worker uuid,p_etag text)returns boolean language plpgsql security definer set search_path=''as $$
declare r private.catalog_video_replacements%rowtype;
begin
 select*into r from private.catalog_video_replacements where request_id=p_request and lease_owner=p_worker and lease_until>clock_timestamp()for update;
 if r.request_id is null or r.state='confirmed' or (r.move_dispatched_at is not null and r.move_etag is distinct from p_etag) or p_etag is null or p_etag!~'^"[!#-~]+"$'then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if private.can(r.team_id,'edit',r.actor_id)is not true or private.can(r.team_id,'process',r.actor_id)is not true then raise exception 'PERMISSION_DENIED';end if;
 update private.catalog_video_replacements set move_etag=p_etag,move_dispatched_at=clock_timestamp(),updated_at=clock_timestamp()where request_id=p_request;
 return true;
end $$;
create function public.service_finish_catalog_video_replacement(p_request uuid,p_worker uuid,p_observed jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_video_replacements%rowtype;j private.catalog_video_publication_jobs%rowtype;link text;
begin
 select*into r from private.catalog_video_replacements where request_id=p_request and lease_owner=p_worker and lease_until>clock_timestamp()for update;
 if r.request_id is null then raise exception 'WRONG_STATE';end if;
 if private.can(r.team_id,'edit',r.actor_id)is not true or private.can(r.team_id,'process',r.actor_id)is not true then raise exception 'PERMISSION_DENIED';end if;
 perform id from public.team_materials where team_id=r.team_id and id in(r.catalog_material_id,r.source_material_id)order by id for update;
 select*into j from private.catalog_video_publication_jobs where id=r.publication_job_id and state='published' and target_id=(select target_id from private.catalog_video_publication_policies where catalog_material_id=r.catalog_material_id);
 if j.id is null or not private.catalog_publication_source_matches(r.source_material_id,r.team_id,r.source_version) or not exists(select 1 from public.team_materials where id=r.source_material_id and team_id=r.team_id and lifecycle='active'and connection_id=r.connection_id and (not r.move_to_video_folder or parent_folder_id=r.destination_parent_id))then raise exception 'SOURCE_CHANGED';end if;
 if p_observed->>'id'is distinct from r.catalog_file_id or p_observed->>'name'is distinct from r.catalog_name or p_observed->>'parentId'is distinct from r.destination_parent_id or p_observed->>'version'is null then raise exception 'SOURCE_CHANGED';end if;
 select url into link from private.catalog_publication_link_receipts where job_id=j.id and material_id=r.source_material_id and source_version=r.source_version;
 if link is null then raise exception 'PROCESS_RESULT_UNCERTAIN';end if;
 perform set_config('soty.catalog_video_replacement',r.request_id::text,true);
 update public.team_product_catalogs set video_material_id=r.source_material_id,video_link=link,current_video_link=null where material_id=r.catalog_material_id and video_material_id=r.old_video_material_id;
 if not found then raise exception 'SOURCE_CHANGED';end if;
 update public.team_materials set companion_of=r.source_material_id,companion_kind='product_catalog',parent_folder_id=r.destination_parent_id,drive_version=p_observed->>'version',updated_at=clock_timestamp()where id=r.catalog_material_id and team_id=r.team_id and lifecycle='active'and drive_file_id=r.catalog_file_id;
 if not found then raise exception 'SOURCE_CHANGED';end if;
 update private.catalog_video_replacements set state='confirmed',confirmed_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=null,lease_owner=null,lease_until=null where request_id=p_request;
 update public.team_catalog_updater_items set reconciliation_required=false where catalog_material_id=r.catalog_material_id;
 perform set_config('soty.catalog_video_replacement','',true);
 insert into public.team_catalog_events(team_id,material_id,event_kind)values(r.team_id,r.catalog_material_id,'upserted');
 return private.catalog_video_replacement_receipt(p_request);
end $$;
create function public.service_defer_catalog_video_replacement(p_request uuid,p_worker uuid,p_code text)returns void language sql security definer set search_path=''as $$
 update private.catalog_video_replacements set error_code=case when p_code in('SOURCE_CHANGED','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','PROCESS_RESULT_UNCERTAIN','INVALID_RESPONSE')then p_code else 'PROCESS_RESULT_UNCERTAIN'end,lease_owner=null,lease_until=null,next_check_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()where request_id=p_request and lease_owner=p_worker and state<>'confirmed'
$$;
create function public.service_due_catalog_video_replacements(p_limit integer default 3)returns jsonb language sql stable security definer set search_path=''as $$
 select coalesce(jsonb_agg(request_id),'[]'::jsonb)from(select request_id from private.catalog_video_replacements where state<>'confirmed'and next_check_at<=clock_timestamp()and(lease_until is null or lease_until<=clock_timestamp())order by next_check_at,request_id limit least(greatest(p_limit,1),3))r
$$;

create or replace function private.catalog_publication_work_due(p_recent boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from private.catalog_video_publication_jobs q
  join private.catalog_video_publication_policies p on p.catalog_material_id=q.catalog_material_id and p.revision=q.revision
  where q.next_attempt_at<=clock_timestamp()
   and (q.lease_until is null or q.lease_until<=clock_timestamp())
   and (p.mode='immediate' or (p.mode='scheduled' and p.due_at<=clock_timestamp()))
   and (
    (q.state in('waiting','preparing','retry_wait') and q.dispatched_at is null
     and (not p_recent or coalesce(p.due_at,q.created_at)>clock_timestamp()-interval '30 minutes'))
    or (q.state in('applying','verifying','unknown') and q.dispatched_at is not null and q.writer_fence is not null
     and (not p_recent or q.dispatched_at>clock_timestamp()-interval '5 minutes'))
   )
   and private.catalog_connection_usable(q.catalog_material_id)
 ) or exists(select 1 from private.catalog_video_replacements r join private.catalog_video_publication_jobs j on j.id=r.publication_job_id where r.state<>'confirmed' and j.state='published' and r.next_check_at<=clock_timestamp() and(r.lease_until is null or r.lease_until<=clock_timestamp()))
$$;

revoke all on function private.catalog_video_replacement_receipt(uuid),private.catalog_video_replacement_blocker(uuid,uuid),private.guard_catalog_video_replacement()from public,anon,authenticated,service_role;
revoke all on function public.service_catalog_video_replacement_context(uuid,uuid,uuid),public.service_accept_catalog_video_replacement(uuid,uuid,uuid,jsonb),public.service_catalog_video_replacement_status(uuid,uuid,uuid,uuid),public.service_claim_catalog_video_replacement(uuid,uuid),public.service_prepare_catalog_video_move(uuid,uuid,text),public.service_finish_catalog_video_replacement(uuid,uuid,jsonb),public.service_defer_catalog_video_replacement(uuid,uuid,text),public.service_due_catalog_video_replacements(integer)from public,anon,authenticated;
grant execute on function public.service_catalog_video_replacement_context(uuid,uuid,uuid),public.service_accept_catalog_video_replacement(uuid,uuid,uuid,jsonb),public.service_catalog_video_replacement_status(uuid,uuid,uuid,uuid),public.service_claim_catalog_video_replacement(uuid,uuid),public.service_prepare_catalog_video_move(uuid,uuid,text),public.service_finish_catalog_video_replacement(uuid,uuid,jsonb),public.service_defer_catalog_video_replacement(uuid,uuid,text),public.service_due_catalog_video_replacements(integer)to service_role;
create view public.analytics_catalog_video_replacements with(security_barrier=true)as select request_id,team_id,actor_id,catalog_material_id,source_material_id,publication_job_id,state,error_code,move_to_video_folder,move_dispatched_at is not null move_dispatched,created_at,updated_at,confirmed_at from private.catalog_video_replacements;
revoke all on public.analytics_catalog_video_replacements from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_catalog_video_replacements to wishly_analytics_ro;end if;end $$;
commit;
