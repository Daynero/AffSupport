-- A catalog rename was refused with SOURCE_CHANGED whenever the sheet's
-- content had moved since Soty last synced it (prod 2026-11-18: a catalog
-- registered at Drive version 4 was already at 8-10 while its first rows,
-- pictures and formatting landed; all eight attempts failed before PATCH).
-- A rename touches only metadata. What it must not race is the name itself,
-- the launches bound to that name, the file identity and its parent — all
-- still checked here, and the PATCH stays conditional on the live ETag. The
-- Drive content version and the row's updated_at (which every sync bumps)
-- are no longer part of the proof. Requests admitted under the old proof
-- fail safe with SOURCE_CHANGED and can be resubmitted.

create or replace function private.catalog_rename_context(p_team uuid,p_material uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare m public.team_materials%rowtype;names jsonb;version text;impact text;
begin
 select*into m from public.team_materials where team_id=p_team and id=p_material and lifecycle='active';
 if m.id is null or not exists(select 1 from public.team_product_catalogs where team_id=p_team and material_id=p_material)then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 names:=private.catalog_bound_names(p_team,p_material);version:=m.updated_at::text;
 impact:=encode(extensions.digest(jsonb_build_object('name',m.name,'boundNames',names)::text,'sha256'),'hex');
 return jsonb_build_object('teamId',p_team,'materialId',p_material,'currentName',m.name,'materialVersion',version,'impactVersion',impact,'boundNames',names,'requiresAcknowledgement',jsonb_array_length(names)>0);
end $$;

create or replace function public.service_accept_catalog_rename(p_team uuid,p_material uuid,p_actor uuid,p_key uuid,p_request jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;m public.team_materials%rowtype;context jsonb;op uuid;name text;
begin
 if p_actor is null or private.can(p_team,'edit',p_actor)is not true or p_request->>'expectedActorId'is distinct from p_actor::text then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if p_key is null or p_request->>'requestKey'is distinct from p_key::text or p_request->>'teamId'is distinct from p_team::text or p_request->>'materialId'is distinct from p_material::text or jsonb_typeof(p_request)is distinct from 'object'or octet_length(p_request::text)>16384 then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-rename:'||p_team::text||p_actor::text||p_key::text,0));
 if exists(select 1 from private.catalog_rename_absent_commands where team_id=p_team and actor_id=p_actor and request_key=p_key)then
  return public.service_catalog_rename_status(p_team,p_material,p_actor,p_key);
 end if;
 select*into r from private.catalog_rename_requests where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if r.id is not null then if r.request<>p_request then raise exception 'REQUEST_REUSE_CONFLICT'using errcode='55000';end if;return private.catalog_rename_receipt(r.id);end if;
 select*into m from public.team_materials where team_id=p_team and id=p_material and lifecycle='active'for update;
 context:=public.service_catalog_rename_context(p_team,p_material,p_actor);
 if context->>'impactVersion'is distinct from p_request->>'impactVersion'then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 if jsonb_typeof(p_request->'acknowledgeBoundNames')is distinct from 'boolean'or(context->'requiresAcknowledgement'='true'::jsonb and p_request->'acknowledgeBoundNames'<>'true'::jsonb)then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 name:=p_request->>'newName';
 if jsonb_typeof(p_request->'newName')is distinct from 'string'or name is null or char_length(name)not between 1 and 1024 or btrim(name)=''or name~'[[:cntrl:]]'or m.parent_folder_id is null then raise exception 'INVALID_INPUT'using errcode='22023';end if;
 if exists(select 1 from public.team_operations where team_id=p_team and source_material_id=p_material and kind in('rename','move','content_edit','new_version','trash')and state in('pending','running'))then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
 insert into private.catalog_rename_requests(team_id,material_id,actor_id,request_key,request,old_name,new_name,material_version,impact_version,drive_file_id,parent_folder_id,source_drive_version)
 values(p_team,p_material,p_actor,p_key,p_request,m.name,name,context->>'materialVersion',context->>'impactVersion',m.drive_file_id,m.parent_folder_id,m.drive_version)returning*into r;
 select operation_id into op from public.service_start_team_operation(p_team,p_actor,'rename','catalog-rename:'||p_key::text,'catalog-rename:'||p_key::text,p_material,null,null,null,null);
 perform public.service_set_team_operation_intent(op,p_actor,name,null,null,null,null,null,null);
 update private.catalog_rename_requests set operation_id=op where id=r.id;
 begin perform private.invoke_catalog_updater_worker();exception when others then null;end;
 return private.catalog_rename_receipt(r.id);
end $$;

create or replace function public.service_prepare_catalog_rename(p_operation uuid,p_owner uuid,p_etag text,p_live_name text,p_live_version text)returns boolean language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;context jsonb;
begin
 select*into r from private.catalog_rename_requests where operation_id=p_operation and attempt_owner=p_owner and lease_expires_at>clock_timestamp()and state='pending'for update;
 if r.id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if private.can(r.team_id,'edit',r.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 perform 1 from public.team_materials where team_id=r.team_id and id=r.material_id and lifecycle='active'and drive_file_id=r.drive_file_id and parent_folder_id=r.parent_folder_id for update;
 if not found then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 perform private.assert_catalog_rename_quiescent(r.team_id,r.material_id);
 if p_etag is null or char_length(p_etag)not between 3 and 512 or p_etag!~'^"[!#-~]+"$'or p_live_name is distinct from r.old_name then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 if r.original_etag is null then
  context:=private.catalog_rename_context(r.team_id,r.material_id);
  if context->>'impactVersion'<>r.impact_version then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 elsif r.original_etag<>p_etag then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 update private.catalog_rename_requests set original_etag=p_etag,dispatched_at=coalesce(dispatched_at,clock_timestamp()),attempt_count=attempt_count+1 where id=r.id;
 update public.team_operations set state='running',stage='renaming',progress=25,updated_at=clock_timestamp()where id=p_operation and state in('pending','running');
 if not found then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return true;
end $$;

create or replace function public.service_settle_catalog_rename(p_operation uuid,p_owner uuid,p_drive jsonb,p_code text default null,p_terminal boolean default false,p_retry_after_ms bigint default 0)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;m public.team_materials%rowtype;item record;
begin
 if p_retry_after_ms is null or p_retry_after_ms not between 0 and 1000000000 then raise exception 'INVALID_INPUT';end if;
 select*into r from private.catalog_rename_requests where operation_id=p_operation and(attempt_owner=p_owner or(p_owner is null and(p_drive is not null or(p_terminal and p_code='SOURCE_CHANGED'and(lease_expires_at is null or lease_expires_at<=clock_timestamp())))))and state='pending'for update;
 if r.id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if p_drive is not null then
  if private.can(r.team_id,'edit',r.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
  select*into m from public.team_materials where id=r.material_id and team_id=r.team_id for update;
  if m.lifecycle<>'active'or m.name not in(r.old_name,r.new_name)or m.drive_file_id<>r.drive_file_id or m.parent_folder_id is distinct from r.parent_folder_id or p_drive->>'driveFileId'is distinct from r.drive_file_id or p_drive->>'name'is distinct from r.new_name or p_drive->>'parentFolderId'is distinct from r.parent_folder_id or p_drive->'trashed'is distinct from 'false'::jsonb then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
  perform private.assert_catalog_rename_quiescent(r.team_id,r.material_id);
  if r.old_name<>r.new_name then insert into private.catalog_name_aliases(team_id,material_id,name,operation_id)values(r.team_id,r.material_id,r.old_name,p_operation)on conflict do nothing;end if;
  perform public.service_commit_team_material_mutation(p_operation,r.actor_id,p_drive);
  update private.catalog_rename_requests set state='confirmed',confirmed_at=clock_timestamp(),error_code=null,attempt_owner=null,lease_expires_at=null where id=r.id;
  for item in select distinct l.id,l.aggregate_version from public.team_launches l join public.team_launch_revisions v on v.launch_id=l.id and v.team_id=l.team_id join public.team_launch_revision_catalogs c on c.revision_id=v.id and c.team_id=v.team_id where c.team_id=r.team_id and c.material_id=r.material_id loop perform private.launch_signal(r.team_id,item.id,item.aggregate_version);end loop;
 else
  if p_code is null or not exists(select 1 from public.team_error_codes where code=p_code)then raise exception 'INVALID_INPUT';end if;
  update private.catalog_rename_requests set state=case when p_terminal then 'failed'else 'pending'end,error_code=p_code,attempt_owner=null,lease_expires_at=null,next_attempt_at=clock_timestamp()+greatest(p_retry_after_ms,least(900,30*power(2,least(attempt_count,5)))::bigint*1000)*interval '1 millisecond'where id=r.id;
  update public.team_operations set state=case when p_terminal then 'failed'else 'running'end,stage=case when p_terminal then 'failed'else 'reconcile_required'end,error_code=p_code,retryable=not p_terminal,finished_at=case when p_terminal then clock_timestamp()else null end,updated_at=clock_timestamp()where id=p_operation and state in('pending','running');
 end if;
 return private.catalog_rename_receipt(r.id);
end $$;
