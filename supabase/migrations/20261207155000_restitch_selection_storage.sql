-- Storage foundation only. No native recovery capability or initializer is exposed here.
begin;
create table private.restitch_selection_roots (
 root_operation_id uuid primary key references public.team_operations(id) on delete restrict,
 team_id uuid not null references public.teams(id) on delete cascade,
 actor_id uuid not null references auth.users(id) on delete cascade,
 source_material_id uuid not null,
 source_version text not null,
 recipe_owner_id uuid not null references auth.users(id),
 pool_namespace_id uuid not null,
 recipe jsonb not null,
 created_at timestamptz not null default clock_timestamp(),
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 unique(root_operation_id,team_id,actor_id),
 check(jsonb_typeof(recipe)='object' and octet_length(recipe::text)<=65536)
);
create table private.restitch_selection_slots (
 root_operation_id uuid not null references private.restitch_selection_roots(root_operation_id) on delete cascade,
 slot text not null check(slot in('start','end')),
 snapshot_complete boolean,
 updated_at timestamptz not null default clock_timestamp(),
 budget jsonb not null,
 primary key(root_operation_id,slot),
 check(jsonb_typeof(budget)='object' and octet_length(budget::text)<=524288)
);
create table private.restitch_selection_candidates (
 root_operation_id uuid not null,
 slot text not null,
 version_id uuid not null,
 material_id uuid not null references public.team_materials(id) on delete restrict,
 ordinal integer not null check(ordinal between 1 and 500),
 size_bytes bigint not null check(size_bytes between 1 and 52428800),
 mime_type text not null check(mime_type in('image/jpeg','image/png','image/webp')),
 checksum text not null check(checksum~'^[0-9a-f]{32}$'),
 drive_version text not null,
 primary key(root_operation_id,slot,version_id),
 unique(root_operation_id,slot,ordinal),
 foreign key(root_operation_id,slot) references private.restitch_selection_slots(root_operation_id,slot) on delete cascade
);
alter table private.restitch_selection_roots enable row level security;
alter table private.restitch_selection_roots force row level security;
alter table private.restitch_selection_slots enable row level security;
alter table private.restitch_selection_slots force row level security;
alter table private.restitch_selection_candidates enable row level security;
alter table private.restitch_selection_candidates force row level security;
revoke all on private.restitch_selection_roots,private.restitch_selection_slots,private.restitch_selection_candidates from public,anon,authenticated,service_role;

-- These rows participate in the existing conservative JSON/FK reference inventory.
create trigger task_cleanup_reference_fence before insert or update on private.restitch_selection_roots
 for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.restitch_selection_slots
 for each row execute function private.guard_task_cleanup_reference();
create trigger task_cleanup_reference_fence before insert or update on private.restitch_selection_candidates
 for each row execute function private.guard_task_cleanup_reference();

