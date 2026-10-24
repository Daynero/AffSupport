begin;

-- A generated ID is bound before any provider create request. Session URLs are
-- bearer credentials and must never be persisted here or in diagnostic views.
create table private.process_upload_ownership (
 operation_id uuid primary key references public.team_operations(id) on delete cascade,
 team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null,
 connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
 credential_id uuid not null references private.google_drive_credentials(id) on delete restrict,
 root_id text not null check(char_length(root_id) between 1 and 200),
 parent_id text not null check(char_length(parent_id) between 1 and 200),
 file_id text not null unique check(file_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 source_file_id text not null,
 nonce uuid not null default gen_random_uuid(),
 expected_name text not null check(char_length(expected_name) between 1 and 1024),
 mime_type text not null check(char_length(mime_type) between 1 and 255),
 size_bytes bigint not null check(size_bytes>0),
 checksum text not null check(checksum ~ '^[a-f0-9]{32}$'),
 handoff_expires_at timestamptz not null,
 upload_state text not null default 'prepared' check(upload_state in('prepared','started','published')),
 cleanup_state text not null default 'not_needed' check(cleanup_state in('not_needed','pending','claimed','waiting','trashed','not_created','attention')),
 attempts integer not null default 0 check(attempts between 0 and 24),
 lease_owner uuid,
 fence bigint not null default 0 check(fence>=0),
 lease_expires_at timestamptz,
 next_attempt_at timestamptz,
 last_code text check(last_code in('PROCESS_RESULT_UNCERTAIN','SOURCE_CHANGED','NEEDS_REAUTH','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE')),
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 check(file_id<>source_file_id),
 check(handoff_expires_at>created_at)
);
revoke all on private.process_upload_ownership from public,anon,authenticated,service_role;
alter table private.process_upload_ownership enable row level security;
alter table private.process_upload_ownership force row level security;
create index process_upload_cleanup_due on private.process_upload_ownership(next_attempt_at,operation_id)
 where cleanup_state in('pending','waiting','claimed');

create function private.process_upload_binding(p private.process_upload_ownership)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('operationId',p.operation_id,'teamId',p.team_id,'fileId',p.file_id,
  'nonce',p.nonce,'state',p.upload_state,'connectionId',p.connection_id,'credentialId',p.credential_id,
  'rootId',p.root_id,'parentId',p.parent_id,'name',p.expected_name,'mimeType',p.mime_type,
  'sizeBytes',p.size_bytes,'checksum',p.checksum)
$$;
revoke all on function private.process_upload_binding(private.process_upload_ownership) from public,anon,authenticated,service_role;

create function public.service_prepare_process_upload(
 p_operation uuid,p_actor uuid,p_connection uuid,p_file text,p_checksum text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;i private.team_operation_intents%rowtype;
 c public.team_drive_connections%rowtype;s public.team_materials%rowtype;
 u private.process_upload_ownership%rowtype;parent text;handoff_expiry timestamptz;
begin
 if p_file is null or p_file !~ '^[A-Za-z0-9_-]{1,200}$'
  or p_checksum is null or p_checksum !~ '^[a-f0-9]{32}$' then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 if o.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 select * into i from private.team_operation_intents where operation_id=o.id and team_id=o.team_id;
 if o.kind<>'process' or o.state<>'running' or o.result_material_id is not null
  or i.operation_id is null or i.version_of_material_id is not null or i.replace_material_id is not null
  or i.expected_size is null or i.expected_size<=0 or i.expected_name is null or i.mime_type is null
  or i.provider_result_id is not null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(o.team_id,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select max(g.expires_at) into handoff_expiry from private.team_transfer_grants g
  where g.operation_id=o.id and g.team_id=o.team_id and g.actor_id=p_actor and g.purpose='finalize'
   and g.tool_id=i.tool_id and g.revoked_at is null and g.expires_at>clock_timestamp()+interval '5 seconds';
 if handoff_expiry is null then raise exception 'EXPIRED' using errcode='55000';end if;
 select * into c from public.team_drive_connections where id=p_connection and team_id=o.team_id and state='connected';
 select * into s from public.team_materials where id=o.source_material_id and team_id=o.team_id;
 if c.id is null or s.id is null or s.connection_id<>c.id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if o.destination_folder_id is null then parent:=c.root_folder_id;
 else select drive_file_id into parent from public.team_materials where id=o.destination_folder_id
  and team_id=o.team_id and connection_id=c.id and kind='folder' and lifecycle='active';end if;
 if parent is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if found then
  if u.actor_id<>p_actor or u.connection_id<>c.id or u.credential_id<>c.credential_id
   or u.root_id<>c.root_folder_id or u.parent_id<>parent or u.checksum<>p_checksum
   or u.expected_name<>i.expected_name or u.mime_type<>i.mime_type or u.size_bytes<>i.expected_size
   or u.source_file_id<>s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  if handoff_expiry>u.handoff_expires_at then
   update private.process_upload_ownership set handoff_expires_at=handoff_expiry,updated_at=clock_timestamp()
    where operation_id=o.id returning * into u;
  end if;
  return private.process_upload_binding(u);
 end if;
 if exists(select 1 from public.team_materials where drive_file_id=p_file)
  or p_file=s.drive_file_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.process_upload_ownership(operation_id,team_id,actor_id,connection_id,credential_id,
  root_id,parent_id,file_id,source_file_id,expected_name,mime_type,size_bytes,checksum,handoff_expires_at)
 values(o.id,o.team_id,p_actor,c.id,c.credential_id,c.root_folder_id,parent,p_file,s.drive_file_id,
  i.expected_name,i.mime_type,i.expected_size,p_checksum,handoff_expiry) returning * into u;
 return private.process_upload_binding(u);
exception when unique_violation then raise exception 'SOURCE_CHANGED' using errcode='55000';
end $$;

create function public.service_start_process_upload(p_operation uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;
begin
 select * into o from public.team_operations where id=p_operation and actor_id=p_actor for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if o.id is null or o.kind<>'process' or o.state<>'running' or u.operation_id is null
  or u.upload_state<>'prepared' or u.cleanup_state<>'not_needed' then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(o.team_id,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if u.handoff_expires_at<=clock_timestamp() or not exists(
  select 1 from private.team_transfer_grants g where g.operation_id=o.id and g.actor_id=p_actor
   and g.team_id=o.team_id and g.purpose='finalize' and g.revoked_at is null and g.expires_at>clock_timestamp())
 then raise exception 'EXPIRED' using errcode='55000';end if;
 if not exists(select 1 from public.team_drive_connections c where c.id=u.connection_id and c.team_id=u.team_id
  and c.state='connected' and c.credential_id=u.credential_id and c.root_folder_id=u.root_id)
 then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update private.process_upload_ownership set upload_state='started',updated_at=clock_timestamp() where operation_id=o.id;
 return true;
end $$;

-- The operation row is the common lock: cancel, finalization, claims and
-- settlement all take it before touching ownership. No cleanup publishes data.
create function private.fence_process_upload_outcome() returns trigger
language plpgsql security definer set search_path='' as $$
declare u private.process_upload_ownership%rowtype;m public.team_materials%rowtype;
begin
 select * into u from private.process_upload_ownership where operation_id=new.id for update;
 if not found then return new;end if;
 if new.state='succeeded' and old.state is distinct from new.state then
  if old.state not in('pending','running') or u.upload_state<>'started' or new.result_material_id is null then
   raise exception 'WRONG_STATE' using errcode='55000';end if;
  select * into m from public.team_materials where id=new.result_material_id and team_id=u.team_id;
  if m.id is null or m.drive_file_id is distinct from u.file_id or m.connection_id is distinct from u.connection_id
   or m.parent_folder_id is distinct from u.parent_id or m.name is distinct from u.expected_name
   or m.mime_type is distinct from u.mime_type or m.size_bytes is distinct from u.size_bytes
   or m.checksum is distinct from u.checksum or m.lifecycle<>'active'
   then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  update private.process_upload_ownership set upload_state='published',cleanup_state='not_needed',
   lease_owner=null,lease_expires_at=null,next_attempt_at=null,last_code=null,updated_at=clock_timestamp()
   where operation_id=new.id;
 elsif new.state in('failed','canceled') and old.state is distinct from new.state and u.upload_state<>'published' then
  update private.process_upload_ownership set
   cleanup_state=case when upload_state='prepared' then 'not_created' else 'pending' end,
   next_attempt_at=case when upload_state='prepared' then null else clock_timestamp() end,
   last_code=case when upload_state='prepared' then null else 'PROCESS_RESULT_UNCERTAIN' end,
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where operation_id=new.id;
 end if;
 return new;
end $$;
revoke all on function private.fence_process_upload_outcome() from public,anon,authenticated,service_role;
create trigger process_upload_outcome_fence before update of state,result_material_id on public.team_operations
 for each row execute function private.fence_process_upload_outcome();

create function public.service_claim_process_output_cleanup(p_owner uuid,p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;u private.process_upload_ownership%rowtype;plans jsonb:='[]';
begin
 if p_owner is null or p_limit is null or p_limit not between 1 and 3 then
  raise exception 'INVALID_INPUT' using errcode='22023';end if;
 -- No browser heartbeat is required. Only an expired handoff with no current
 -- business grant permits settling an abandoned operation; absence is not proof.
 for candidate in select o.id from private.process_upload_ownership q join public.team_operations o on o.id=q.operation_id
  where o.kind='process' and o.state in('pending','running') and o.result_material_id is null
   and q.upload_state<>'published' and q.handoff_expires_at<=clock_timestamp()
   and not exists(select 1 from private.team_transfer_grants g where g.operation_id=o.id and g.actor_id=o.actor_id
    and g.team_id=o.team_id and g.purpose='finalize' and g.revoked_at is null and g.expires_at>clock_timestamp())
  order by q.handoff_expires_at,q.operation_id limit p_limit for update of o skip locked
 loop
  update public.team_operations set state='failed',stage='failed',error_code='PROCESS_RESULT_UNCERTAIN',
   retryable=false,finished_at=clock_timestamp(),updated_at=clock_timestamp(),
   reservation_released_at=coalesce(reservation_released_at,clock_timestamp()) where id=candidate.id;
  update private.team_transfer_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where operation_id=candidate.id;
 end loop;
 for candidate in select o.id from private.process_upload_ownership q join public.team_operations o on o.id=q.operation_id
  where o.kind='process' and o.state in('failed','canceled') and o.result_material_id is null
   and q.upload_state='started' and q.cleanup_state in('pending','waiting','claimed')
   and (q.next_attempt_at is null or q.next_attempt_at<=clock_timestamp())
   and (q.lease_expires_at is null or q.lease_expires_at<=clock_timestamp())
  order by q.created_at,q.operation_id limit p_limit for update of o skip locked
 loop
  select * into u from private.process_upload_ownership where operation_id=candidate.id for update skip locked;
  if not found then continue;end if;
  if u.attempts>=24 then
   update private.process_upload_ownership set cleanup_state='attention',last_code='PROCESS_RESULT_UNCERTAIN',
    lease_owner=null,lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where operation_id=u.operation_id;
   continue;
  end if;
  update private.process_upload_ownership set cleanup_state='claimed',attempts=attempts+1,fence=fence+1,
   lease_owner=p_owner,lease_expires_at=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
   where operation_id=u.operation_id returning * into u;
  plans:=plans || jsonb_build_array(private.process_upload_binding(u) || jsonb_build_object('fence',u.fence::text));
 end loop;
 return plans;
end $$;

create function public.service_authorize_process_output_cleanup(p_operation uuid,p_owner uuid,p_fence text)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;
begin
 select * into o from public.team_operations where id=p_operation for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 return coalesce(o.id is not null and o.kind='process' and o.state in('failed','canceled') and o.result_material_id is null
  and u.operation_id is not null and u.team_id=o.team_id and u.actor_id=o.actor_id and u.upload_state='started'
  and u.cleanup_state='claimed' and u.lease_owner=p_owner and u.fence::text=p_fence and u.lease_expires_at>clock_timestamp()
  and u.file_id<>u.source_file_id
  and exists(select 1 from public.team_drive_connections c where c.id=u.connection_id and c.team_id=u.team_id
   and c.state='connected' and c.credential_id=u.credential_id and c.root_folder_id=u.root_id)
  and not exists(select 1 from public.team_materials m where m.drive_file_id=u.file_id)
  and not exists(select 1 from private.team_operation_intents i where i.operation_id=o.id and i.provider_result_id is not null),false);
end $$;

create function public.service_settle_process_output_cleanup(
 p_operation uuid,p_owner uuid,p_fence text,p_result text,p_code text default null
) returns text language plpgsql security definer set search_path='' as $$
declare o public.team_operations%rowtype;u private.process_upload_ownership%rowtype;outcome text;
begin
 if p_result is null or p_result not in('trashed','pending','retained') or
  (p_code is not null and p_code not in('PROCESS_RESULT_UNCERTAIN','SOURCE_CHANGED','NEEDS_REAUTH','PERMISSION_DENIED','DRIVE_UNAVAILABLE','RATE_LIMITED','INVALID_RESPONSE'))
  then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into o from public.team_operations where id=p_operation for update;
 select * into u from private.process_upload_ownership where operation_id=o.id for update;
 if u.operation_id is null or u.cleanup_state<>'claimed' or u.lease_owner is distinct from p_owner
  or u.fence::text is distinct from p_fence or u.lease_expires_at<=clock_timestamp()
  or o.state not in('failed','canceled') or o.result_material_id is not null then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if p_result='trashed' and not public.service_authorize_process_output_cleanup(p_operation,p_owner,p_fence)
 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 outcome:=case when p_result='trashed' then 'trashed' when p_result='retained' or u.attempts>=24 then 'attention' else 'waiting' end;
 update private.process_upload_ownership set cleanup_state=outcome,
  last_code=case when outcome='trashed' then null else coalesce(p_code,'PROCESS_RESULT_UNCERTAIN') end,
  next_attempt_at=case when outcome='waiting' then clock_timestamp()+make_interval(secs=>least(600,5*power(2,least(u.attempts-1,10))::integer)) else null end,
  lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where operation_id=o.id;
 return outcome;
end $$;

revoke all on function public.service_prepare_process_upload(uuid,uuid,uuid,text,text),
 public.service_start_process_upload(uuid,uuid),public.service_claim_process_output_cleanup(uuid,integer),
 public.service_authorize_process_output_cleanup(uuid,uuid,text),public.service_settle_process_output_cleanup(uuid,uuid,text,text,text)
 from public,anon,authenticated;
grant execute on function public.service_prepare_process_upload(uuid,uuid,uuid,text,text),
 public.service_start_process_upload(uuid,uuid),public.service_claim_process_output_cleanup(uuid,integer),
 public.service_authorize_process_output_cleanup(uuid,uuid,text),public.service_settle_process_output_cleanup(uuid,uuid,text,text,text)
 to service_role;

-- The existing catalog snapshot function is restated below with one additional
-- exclusion. Finalization remains its own atomic, permission-checked path.

create or replace function private.upsert_catalog_snapshot(
  p_connection uuid,
  p_parent_folder_id text,
  p_files jsonb,
  p_snapshot pg_snapshot
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_team uuid;
  affected integer;
begin
  if pg_catalog.jsonb_typeof(p_files) <> 'array' or pg_catalog.jsonb_array_length(p_files) > 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select connection.team_id into resolved_team
  from public.team_drive_connections as connection
  where connection.id = p_connection and connection.state <> 'detached';
  if resolved_team is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into p_files
  from jsonb_array_elements(p_files) item where item ->> 'name' <> '.soty'
    and not exists(select 1 from private.process_upload_ownership own
      where own.file_id=item->>'drive_file_id' and own.upload_state<>'published'
        -- A separate explicit publication may have adopted the file. Existing
        -- materials fence cleanup and must retain ordinary catalog readback.
        and not exists(select 1 from public.team_materials registered where registered.drive_file_id=own.file_id));

  insert into public.team_materials (
    team_id, connection_id, drive_file_id, drive_id, resource_key,
    parent_folder_id, name, mime_type, file_extension, kind,
    shortcut_target_id, shortcut_target_resource_key, category,
    classification_version, classification_source, size_bytes, modified_at,
    drive_version, checksum, lifecycle, transcript_ingest_state
  )
  select resolved_team, p_connection, item.drive_file_id, item.drive_id, item.resource_key,
         coalesce(item.parent_folder_id, p_parent_folder_id), item.name, item.mime_type,
         item.file_extension, item.kind, item.shortcut_target_id,
         item.shortcut_target_resource_key, item.category,
         coalesce(item.classification_version, 1),
         coalesce(item.classification_source, 'fallback'), item.size_bytes,
         nullif(item.modified_at, '')::timestamptz, item.drive_version, item.checksum,
         'active', case when item.category = 'transcript' then 'pending' else 'not_applicable' end
  from pg_catalog.jsonb_to_recordset(p_files) as item(
    drive_file_id text, drive_id text, resource_key text, parent_folder_id text,
    name text, mime_type text, file_extension text, kind text,
    shortcut_target_id text, shortcut_target_resource_key text, category text,
    classification_version integer, classification_source text, size_bytes bigint,
    modified_at text, drive_version text, checksum text
  )
  where char_length(item.drive_file_id) between 1 and 1024
    and char_length(item.name) between 1 and 1024
    and item.kind in ('file', 'folder', 'shortcut')
  on conflict (team_id, drive_file_id) do update
  set connection_id = excluded.connection_id,
      drive_id = excluded.drive_id,
      resource_key = excluded.resource_key,
      parent_folder_id = excluded.parent_folder_id,
      name = excluded.name,
      mime_type = excluded.mime_type,
      file_extension = excluded.file_extension,
      kind = excluded.kind,
      shortcut_target_id = excluded.shortcut_target_id,
      shortcut_target_resource_key = excluded.shortcut_target_resource_key,
      category = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'landing'
        else excluded.category end,
      classification_version = excluded.classification_version,
      classification_source = case
        when public.team_materials.landing_validation_state = 'validated'
          and public.team_materials.landing_validation_version is not distinct from excluded.drive_version
          and excluded.category = 'archive' then 'inspected_landing'
        else excluded.classification_source end,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      landing_validation_state = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_state end,
      landing_validation_version = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_version end,
      landing_validation_fingerprint = case
        when public.team_materials.drive_version is distinct from excluded.drive_version then null
        else public.team_materials.landing_validation_fingerprint end,
      transcript_text = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then null
        else public.team_materials.transcript_text end,
      transcript_ingest_state = case
        when excluded.category <> 'transcript' then 'not_applicable'
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then 'pending'
        else public.team_materials.transcript_ingest_state end,
      transcript_truncated = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then false
        else public.team_materials.transcript_truncated end,
      transcript_indexed_bytes = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension
          or excluded.category <> 'transcript' then 0
        else public.team_materials.transcript_indexed_bytes end,
      transcript_error_code = case
        when public.team_materials.drive_version is distinct from excluded.drive_version
          or public.team_materials.checksum is distinct from excluded.checksum
          or public.team_materials.mime_type is distinct from excluded.mime_type
          or public.team_materials.file_extension is distinct from excluded.file_extension then null
        else public.team_materials.transcript_error_code end,
      drive_version = excluded.drive_version,
      checksum = excluded.checksum,
      lifecycle = 'active',
      trashed_at = null,
      missing_at = null,
      missing_reason = null,
      updated_at = clock_timestamp()
  where pg_visible_in_snapshot(public.team_materials.catalog_mutation_xid::text::xid8, p_snapshot)
    and (public.team_materials.connection_id, public.team_materials.parent_folder_id,
      public.team_materials.name, public.team_materials.mime_type, public.team_materials.kind,
      public.team_materials.drive_version, public.team_materials.checksum, public.team_materials.lifecycle,
      public.team_materials.drive_id, public.team_materials.resource_key, public.team_materials.file_extension,
      public.team_materials.shortcut_target_id, public.team_materials.shortcut_target_resource_key,
      public.team_materials.size_bytes, public.team_materials.modified_at)
      is distinct from (excluded.connection_id, excluded.parent_folder_id, excluded.name, excluded.mime_type,
        excluded.kind, excluded.drive_version, excluded.checksum, 'active'::text, excluded.drive_id,
        excluded.resource_key, excluded.file_extension, excluded.shortcut_target_id,
        excluded.shortcut_target_resource_key, excluded.size_bytes, excluded.modified_at);
  get diagnostics affected = row_count;
  if affected > 0 then
    insert into public.team_catalog_events (team_id, material_id, event_kind)
    values (resolved_team, null, 'upserted');
  end if;
  return affected;
end;
$$;

-- Safe status only: no provider IDs, names, content checksums or credentials.
create or replace view public.analytics_workspace_operations as
 select c.request_id as id,c.team_id,c.actor_id,'task_copy'::text as action,'confirmed'::text as state,
 null::text as code,cardinality(c.result_ids)::integer as item_count,cardinality(c.result_ids)::integer as confirmed_count,
 c.created_at as created_at,c.created_at as updated_at
 from private.team_task_copy_receipts c
 union all
 select c.id,c.team_id,c.actor_id,'task_cleanup',c.state,coalesce(o.error_code,c.reason),1,case when c.state='trashed' then 1 else 0 end,c.detached_at,c.updated_at from private.task_attachment_cleanup c left join public.team_operations o on o.id=c.operation_id
 union all
 select g.id,g.team_id,g.actor_id,'bulk_trash',
 case when count(*) filter(where o.state='succeeded')=count(*) then 'confirmed'
 when count(*) filter(where o.state in ('failed','canceled'))>0 then 'partial'
 when count(*) filter(where o.state in ('pending','running'))>0 then 'running' else 'unknown' end,
 min(o.error_code) filter(where o.state='failed'),
 count(*)::integer,count(*) filter(where o.state='succeeded')::integer,g.created_at,
 greatest(g.created_at,max(o.updated_at),max(i.requested_at))
 from private.team_bulk_trash_groups g join private.team_bulk_trash_items i on i.group_id=g.id
 left join public.team_operations o on o.team_id=g.team_id and o.actor_id=g.actor_id and o.kind='trash' and o.idempotency_key=i.idempotency_key
 group by g.id,g.team_id,g.actor_id,g.created_at
 union all
 select u.operation_id,u.team_id,u.actor_id,'process_output_cleanup',
 case when u.upload_state='published' then 'confirmed'
      when u.cleanup_state='not_created' then 'cancelled'
      when u.cleanup_state='not_needed' then u.upload_state else u.cleanup_state end,
 u.last_code,1,case when u.upload_state='published' or u.cleanup_state in('trashed','not_created') then 1 else 0 end,
 u.created_at,u.updated_at from private.process_upload_ownership u;
revoke all on public.analytics_workspace_operations from public,anon,authenticated;
grant select on public.analytics_workspace_operations to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_workspace_operations to wishly_analytics_ro; end if;end $$;

-- Presence identifies the privacy-limited ownership projection schema, not a
-- claim that any producer, provider upload or cleanup has succeeded.
create view public.analytics_process_output_cleanup as
 select operation_id as id,actor_id,upload_state,cleanup_state,attempts,24::integer as max_attempts,
 handoff_expires_at as captured_handoff_expires_at,next_attempt_at,lease_expires_at,created_at,updated_at
 from private.process_upload_ownership;
revoke all on public.analytics_process_output_cleanup from public,anon,authenticated;
grant select on public.analytics_process_output_cleanup to service_role;
do $$ begin if exists(select 1 from pg_catalog.pg_roles where rolname='wishly_analytics_ro') then grant select on public.analytics_process_output_cleanup to wishly_analytics_ro; end if;end $$;

commit;
