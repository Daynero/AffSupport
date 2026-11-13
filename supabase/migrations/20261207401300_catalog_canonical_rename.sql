-- Canonical catalog metadata changes retain immutable launch/link provenance.
begin;
create table private.catalog_rename_requests (
 id uuid primary key default gen_random_uuid(),team_id uuid not null references public.teams(id),
 material_id uuid not null references public.team_materials(id),actor_id uuid not null references auth.users(id),
 request_key uuid not null,request jsonb not null,operation_id uuid references public.team_operations(id),
 old_name text not null,new_name text not null,material_version text not null,impact_version text not null,
 drive_file_id text not null,parent_folder_id text not null,source_drive_version text,
 state text not null default 'pending' check(state in('pending','confirmed','failed')),
 original_etag text,dispatched_at timestamptz,attempt_owner uuid,lease_expires_at timestamptz,
 attempt_count integer not null default 0,next_attempt_at timestamptz not null default clock_timestamp(),
 error_code text references public.team_error_codes(code),created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 confirmed_at timestamptz,unique(team_id,actor_id,request_key),unique(operation_id),
 check(char_length(old_name) between 1 and 1024),check(char_length(new_name) between 1 and 1024),
 check(octet_length(request::text)<=16384)
);
create unique index catalog_rename_one_pending on private.catalog_rename_requests(team_id,material_id) where state='pending';
create index catalog_rename_due on private.catalog_rename_requests(next_attempt_at,id) where state='pending';
create table private.catalog_rename_absent_commands(
 team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),
 material_id uuid not null,request_key uuid not null,created_at timestamptz not null default clock_timestamp(),
 primary key(team_id,actor_id,request_key)
);
create table private.catalog_name_aliases (
 team_id uuid not null references public.teams(id),material_id uuid not null references public.team_materials(id),
 name text not null check(char_length(name) between 1 and 1024),operation_id uuid not null references public.team_operations(id),
 confirmed_at timestamptz not null default clock_timestamp(),primary key(team_id,material_id,name)
);
alter table private.catalog_rename_requests enable row level security;
alter table private.catalog_rename_requests force row level security;
alter table private.catalog_name_aliases enable row level security;
alter table private.catalog_name_aliases force row level security;
alter table private.catalog_rename_absent_commands enable row level security;
alter table private.catalog_rename_absent_commands force row level security;
revoke all on private.catalog_rename_requests,private.catalog_name_aliases,private.catalog_rename_absent_commands from public,anon,authenticated,service_role;
create function private.touch_catalog_rename_request()returns trigger language plpgsql set search_path=''as $$begin new.updated_at:=clock_timestamp();return new;end $$;
create trigger touch_catalog_rename_request before update on private.catalog_rename_requests for each row execute function private.touch_catalog_rename_request();
revoke all on function private.touch_catalog_rename_request()from public,anon,authenticated,service_role;

-- Decode only for evidence matching. Original URL bytes are never rewritten.
create function private.catalog_decode_url(p_value text) returns text language plpgsql immutable set search_path='' as $$
declare result bytea:=''::bytea;i integer:=1;part text;
begin
 if p_value is null then return '';end if;
 while i<=char_length(p_value)loop
  part:=substr(p_value,i,3);
  if part~'^%[0-9a-fA-F]{2}$'then result:=result||decode(substr(part,2),'hex');i:=i+3;
  else result:=result||convert_to(substr(p_value,i,1),'UTF8');i:=i+1;end if;
 end loop;
 return convert_from(result,'UTF8');
exception when character_not_in_repertoire or untranslatable_character then return p_value;
end $$;
create function private.catalog_name_is_bound(p_name text,p_value text)returns boolean language sql immutable set search_path=''as $$
 select coalesce(p_name<>'',false)and(
  strpos(coalesce(p_value,''),p_name)>0 or strpos(private.catalog_decode_url(p_value),p_name)>0
  or strpos(private.catalog_decode_url(replace(p_value,'+',' ')),p_name)>0)