create function private.restitch_selection_root_binding() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;m public.team_materials%rowtype;
begin
 if tg_op='UPDATE' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into o from public.team_operations where id=new.root_operation_id for update;
 if o.id is null or o.team_id is distinct from new.team_id or o.actor_id is distinct from new.actor_id
  or o.source_material_id is distinct from new.source_material_id or o.kind not in('download','process')
  or o.state not in('pending','running') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if not private.can(new.team_id,'download',new.actor_id) or
  (o.kind='process' and not private.can(new.team_id,'process',new.actor_id)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=new.source_material_id and team_id=new.team_id for share;
 if m.id is null or m.lifecycle<>'active' or m.category is distinct from 'video' or m.drive_version is distinct from new.source_version then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if new.recipe_owner_id<>new.actor_id and not exists(select 1 from public.teams where id=new.team_id and owner_id=new.recipe_owner_id) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 -- This foundation admits manual roots only. Automated preparation/root aliases
 -- must be added with their own immutable acceptance proof, never guessed here.
 if exists(select 1 from private.catalog_restitch_operations where operation_id=new.root_operation_id)
  or exists(select 1 from private.launch_restitch_preparations where operation_id=new.root_operation_id) then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if o.kind='process' and not exists(select 1 from private.team_operation_intents where operation_id=o.id and team_id=new.team_id and tool_id='restitch') then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $fn$;
create trigger restitch_selection_binding before insert or update on private.restitch_selection_roots
 for each row execute function private.restitch_selection_root_binding();

create function private.restitch_selection_initialize_slots() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_slot text;
begin
 foreach v_slot in array array['start','end'] loop
  insert into private.restitch_selection_slots(root_operation_id,slot,budget)
  values(new.root_operation_id,v_slot,
   '{"schemaVersion":1,"revision":0,"candidates":[],"transfers":[],"refreshes":[],"acceptedVersionId":null}'::jsonb);
 end loop;
 return new;
end $fn$;
create trigger restitch_selection_initialize after insert on private.restitch_selection_roots
 for each row execute function private.restitch_selection_initialize_slots();

create function private.restitch_selection_freeze_candidate() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;m public.team_materials%rowtype;
begin
 if tg_op='UPDATE' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into r from private.restitch_selection_roots where root_operation_id=new.root_operation_id for share;
 select * into s from private.restitch_selection_slots where root_operation_id=new.root_operation_id and slot=new.slot for update;
 if (s.budget->>'revision')::bigint<>0 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=new.material_id and team_id=r.team_id for share;
 if m.id is null or m.lifecycle<>'active' or m.kind<>'file' or m.category is distinct from 'image'
  or m.checksum is distinct from new.checksum or m.size_bytes is distinct from new.size_bytes
  or m.mime_type is distinct from new.mime_type or m.drive_version is distinct from new.drive_version then
  raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 return new;
end $fn$;
create trigger restitch_selection_candidate_binding before insert or update on private.restitch_selection_candidates
 for each row execute function private.restitch_selection_freeze_candidate();

-- Exact canonical transitions preserve immutable history by induction from the empty budget.
-- The public CAS below never admits measurement; bookkeeping has its own service RPC.
create function private.restitch_selection_step_kind(p_old jsonb,p_new jsonb) returns text
language plpgsql immutable set search_path='' as $fn$
declare b jsonb;c jsonb;t jsonb;x jsonb;last_c jsonb;n integer;v text;req text;
 candidate_retries integer;total_retries integer;used_bytes bigint;used_io bigint;
 next_offset bigint;last_offset bigint;expected jsonb;allowed integer;wanted integer;
begin
 if jsonb_typeof(p_old)<>'object' or jsonb_typeof(p_new)<>'object'
  or octet_length(p_new::text)>524288 or p_old->>'schemaVersion'<>'1' or p_new->>'schemaVersion'<>'1'
  or not (p_old->>'revision'~'^[0-9]{1,5}$') or
  (p_new->>'revision')::bigint<>(p_old->>'revision')::bigint+1 then return null;end if;
 b:=jsonb_set(p_old,'{revision}',p_new->'revision');
 n:=jsonb_array_length(p_old->'candidates');last_c:=p_old->'candidates'->(n-1);
 -- At most one dispatch may be unsettled; it blocks every action except bookkeeping.
 if exists(select 1 from jsonb_array_elements(p_old->'transfers')a where a->'settlement'='null'::jsonb) then return null;end if;
 if n<32 and jsonb_array_length(p_new->'candidates')=n+1 and p_old->'acceptedVersionId'='null'::jsonb
  and not exists(select 1 from jsonb_array_elements(p_old->'candidates')a where a->>'rejected'='false') then
  c:=p_new->'candidates'->n;
  if (c->>'versionId')~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and (c->>'sizeBytes')~'^[0-9]{1,8}$' and (c->>'sizeBytes')::bigint between 1 and 52428800
   and not exists(select 1 from jsonb_array_elements(p_old->'candidates')a where a->>'versionId'=c->>'versionId')
   and c=jsonb_build_object('versionId',c->>'versionId','sizeBytes',(c->>'sizeBytes')::bigint,
      'acquisition',0,'validatedAcquisition',null,'rejected',false)
   and p_new=jsonb_set(b,'{candidates}',(p_old->'candidates')||jsonb_build_array(c)) then return 'select';end if;
 end if;
 if n=0 then return null;end if;
 v:=last_c->>'versionId';
 if last_c->>'rejected'='true' then return null;end if;
 -- A rejection may retire a previously accepted but later lost/invalid cached version.
 c:=jsonb_set(jsonb_set(last_c,'{rejected}','true'::jsonb),'{validatedAcquisition}','null'::jsonb);
 expected:=jsonb_set(b,array['candidates',(n-1)::text],c);
 if p_old->>'acceptedVersionId'=v then expected:=jsonb_set(expected,'{acceptedVersionId}','null'::jsonb);end if;
 if expected=p_new then return 'reject';end if;
 if p_old->'acceptedVersionId'='null'::jsonb or p_old->>'acceptedVersionId'=v then
  expected:=jsonb_set(jsonb_set(b,array['candidates',(n-1)::text,'validatedAcquisition'],last_c->'acquisition'),'{acceptedVersionId}',to_jsonb(v));
  if p_new=expected and (p_old->'acceptedVersionId'='null'::jsonb or last_c->'validatedAcquisition' is distinct from last_c->'acquisition') then return 'accept';end if;
 end if;
 select coalesce(sum((a->>'acquisition')::integer),0) into total_retries from jsonb_array_elements(p_old->'candidates')a;
 select total_retries+count(*)::integer into total_retries from jsonb_array_elements(p_old->'transfers')a where a->>'retry'='true';
 select (last_c->>'acquisition')::integer+count(*)::integer into candidate_retries from jsonb_array_elements(p_old->'transfers')a where a->>'retry'='true' and a->>'candidateVersionId'=v;
 if (p_old->'acceptedVersionId'='null'::jsonb or p_old->>'acceptedVersionId'=v)
  and ((p_old->>'acceptedVersionId'=v and last_c->'validatedAcquisition'=last_c->'acquisition')
   or exists(select 1 from jsonb_array_elements(p_old->'transfers')a
    where a->>'candidateVersionId'=v and a->'acquisition'=last_c->'acquisition'
     and a->'settlement'<>'null'::jsonb))
  and candidate_retries<2 and total_retries<6 then
  expected:=jsonb_set(b,array['candidates',(n-1)::text,'acquisition'],to_jsonb((last_c->>'acquisition')::integer+1));
  if expected=p_new then return 'reacquire';end if;
 end if;
 if jsonb_array_length(p_old->'refreshes')<2 and jsonb_array_length(p_new->'refreshes')=jsonb_array_length(p_old->'refreshes')+1
  and not exists(select 1 from jsonb_array_elements(p_old->'refreshes')a where a->>'candidateVersionId'=v) then
  x:=p_new->'refreshes'->(jsonb_array_length(p_old->'refreshes'));req:=x->>'requestId';
  if req~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   and not exists(select 1 from jsonb_array_elements((p_old->'transfers')||(p_old->'refreshes'))a where a->>'requestId'=req)
   and x=jsonb_build_object('requestId',req,'candidateVersionId',v)
   and p_new=jsonb_set(b,'{refreshes}',(p_old->'refreshes')||jsonb_build_array(x)) then return 'refresh';end if;
 end if;
 allowed:=jsonb_array_length(p_old->'transfers');
 if allowed>=956 or jsonb_array_length(p_new->'transfers')<>allowed+1
  or last_c->'validatedAcquisition'=last_c->'acquisition'
  or (p_old->'acceptedVersionId'<>'null'::jsonb and p_old->>'acceptedVersionId'<>v) then return null;end if;
 t:=p_new->'transfers'->allowed;req:=t->>'requestId';
 if req is null or req!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  or exists(select 1 from jsonb_array_elements((p_old->'transfers')||(p_old->'refreshes'))a where a->>'requestId'=req) then return null;end if;
 select coalesce(sum(coalesce((a->'settlement'->>'bytes')::bigint,(a->>'bytesReserved')::bigint)),0),
  coalesce(sum(coalesce((a->'settlement'->>'ioMs')::bigint,(a->>'ioMsReserved')::bigint)),0)
 into used_bytes,used_io from jsonb_array_elements(p_old->'transfers')a;
 select coalesce(max((a->>'offset')::bigint+(a->'settlement'->>'bytes')::bigint)filter(where a->'settlement'->>'complete'='true'),0)
 into next_offset from jsonb_array_elements(p_old->'transfers')a
 where a->>'candidateVersionId'=v and a->'acquisition'=last_c->'acquisition';
 select (a->>'offset')::bigint into last_offset from jsonb_array_elements(p_old->'transfers')with ordinality x(a,ord)
 where a->>'candidateVersionId'=v and a->'acquisition'=last_c->'acquisition' order by ord desc limit 1;
 if t->>'offset' is null or not(t->>'offset'~'^[0-9]{1,8}$') then return null;end if;
 next_offset:=coalesce(next_offset,0);
 if (t->>'offset')::bigint is distinct from next_offset and (t->>'offset')::bigint is distinct from last_offset then return null;end if;
 if (t->>'offset')::bigint>=(last_c->>'sizeBytes')::bigint then return null;end if;
 wanted:=least(2097152,(last_c->>'sizeBytes')::bigint-(t->>'offset')::bigint);
 if used_bytes+wanted>252428800 or used_io>=120000 then return null;end if;
 if (t->>'offset')::bigint=last_offset and (candidate_retries>=2 or total_retries>=6) then return null;end if;
 expected:=jsonb_build_object('requestId',req,'candidateVersionId',v,'acquisition',(last_c->>'acquisition')::integer,
  'offset',(t->>'offset')::bigint,'bytesReserved',wanted,'ioMsReserved',120000-used_io,
  'retry',coalesce((t->>'offset')::bigint=last_offset,false),'settlement',null);
 if t=expected and p_new=jsonb_set(b,'{transfers}',(p_old->'transfers')||jsonb_build_array(expected)) then return 'reserve';end if;
 return null;
exception when others then return null;
end $fn$;
revoke all on function private.restitch_selection_step_kind(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.service_read_restitch_selection_slot(p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;
begin
 select * into r from private.restitch_selection_roots
 where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null or p_slot not in('start','end') then return null;end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot;
 if s.root_operation_id is null then return null;end if;
 -- Internal readback remains available for accounting after cancellation/revocation.
 return jsonb_build_object('rootOperationId',r.root_operation_id,'teamId',r.team_id,
  'actorId',r.actor_id,'slot',s.slot,'budget',s.budget);
end $fn$;

create function public.service_cas_restitch_selection_slot(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_expected_budget jsonb,p_next_budget jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare o public.team_operations%rowtype;r private.restitch_selection_roots%rowtype;
 s private.restitch_selection_slots%rowtype;m public.team_materials%rowtype;c private.restitch_selection_candidates%rowtype;
 step text;last_candidate jsonb;
begin
 select * into o from public.team_operations where id=p_root_operation for update;
 select * into r from private.restitch_selection_roots
  where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null or o.team_id is distinct from p_team or o.actor_id is distinct from p_actor then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not private.can(p_team,'download',p_actor) or (o.kind='process' and not private.can(p_team,'process',p_actor)) then
  raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if o.kind not in('download','process') or o.state not in('pending','running')
  or o.source_material_id is distinct from r.source_material_id then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=r.source_material_id and team_id=p_team for share;
 if m.id is null or m.lifecycle<>'active' or m.drive_version is distinct from r.source_version then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if p_slot is null or p_slot not in('start','end') or r.recipe->'defaults'->>'sourceMode' is distinct from 'drive'
  or r.recipe->'defaults'->>'configured' is distinct from 'true'
  or coalesce(r.recipe->'defaults'->>'operation','') not in('stitch','restitch')
  or coalesce(r.recipe->'defaults'->>(p_slot||'Enabled'),'true')<>'true' then
  raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot for update;
 if s.root_operation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if s.snapshot_complete is null then raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
 if s.budget is distinct from p_expected_budget then return false;end if;
 step:=private.restitch_selection_step_kind(s.budget,p_next_budget);
 if step is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 last_candidate:=p_next_budget->'candidates'->(jsonb_array_length(p_next_budget->'candidates')-1);
 if step in('select','reserve') then
  select * into c from private.restitch_selection_candidates where root_operation_id=p_root_operation
   and slot=p_slot and version_id=(last_candidate->>'versionId')::uuid;
  if c.version_id is null or c.size_bytes is distinct from (last_candidate->>'sizeBytes')::bigint then
   raise exception 'RESTITCH_SOURCES_INVALID' using errcode='55000';end if;
  if step='reserve' then
   select * into m from public.team_materials where id=c.material_id and team_id=p_team for share;
   if m.id is null or m.lifecycle<>'active' or m.checksum is distinct from c.checksum
    or m.size_bytes is distinct from c.size_bytes or m.mime_type is distinct from c.mime_type then
    raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
   if not exists(select 1 from public.team_drive_connections where id=m.connection_id and team_id=p_team and state='connected') then
    raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  end if;
 end if;
 update private.restitch_selection_slots set budget=p_next_budget where root_operation_id=p_root_operation and slot=p_slot;
 return true;
end $fn$;

create function public.service_settle_restitch_selection_range(
 p_root_operation uuid,p_team uuid,p_actor uuid,p_slot text,p_request uuid,
 p_expected_reservation jsonb,p_measurement jsonb)
returns boolean language plpgsql security definer set search_path='' as $fn$
declare r private.restitch_selection_roots%rowtype;s private.restitch_selection_slots%rowtype;
 t jsonb;position_index integer;b jsonb;received bigint;elapsed bigint;completed boolean;
begin
 -- Same lock order as new-dispatch CAS. Rights/state may change after the issued
 -- read; neither may prevent recording its exact measured cost.
 perform 1 from public.team_operations where id=p_root_operation for update;
 select * into r from private.restitch_selection_roots
  where root_operation_id=p_root_operation and team_id=p_team and actor_id=p_actor;
 if r.root_operation_id is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into s from private.restitch_selection_slots where root_operation_id=p_root_operation and slot=p_slot for update;
 if s.root_operation_id is null then raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 select value,(ordinality-1)::integer into t,position_index
 from jsonb_array_elements(s.budget->'transfers')with ordinality where value->>'requestId'=p_request::text;
 if t is null or (t-'settlement') is distinct from (p_expected_reservation-'settlement') then return false;end if;
 if p_measurement is null or p_measurement->>'bytes' is null or p_measurement->>'ioMs' is null or not(p_measurement->>'bytes'~'^[0-9]{1,8}$') or not(p_measurement->>'ioMs'~'^[0-9]{1,16}$')
  or jsonb_typeof(p_measurement->'complete') is distinct from 'boolean' then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 received:=(p_measurement->>'bytes')::bigint;elapsed:=(p_measurement->>'ioMs')::bigint;
 completed:=(p_measurement->>'complete')::boolean;
 if received not between 0 and (t->>'bytesReserved')::bigint or elapsed>9007199254740991
  or (completed and received<>(t->>'bytesReserved')::bigint)
  or p_measurement is distinct from jsonb_build_object('bytes',received,'ioMs',elapsed,'complete',completed) then
  raise exception 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' using errcode='55000';end if;
 if t->'settlement'<>'null'::jsonb then return t->'settlement'=p_measurement;end if;
 if p_expected_reservation->'settlement' is distinct from 'null'::jsonb
  or position_index<>jsonb_array_length(s.budget->'transfers')-1 then return false;end if;
 b:=jsonb_set(s.budget,array['transfers',position_index::text,'settlement'],p_measurement);
 b:=jsonb_set(b,'{revision}',to_jsonb((s.budget->>'revision')::bigint+1));
 update private.restitch_selection_slots set budget=b where root_operation_id=p_root_operation and slot=p_slot;
 return true;
end $fn$;

revoke all on function public.service_read_restitch_selection_slot(uuid,uuid,uuid,text),
 public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb),
 public.service_settle_restitch_selection_range(uuid,uuid,uuid,text,uuid,jsonb,jsonb)
 from public,anon,authenticated,service_role;
grant execute on function public.service_read_restitch_selection_slot(uuid,uuid,uuid,text),
 public.service_cas_restitch_selection_slot(uuid,uuid,uuid,text,jsonb,jsonb),
 public.service_settle_restitch_selection_range(uuid,uuid,uuid,text,uuid,jsonb,jsonb) to service_role;
revoke all on function private.restitch_selection_root_binding(),private.restitch_selection_initialize_slots(),
 private.restitch_selection_freeze_candidate() from public,anon,authenticated,service_role;

create function private.restitch_selection_measurement_ok(p_reservation jsonb,p_measurement jsonb) returns boolean
language plpgsql immutable set search_path='' as $fn$
declare received bigint;elapsed bigint;completed boolean;
begin
 if p_measurement is null or jsonb_typeof(p_measurement) is distinct from 'object'
  or p_measurement->>'bytes' is null or p_measurement->>'ioMs' is null
  or not(p_measurement->>'bytes'~'^[0-9]{1,8}$') or not(p_measurement->>'ioMs'~'^[0-9]{1,16}$')
  or jsonb_typeof(p_measurement->'complete') is distinct from 'boolean' then return false;end if;
 received:=(p_measurement->>'bytes')::bigint;elapsed:=(p_measurement->>'ioMs')::bigint;completed:=(p_measurement->>'complete')::boolean;
 return (received between 0 and (p_reservation->>'bytesReserved')::bigint and elapsed<=9007199254740991
  and (not completed or received=(p_reservation->>'bytesReserved')::bigint)
  and p_measurement=jsonb_build_object('bytes',received,'ioMs',elapsed,'complete',completed)) is true;
exception when others then return false;
end $fn$;
create function private.restitch_selection_budget_fence() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare initial jsonb:='{"schemaVersion":1,"revision":0,"candidates":[],"transfers":[],"refreshes":[],"acceptedVersionId":null}';
 last_index integer;t jsonb;measurement jsonb;expected jsonb;
begin
 if tg_op='INSERT' then
  if new.budget is distinct from initial then raise exception 'WRONG_STATE' using errcode='55000';end if;
  return new;
 end if;
 new.updated_at:=case when new.budget is distinct from old.budget or new.snapshot_complete is distinct from old.snapshot_complete then clock_timestamp() else old.updated_at end;
 if new.root_operation_id is distinct from old.root_operation_id or new.slot is distinct from old.slot then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 if new.snapshot_complete is distinct from old.snapshot_complete then
  if old.budget->>'revision'<>'0' or new.budget is distinct from old.budget then
   raise exception 'WRONG_STATE' using errcode='55000';end if;
 end if;
 if new.budget=old.budget then return new;end if;
 if private.restitch_selection_step_kind(old.budget,new.budget) is not null then return new;end if;
 -- The only other state change is exact bookkeeping of the last held range.
 last_index:=jsonb_array_length(old.budget->'transfers')-1;
 if last_index<0 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 t:=old.budget->'transfers'->last_index;
 measurement:=new.budget->'transfers'->last_index->'settlement';
 if t->'settlement' is distinct from 'null'::jsonb or not private.restitch_selection_measurement_ok(t,measurement) then
  raise exception 'WRONG_STATE' using errcode='55000';end if;
 expected:=jsonb_set(old.budget,array['transfers',last_index::text,'settlement'],measurement);
 expected:=jsonb_set(expected,'{revision}',to_jsonb((old.budget->>'revision')::bigint+1));
 if new.budget is distinct from expected then raise exception 'WRONG_STATE' using errcode='55000';end if;
 return new;
end $fn$;
create trigger restitch_selection_budget_guard before insert or update on private.restitch_selection_slots
 for each row execute function private.restitch_selection_budget_fence();
revoke all on function private.restitch_selection_measurement_ok(jsonb,jsonb),private.restitch_selection_budget_fence()
 from public,anon,authenticated,service_role;

create view public.analytics_restitch_selection_slots with(security_barrier=true) as
select r.root_operation_id as operation_id,r.team_id,r.actor_id,s.slot,r.pool_namespace_id,
 r.created_at,s.updated_at,s.snapshot_complete,
 case when exists(select 1 from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) then 'range_unconfirmed'
  when s.budget->'acceptedVersionId'<>'null'::jsonb and exists(
   select 1 from jsonb_array_elements(s.budget->'candidates')a where a->>'versionId'=s.budget->>'acceptedVersionId'
    and a->'validatedAcquisition'=a->'acquisition' and a->>'rejected'='false') then 'screen_validated'
  when jsonb_array_length(s.budget->'candidates')=0 then 'awaiting_selection'
  when s.budget->'candidates'->(jsonb_array_length(s.budget->'candidates')-1)->>'rejected'='true' then 'candidate_rejected'
  else 'candidate_selected' end as state,
 jsonb_array_length(s.budget->'candidates') as candidate_count,
 coalesce((select jsonb_agg(x.value->>'versionId' order by x.ordinality) from jsonb_array_elements(s.budget->'candidates')with ordinality x(value,ordinality)),'[]'::jsonb) as candidate_versions,
 jsonb_array_length(s.budget->'transfers') as range_count,
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'='null'::jsonb) as unconfirmed_range_count,
 coalesce((select sum((a->'settlement'->>'bytes')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_bytes,
 coalesce((select sum((a->'settlement'->>'ioMs')::bigint) from jsonb_array_elements(s.budget->'transfers')a where a->'settlement'<>'null'::jsonb),0)::bigint as confirmed_io_ms,
 coalesce((select sum((a->>'acquisition')::integer) from jsonb_array_elements(s.budget->'candidates')a),0)::integer+
 (select count(*)::integer from jsonb_array_elements(s.budget->'transfers')a where a->>'retry'='true') as retry_count,
 jsonb_array_length(s.budget->'refreshes') as refresh_count,
 (s.budget->>'revision')::integer as budget_revision
from private.restitch_selection_roots r join private.restitch_selection_slots s using(root_operation_id);
revoke all on public.analytics_restitch_selection_slots from public,anon,authenticated,service_role;
grant select on public.analytics_restitch_selection_slots to service_role,wishly_analytics_ro;

commit;