$$;
create function private.catalog_bound_names(p_team uuid,p_material uuid)returns jsonb language sql stable security definer set search_path=''as $$
 with names as(
  select name from public.team_materials where team_id=p_team and id=p_material
  union select name from private.catalog_name_aliases where team_id=p_team and material_id=p_material
  union select name_snapshot from public.team_launch_revision_catalogs where team_id=p_team and material_id=p_material
 ),evidence as(
  select c.source_link value from public.team_product_catalogs c where c.team_id=p_team and c.material_id=p_material
  union all select r.generated_url from public.team_launch_revision_catalogs c join public.team_launch_revisions r on r.id=c.revision_id and r.team_id=c.team_id where c.team_id=p_team and c.material_id=p_material
  union all select v.value#>>'{}' from public.team_launch_revision_catalogs c join public.team_launch_revisions r on r.id=c.revision_id and r.team_id=c.team_id cross join lateral jsonb_each(r.sub_values)v where c.team_id=p_team and c.material_id=p_material and jsonb_typeof(v.value)='string'
  union all select i.checkpoint#>>'{launchSubBinding,name}' from private.catalog_generation_intents i
   join public.team_launch_generations g on g.team_id=i.team_id and g.actor_id=i.actor_id and i.request_key='launch:'||g.id::text||':catalog'
   join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id
   where i.team_id=p_team and i.state='registered'and i.result#>>'{catalog,materialId}'=p_material::text
    and i.checkpoint#>>'{launchSubBinding,advertisingUrl}'=r.generated_url and i.checkpoint#>'{launchSubBinding,subValues}'=r.sub_values
 )select coalesce(jsonb_agg(name order by name),'[]')from names where exists(select 1 from evidence where private.catalog_name_is_bound(names.name,evidence.value))
$$;
create function private.catalog_rename_context(p_team uuid,p_material uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare m public.team_materials%rowtype;names jsonb;version text;impact text;
begin
 select*into m from public.team_materials where team_id=p_team and id=p_material and lifecycle='active';
 if m.id is null or not exists(select 1 from public.team_product_catalogs where team_id=p_team and material_id=p_material)then raise exception 'NOT_FOUND'using errcode='P0002';end if;
 names:=private.catalog_bound_names(p_team,p_material);version:=m.updated_at::text;
 impact:=encode(extensions.digest(jsonb_build_object('name',m.name,'version',version,'driveVersion',m.drive_version,'boundNames',names)::text,'sha256'),'hex');
 return jsonb_build_object('teamId',p_team,'materialId',p_material,'currentName',m.name,'materialVersion',version,'impactVersion',impact,'boundNames',names,'requiresAcknowledgement',jsonb_array_length(names)>0);
end $$;
create function private.assert_catalog_rename_quiescent(p_team uuid,p_material uuid)returns void language plpgsql security definer set search_path=''as $$
begin
 if exists(
  select 1 from public.team_launch_generations g join public.team_launch_revisions r on r.id=g.revision_id and r.team_id=g.team_id
  where g.team_id=p_team and g.state not in('succeeded','canceled')and(
   exists(select 1 from public.team_launch_revision_catalogs c where c.team_id=p_team and c.material_id=p_material and c.revision_id in(r.id,r.baseline_revision_id,r.base_revision_id))
   or exists(select 1 from private.catalog_generation_intents i where i.team_id=p_team and i.actor_id=g.actor_id and i.request_key='launch:'||g.id::text||':catalog'and(p_material::text in(i.checkpoint->>'materialId',i.result#>>'{catalog,materialId}')))
  )
 )then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
end $$;
create function public.service_catalog_rename_context(p_team uuid,p_material uuid,p_actor uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
begin
 if p_actor is null or private.can(p_team,'edit',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 perform private.assert_catalog_rename_quiescent(p_team,p_material);
 return private.catalog_rename_context(p_team,p_material);
end $$;
-- Serialize the inverse direction on the same material row as rename admission.
-- A generation admitted later must not freeze/reuse a name while its provider
-- rename is unresolved; late attachment and SUB binding obey the same fence.
create function private.assert_catalogs_not_renaming(p_team uuid,p_materials uuid[])returns void language plpgsql security definer set search_path=''as $$
begin
 perform m.id from public.team_materials m where m.team_id=p_team and m.id=any(p_materials)order by m.id for update;
 if exists(select 1 from private.catalog_rename_requests where team_id=p_team and material_id=any(p_materials)and state='pending')then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
end $$;
create function private.guard_generation_catalog_rename()returns trigger language plpgsql security definer set search_path=''as $$
declare materials uuid[];
begin
 if new.state in('succeeded','canceled')then return new;end if;
 select array_agg(distinct material_id)into materials from(
  select c.material_id from public.team_launch_revisions r join public.team_launch_revision_catalogs c on c.team_id=r.team_id and c.revision_id in(r.id,r.base_revision_id,r.baseline_revision_id)where r.team_id=new.team_id and r.id=new.revision_id
  union select m.id from private.catalog_generation_intents i join public.team_materials m on m.team_id=i.team_id and m.id::text in(i.checkpoint->>'materialId',i.result#>>'{catalog,materialId}')where i.team_id=new.team_id and i.actor_id=new.actor_id and i.request_key='launch:'||new.id::text||':catalog'
 )refs;
 perform private.assert_catalogs_not_renaming(new.team_id,materials);
 return new;
end $$;
create trigger generation_catalog_rename_fence before insert or update of state,revision_id on public.team_launch_generations for each row execute function private.guard_generation_catalog_rename();
create function private.guard_catalog_rename_binding()returns trigger language plpgsql security definer set search_path=''as $$
declare materials uuid[];
begin
 if tg_table_name='team_launch_revision_catalogs'then materials:=array[new.material_id];
 else
  if tg_op='UPDATE'and old.checkpoint->'launchSubBinding'is not distinct from new.checkpoint->'launchSubBinding'and old.checkpoint->'materialId'is not distinct from new.checkpoint->'materialId'and old.result#>'{catalog,materialId}'is not distinct from new.result#>'{catalog,materialId}'then return new;end if;
  select array_agg(id)into materials from public.team_materials where team_id=new.team_id and id::text in(new.checkpoint->>'materialId',new.result#>>'{catalog,materialId}');
 end if;
 perform private.assert_catalogs_not_renaming(new.team_id,materials);
 return new;
end $$;
create trigger revision_catalog_rename_fence before insert or update on public.team_launch_revision_catalogs for each row execute function private.guard_catalog_rename_binding();
create trigger catalog_intent_rename_fence before insert or update of checkpoint,result on private.catalog_generation_intents for each row execute function private.guard_catalog_rename_binding();
revoke all on function private.assert_catalogs_not_renaming(uuid,uuid[]),private.guard_generation_catalog_rename(),private.guard_catalog_rename_binding()from public,anon,authenticated,service_role;
create function private.catalog_rename_receipt(p_id uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('teamId',r.team_id,'materialId',r.material_id,'requestKey',r.request_key,'operationId',r.operation_id,'state',r.state,'currentName',case when r.state='confirmed'then m.name else null end,'errorCode',r.error_code)
 from private.catalog_rename_requests r join public.team_materials m on m.id=r.material_id and m.team_id=r.team_id where r.id=p_id
$$;
create function public.service_catalog_rename_status(p_team uuid,p_material uuid,p_actor uuid,p_key uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;
begin
 if p_actor is null or private.can(p_team,'view',p_actor)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 if p_key is null or p_material is null then raise exception 'INVALID_INPUT';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-rename:'||p_team::text||p_actor::text||p_key::text,0));
 select*into r from private.catalog_rename_requests where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if r.id is not null then
  if r.material_id<>p_material then raise exception 'REQUEST_REUSE_CONFLICT';end if;
  return private.catalog_rename_receipt(r.id);
 end if;
 if exists(select 1 from private.catalog_rename_absent_commands where team_id=p_team and actor_id=p_actor and request_key=p_key and material_id<>p_material)then raise exception 'REQUEST_REUSE_CONFLICT';end if;
 -- Fence the absent command before acknowledging it: a delayed original POST
 -- cannot arrive after this reply and issue an invisible provider mutation.
 insert into private.catalog_rename_absent_commands(team_id,actor_id,material_id,request_key)values(p_team,p_actor,p_material,p_key)on conflict do nothing;
 return jsonb_build_object('teamId',p_team,'materialId',p_material,'requestKey',p_key,'operationId',null,'state','failed','currentName',null,'errorCode','NOT_FOUND');
end $$;

-- Keep all ordinary output guards; only an admitted canonical rename receives
-- the narrow exception. A pending rename also fences destructive sibling work.
create or replace function private.guard_launch_output_operation()returns trigger language plpgsql security definer set search_path=''as $$
declare affected uuid[];admitted boolean;
begin
 if new.kind not in('rename','move','content_edit','new_version','trash')or new.source_material_id is null then return new;end if;
 if new.kind='trash'and exists(select 1 from public.team_materials where id=new.source_material_id and team_id=new.team_id and kind='folder')then
  with recursive descendants(id,drive_file_id,connection_id)as(
   select id,drive_file_id,connection_id from public.team_materials where id=new.source_material_id and team_id=new.team_id
   union select m.id,m.drive_file_id,m.connection_id from public.team_materials m join descendants d on m.parent_folder_id=d.drive_file_id and m.connection_id=d.connection_id where m.team_id=new.team_id
  )select array_agg(id order by id)into affected from descendants;
 else affected:=array[new.source_material_id];end if;
 perform 1 from public.team_materials where team_id=new.team_id and id=any(affected)order by id for update;
 admitted:=new.kind='rename'and exists(select 1 from private.catalog_rename_requests r where r.team_id=new.team_id and r.actor_id=new.actor_id and r.material_id=new.source_material_id and r.state='pending'and new.idempotency_key='catalog-rename:'||r.request_key::text and(r.operation_id is null or r.operation_id=new.id));
 if exists(select 1 from private.catalog_rename_requests r where r.team_id=new.team_id and r.material_id=any(affected)and r.state='pending'and not(admitted and r.material_id=new.source_material_id))then raise exception 'LAUNCH_BUSY'using errcode='55000';end if;
 if admitted then perform private.assert_catalog_rename_quiescent(new.team_id,new.source_material_id);
 elsif new.kind<>'trash'and exists(select 1 from unnest(affected)id where private.launch_output_is_referenced(new.team_id,id))then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return new;
end $$;

create function public.service_accept_catalog_rename(p_team uuid,p_material uuid,p_actor uuid,p_key uuid,p_request jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
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
 if context->>'materialVersion'is distinct from p_request->>'expectedMaterialVersion'or context->>'impactVersion'is distinct from p_request->>'impactVersion'then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
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

create function public.service_claim_catalog_rename(p_team uuid,p_material uuid,p_actor uuid,p_key uuid,p_owner uuid)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;
begin
 select*into r from private.catalog_rename_requests where team_id=p_team and material_id=p_material and actor_id=p_actor and request_key=p_key and state='pending'for update skip locked;
 if r.id is null or r.lease_expires_at>clock_timestamp()or r.next_attempt_at>clock_timestamp()then return null;end if;
 if p_owner is not null then update private.catalog_rename_requests set attempt_owner=p_owner,lease_expires_at=clock_timestamp()+interval '30 seconds'where id=r.id;end if;
 return jsonb_build_object('id',r.id,'operationId',r.operation_id,'teamId',r.team_id,'materialId',r.material_id,'actorId',r.actor_id,'requestKey',r.request_key,'oldName',r.old_name,'newName',r.new_name,'fileId',r.drive_file_id,'parentId',r.parent_folder_id,'driveVersion',r.source_drive_version,'etag',r.original_etag,'dispatched',r.dispatched_at is not null);
end $$;
create function public.service_prepare_catalog_rename(p_operation uuid,p_owner uuid,p_etag text,p_live_name text,p_live_version text)returns boolean language plpgsql security definer set search_path=''as $$
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
  if context->>'impactVersion'<>r.impact_version or p_live_version is distinct from r.source_drive_version then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 elsif r.original_etag<>p_etag then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
 update private.catalog_rename_requests set original_etag=p_etag,dispatched_at=coalesce(dispatched_at,clock_timestamp()),attempt_count=attempt_count+1 where id=r.id;
 update public.team_operations set state='running',stage='renaming',progress=25,updated_at=clock_timestamp()where id=p_operation and state in('pending','running');
 if not found then raise exception 'WRONG_STATE'using errcode='55000';end if;
 return true;
end $$;
create function public.service_settle_catalog_rename(p_operation uuid,p_owner uuid,p_drive jsonb,p_code text default null,p_terminal boolean default false,p_retry_after_ms bigint default 0)returns jsonb language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;m public.team_materials%rowtype;item record;
begin
 if p_retry_after_ms is null or p_retry_after_ms not between 0 and 1000000000 then raise exception 'INVALID_INPUT';end if;
 select*into r from private.catalog_rename_requests where operation_id=p_operation and(attempt_owner=p_owner or(p_owner is null and(p_drive is not null or(p_terminal and p_code='SOURCE_CHANGED'and(lease_expires_at is null or lease_expires_at<=clock_timestamp())))))and state='pending'for update;
 if r.id is null then raise exception 'WRONG_STATE'using errcode='55000';end if;
 if p_drive is not null then
  if private.can(r.team_id,'edit',r.actor_id)is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
  select*into m from public.team_materials where id=r.material_id and team_id=r.team_id for update;
  if m.lifecycle<>'active'or m.name not in(r.old_name,r.new_name)or(m.drive_version is distinct from r.source_drive_version and m.drive_version is distinct from p_drive->>'driveVersion')or m.drive_file_id<>r.drive_file_id or m.parent_folder_id is distinct from r.parent_folder_id or p_drive->>'driveFileId'is distinct from r.drive_file_id or p_drive->>'name'is distinct from r.new_name or p_drive->>'parentFolderId'is distinct from r.parent_folder_id or p_drive->'trashed'is distinct from 'false'::jsonb then raise exception 'SOURCE_CHANGED'using errcode='55000';end if;
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
create function public.service_due_catalog_renames(p_limit integer default 3)returns jsonb language plpgsql stable security definer set search_path=''as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',r.team_id,'materialId',r.material_id,'actorId',r.actor_id,'requestKey',r.request_key))from(select*from private.catalog_rename_requests where state='pending'and next_attempt_at<=clock_timestamp()and(lease_expires_at is null or lease_expires_at<=clock_timestamp())order by next_attempt_at,id limit p_limit)r),'[]');
end $$;

-- Before dispatch cancellation is definite. Once a conditional write may have
-- reached Google, generic cancel must not claim that the metadata was undone.
alter function public.cancel_team_operation(uuid,uuid)rename to cancel_team_operation_before_catalog_rename;
alter function public.cancel_team_operation_before_catalog_rename(uuid,uuid)set schema private;
create function public.cancel_team_operation(p_team uuid,p_operation uuid)returns table(
 id uuid,team_id uuid,kind text,state text,stage text,progress integer,source_material_id uuid,result_material_id uuid,error_code text,retryable boolean,created_at timestamptz,updated_at timestamptz
)language plpgsql security definer set search_path=''as $$
declare r private.catalog_rename_requests%rowtype;
begin
 if auth.uid()is null or private.can(p_team,'view',auth.uid())is not true then raise exception 'PERMISSION_DENIED'using errcode='42501';end if;
 select*into r from private.catalog_rename_requests where catalog_rename_requests.team_id=p_team and operation_id=p_operation and actor_id=auth.uid()for update;
 if r.id is not null and r.state='pending'then
  if r.dispatched_at is not null then raise exception 'WRONG_STATE'using errcode='55000';end if;
  update private.catalog_rename_requests set state='failed',error_code='PROCESS_CANCELED',attempt_owner=null,lease_expires_at=null where catalog_rename_requests.id=r.id;
 end if;
 return query select*from private.cancel_team_operation_before_catalog_rename(p_team,p_operation);
end $$;
revoke all on function private.cancel_team_operation_before_catalog_rename(uuid,uuid)from public,anon,authenticated,service_role;
revoke all on function public.cancel_team_operation(uuid,uuid)from public,anon;
grant execute on function public.cancel_team_operation(uuid,uuid)to authenticated;

-- No alias enters search until the same transaction confirms canonical rename.
create or replace function private.refresh_team_material_search()returns trigger language plpgsql security definer set search_path=''as $$
begin
 new.search_tsv:=private.material_search_document(new.name,new.tags,new.geo,new.language,new.offer,new.note,new.transcript_text)||setweight(to_tsvector('simple'::regconfig,coalesce((select string_agg(a.name,' ')from private.catalog_name_aliases a where a.team_id=new.team_id and a.material_id=new.id),'')),'B');
 return new;
end $$;
alter function private.launch_revision_json(uuid,uuid)rename to launch_revision_json_before_canonical_rename;
create function private.launch_revision_json(p_team uuid,p_revision uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select case when jsonb_typeof(value->'catalog')='object'then value||jsonb_build_object('catalog',value->'catalog'||jsonb_build_object('currentName',coalesce(m.name,value#>>'{catalog,name}'),'boundNames',private.catalog_bound_names(p_team,m.id)))else value end
 from(select private.launch_revision_json_before_canonical_rename(p_team,p_revision)value)v
 left join public.team_materials m on m.team_id=p_team and m.id::text=value#>>'{catalog,materialId}'
$$;
alter function public.list_team_product_catalogs(uuid)rename to list_team_product_catalogs_before_canonical_rename;
alter function public.list_team_product_catalogs_before_canonical_rename(uuid)set schema private;
create function public.list_team_product_catalogs(p_team uuid)returns table(
 catalog_id uuid,name text,sheet_url text,video_id uuid,video_name text,folder_name text,product_count smallint,created_at timestamptz,last_updated_at timestamptz,update_count integer,in_updater boolean,last_update_error text,update_interval text,next_run_at timestamptz,update_pending boolean,folder_drive_id text,update_stage text,restitch_progress smallint,restitch_stage text,name_aliases text[]
)language sql stable security definer set search_path=''as $$
 select c.*,array(select a.name from private.catalog_name_aliases a where a.team_id=p_team and a.material_id=c.catalog_id order by a.name)from private.list_team_product_catalogs_before_canonical_rename(p_team)c
$$;
revoke all on function public.list_team_product_catalogs(uuid)from public,anon;
grant execute on function public.list_team_product_catalogs(uuid)to authenticated;
revoke all on function private.list_team_product_catalogs_before_canonical_rename(uuid),private.launch_revision_json_before_canonical_rename(uuid,uuid),private.launch_revision_json(uuid,uuid),private.catalog_decode_url(text),private.catalog_name_is_bound(text,text),private.catalog_bound_names(uuid,uuid),private.catalog_rename_context(uuid,uuid),private.assert_catalog_rename_quiescent(uuid,uuid),private.catalog_rename_receipt(uuid)from public,anon,authenticated,service_role;
revoke all on function public.service_catalog_rename_context(uuid,uuid,uuid),public.service_catalog_rename_status(uuid,uuid,uuid,uuid),public.service_accept_catalog_rename(uuid,uuid,uuid,uuid,jsonb),public.service_claim_catalog_rename(uuid,uuid,uuid,uuid,uuid),public.service_prepare_catalog_rename(uuid,uuid,text,text,text),public.service_settle_catalog_rename(uuid,uuid,jsonb,text,boolean,bigint),public.service_due_catalog_renames(integer)from public,anon,authenticated;
grant execute on function public.service_catalog_rename_context(uuid,uuid,uuid),public.service_catalog_rename_status(uuid,uuid,uuid,uuid),public.service_accept_catalog_rename(uuid,uuid,uuid,uuid,jsonb),public.service_claim_catalog_rename(uuid,uuid,uuid,uuid,uuid),public.service_prepare_catalog_rename(uuid,uuid,text,text,text),public.service_settle_catalog_rename(uuid,uuid,jsonb,text,boolean,bigint),public.service_due_catalog_renames(integer)to service_role;

create view public.analytics_catalog_renames with(security_barrier=true)as
 select request_key,team_id,actor_id,material_id,operation_id,state,error_code,created_at,updated_at,confirmed_at,
 dispatched_at is not null dispatched,attempt_count,next_attempt_at,'provider_intent'::text origin
 from private.catalog_rename_requests
 union all select request_key,team_id,actor_id,material_id,null::uuid,'failed'::text,'NOT_FOUND'::text,created_at,created_at,null::timestamptz,false,0,null::timestamptz,'absent_command'::text
 from private.catalog_rename_absent_commands;
revoke all on public.analytics_catalog_renames from public,anon,authenticated,service_role;
do $$begin if exists(select 1 from pg_roles where rolname='wishly_analytics_ro')then grant select on public.analytics_catalog_renames to wishly_analytics_ro;end if;end $$;
-- A rename receipt or alias must not attach after cleanup has claimed a file.
create trigger task_cleanup_reference_fence before insert or update on private.catalog_rename_requests for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_rename_absent_commands for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.catalog_name_aliases for each row execute function private.guard_task_cleanup_reference();
commit;
