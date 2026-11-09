-- Inactive publication authority. No provider writer or browser bypass is enabled.
begin;
create table private.catalog_publication_targets (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id),
 kind text not null check(kind in('source','video_set')), source_material_id uuid, source_version text,
 video_set_id uuid, recipe_revision bigint,
 unique(id,team_id),
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 foreign key(video_set_id,team_id,recipe_revision) references private.catalog_video_set_recipes(video_set_id,team_id,recipe_revision),
 check((kind='source' and source_material_id is not null and source_version is not null and length(source_version) between 1 and 128 and video_set_id is null and recipe_revision is null)
    or (kind='video_set' and source_material_id is null and source_version is null and video_set_id is not null and recipe_revision>0))
);
create table private.catalog_video_publication_policies (
 catalog_material_id uuid primary key references public.team_product_catalogs(material_id), team_id uuid not null,
 actor_id uuid not null references auth.users(id), revision bigint not null check(revision>0),
 mode text not null check(mode in('immediate','scheduled','held')), due_at timestamptz, time_zone text,
 legacy_delivery_unverified boolean not null default true, target_id uuid not null, updated_at timestamptz not null default clock_timestamp(),
 unique(catalog_material_id,team_id), foreign key(catalog_material_id,team_id) references public.team_materials(id,team_id),
 foreign key(target_id,team_id) references private.catalog_publication_targets(id,team_id),
 check((mode='scheduled' and due_at is not null and time_zone is not null) or (mode<>'scheduled' and due_at is null and time_zone is null))
);
create table private.catalog_video_publication_jobs (
 id uuid primary key default gen_random_uuid(),catalog_material_id uuid not null,team_id uuid not null,
 revision bigint not null check(revision>0),command_id uuid not null,target_id uuid not null,actor_id uuid not null references auth.users(id),
 state text not null default 'waiting' check(state in('waiting','preparing','applying','verifying','retry_wait','unknown','blocked','cancel_requested','published','superseded','held')),
 blocked_reason text check(blocked_reason in('writer_unsupported','legacy_adoption_required','target_unavailable','job_blocked','stale_job','clock_unavailable','invalid_due')),worker_id uuid,lease_until timestamptz,writer_fence uuid,dispatched_at timestamptz,
 provider_revision text,verified_at timestamptz,next_attempt_at timestamptz not null default clock_timestamp(),created_at timestamptz not null default clock_timestamp(),
 unique(catalog_material_id,revision), foreign key(catalog_material_id,team_id) references private.catalog_video_publication_policies(catalog_material_id,team_id),
 foreign key(target_id,team_id) references private.catalog_publication_targets(id,team_id),
 check(dispatched_at is null or writer_fence is not null)
);
create unique index catalog_video_publication_one_active on private.catalog_video_publication_jobs(catalog_material_id)
 where state not in('published','superseded');
create index catalog_video_publication_commands on private.catalog_video_publication_jobs(command_id);
create index catalog_video_publication_due on private.catalog_video_publication_jobs(next_attempt_at) where state in('waiting','preparing','retry_wait');
create table private.catalog_video_deliveries (
 catalog_material_id uuid primary key,team_id uuid not null,target_id uuid not null,
 provider_revision text not null check(length(provider_revision) between 1 and 1024),verified_at timestamptz not null,
 foreign key(catalog_material_id,team_id) references private.catalog_video_publication_policies(catalog_material_id,team_id),
 foreign key(target_id,team_id) references private.catalog_publication_targets(id,team_id)
);
create table private.catalog_publication_baseline_checks (
 id uuid primary key,team_id uuid not null,actor_id uuid not null references auth.users(id),catalog_material_id uuid not null,
 revision bigint not null,job_id uuid not null references private.catalog_video_publication_jobs(id),fence uuid not null,
 source_material_id uuid not null,source_version text not null,source_file_id text not null,catalog_file_id text not null,source_root_folder_id text not null,catalog_root_folder_id text not null,product_count integer not null check(product_count between 1 and 400),
 created_at timestamptz not null default clock_timestamp(),closed_at timestamptz,expires_at timestamptz not null default clock_timestamp()+interval '5 minutes',state text not null default 'reading' check(state in('reading','verified','aborted')),
 provider_revision text,video_cells_digest text,receipt jsonb,
 foreign key(catalog_material_id,team_id) references private.catalog_video_publication_policies(catalog_material_id,team_id),
 foreign key(source_material_id,team_id) references public.team_materials(id,team_id),
 check(video_cells_digest is null or video_cells_digest ~ '^[a-f0-9]{64}$')
);
alter table private.catalog_publication_baseline_checks enable row level security;
alter table private.catalog_publication_baseline_checks force row level security;
revoke all on private.catalog_publication_baseline_checks from public,anon,authenticated,service_role;
create table private.catalog_publication_commands (
 request_id uuid not null,team_id uuid not null,actor_id uuid not null references auth.users(id),
 payload jsonb not null check(jsonb_typeof(payload)='object'),receipt jsonb not null check(jsonb_typeof(receipt)='object'),
 created_at timestamptz not null default clock_timestamp(),primary key(request_id,team_id,actor_id)
);
alter table private.catalog_video_publication_jobs add constraint catalog_publication_command_binding foreign key(command_id,team_id,actor_id) references private.catalog_publication_commands(request_id,team_id,actor_id) deferrable initially deferred;
alter table private.catalog_publication_targets enable row level security;
alter table private.catalog_publication_targets force row level security;
alter table private.catalog_video_publication_policies enable row level security;
alter table private.catalog_video_publication_policies force row level security;
alter table private.catalog_video_publication_jobs enable row level security;
alter table private.catalog_video_publication_jobs force row level security;
alter table private.catalog_video_deliveries enable row level security;
alter table private.catalog_video_deliveries force row level security;
alter table private.catalog_publication_commands enable row level security;
alter table private.catalog_publication_commands force row level security;
revoke all on private.catalog_publication_targets,private.catalog_video_publication_policies,private.catalog_video_publication_jobs,private.catalog_video_deliveries,private.catalog_publication_commands from public,anon,authenticated,service_role;
-- Canonical length-prefixed UTF-8 bytes, identical to the publication-only TS
-- helper. Never JSONB text, and never a bare Drive version that survives rebind.
create function private.catalog_publication_source_version(p_material uuid,p_team uuid,p_strict boolean default false) returns text language plpgsql stable set search_path='' as $$
declare m public.team_materials%rowtype;parts text[];part text;canonical text:='';mode text;
begin
 select * into m from public.team_materials where id=p_material and team_id=p_team;
 if m.id is null or (m.drive_file_id !~ '^[A-Za-z0-9_-]+$' or length(m.drive_file_id)>256) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if not p_strict and m.checksum ~* '^([a-f0-9]{32}|[a-f0-9]{64})$' and m.mime_type ~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' and length(m.mime_type)<=128 and m.size_bytes between 0 and 9007199254740991 then
  mode:='content-v1';parts:=array[mode,m.id::text,m.connection_id::text,m.drive_file_id,lower(m.checksum),lower(m.mime_type),m.size_bytes::text];
 else
  if m.drive_version is null or m.drive_version !~ '^[A-Za-z0-9._:-]{1,128}$' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  mode:='strict-v1';parts:=array[mode,m.id::text,m.connection_id::text,m.drive_file_id,m.drive_version];
 end if;
 foreach part in array parts loop canonical:=canonical||octet_length(part)::text||':'||part;end loop;
 return mode||':'||encode(sha256(convert_to(canonical,'UTF8')),'hex');
end $$;
create function private.catalog_publication_source_matches(p_material uuid,p_team uuid,p_version text) returns boolean language plpgsql stable set search_path='' as $$
begin
 if p_version like 'content-v1:%' then return p_version=private.catalog_publication_source_version(p_material,p_team,false);end if;
 if p_version like 'strict-v1:%' then return p_version=private.catalog_publication_source_version(p_material,p_team,true);end if;
 return false;
end $$;
revoke all on function private.catalog_publication_source_version(uuid,uuid,boolean),private.catalog_publication_source_matches(uuid,uuid,text) from public,anon,authenticated,service_role;
create function private.catalog_publication_target_json(p_id uuid) returns jsonb language sql stable set search_path='' as $$
 select case t.kind when 'source' then jsonb_build_object('kind','source','materialId',t.source_material_id,'sourceVersion',t.source_version)
 else jsonb_build_object('kind','video_set','videoSetId',t.video_set_id,'recipeRevision',t.recipe_revision) end from private.catalog_publication_targets t where t.id=p_id;
$$;
create function private.catalog_publication_target_observation(p_target uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare t private.catalog_publication_targets%rowtype;status text:='unknown';s private.catalog_video_sets%rowtype;
begin
 select * into t from private.catalog_publication_targets where id=p_target;
 if t.kind='source' then
  if not exists(select 1 from public.team_materials where id=t.source_material_id and team_id=t.team_id and lifecycle='active') then status:='unavailable';
  elsif private.catalog_publication_source_matches(t.source_material_id,t.team_id,t.source_version) then status:='available';else status:='changed';end if;
 elsif t.kind='video_set' then
  select * into s from private.catalog_video_sets where id=t.video_set_id and team_id=t.team_id;
  if s.id is null or s.state in('canceled','cancel_requested') then status:='unavailable';
  elsif s.state in('accepted','preparing') then status:='preparing';
  elsif s.state='ready' and not exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=t.team_id where v.video_set_id=s.id and (v.state<>'registered' or m.lifecycle is distinct from 'active')) then status:='available';end if;
 end if;
 return jsonb_build_object('basis','indexed','state',status);
exception when others then return jsonb_build_object('basis','indexed','state','unknown');
end;$$;
revoke all on function private.catalog_publication_target_observation(uuid) from public,anon,authenticated,service_role;
create function public.service_read_catalog_publication(p_team uuid,p_actor uuid,p_catalog uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p private.catalog_video_publication_policies%rowtype;j private.catalog_video_publication_jobs%rowtype;a private.catalog_video_deliveries%rowtype;draft jsonb;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog and team_id=p_team;
 if p.catalog_material_id is null then
  select jsonb_build_object('catalogId',c.material_id,'dueState','unknown','providerCas','unsupported','targetObservation',jsonb_build_object('basis','indexed','state','available'),'revision',0,'mode','immediate','dueAt',null,'timeZone',null,'job',null,'active',null,
   'serverNow',floor(extract(epoch from clock_timestamp())*1000),'target',jsonb_build_object('kind','source','materialId',m.id,'sourceVersion',private.catalog_publication_source_version(m.id,p_team))) into draft
  from public.team_product_catalogs c join public.team_materials m on m.id=c.video_material_id and m.team_id=c.team_id
  join public.team_materials catalog on catalog.id=c.material_id and catalog.lifecycle='active'
  where c.material_id=p_catalog and c.team_id=p_team and m.lifecycle='active';
  if draft is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;return draft;
 end if;
 select * into j from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and revision=p.revision;
 select * into a from private.catalog_video_deliveries where catalog_material_id=p_catalog;
 return jsonb_build_object('providerCas','unsupported','dueState',case when j.state='published' then 'settled' when p.mode='held' then 'held' when p.mode='scheduled' and p.due_at>statement_timestamp() then 'future' else 'due' end,'targetObservation',private.catalog_publication_target_observation(p.target_id),'serverNow',floor(extract(epoch from clock_timestamp())*1000),'catalogId',p.catalog_material_id,'revision',p.revision,'mode',p.mode,'dueAt',p.due_at,'timeZone',p.time_zone,
 'target',private.catalog_publication_target_json(p.target_id),'job',case when j.id is null then null else jsonb_build_object('id',j.id,'revision',j.revision,'state',j.state,'writerFence',j.writer_fence,'blockedReason',j.blocked_reason) end,
 'active',case when a.catalog_material_id is null then null else jsonb_build_object('target',private.catalog_publication_target_json(a.target_id),'providerRevision',a.provider_revision,'verifiedAt',a.verified_at) end);
end $$;
create function public.service_read_catalog_publication_command(p_team uuid,p_actor uuid,p_request uuid,p_catalog uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c private.catalog_publication_commands%rowtype;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into c from private.catalog_publication_commands where request_id=p_request and team_id=p_team and actor_id=p_actor;
 if c.request_id is null then return null;end if;
 if c.payload->>'catalogId' is distinct from p_catalog::text then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return c.receipt;
end $$;
create function public.service_save_catalog_publication(p_team uuid,p_actor uuid,p_request uuid,p_catalog uuid,p_expected_revision bigint,p_mode text,p_due timestamptz,p_zone text,p_target jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.catalog_video_publication_policies%rowtype;prior private.catalog_publication_commands%rowtype;target_id uuid;payload jsonb;receipt jsonb;
begin
 if p_request is null or p_actor is null or not private.can(p_team,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p_expected_revision is null or p_expected_revision<0 or p_mode not in('immediate','scheduled','held') or p_mode is null or jsonb_typeof(p_target) is distinct from 'object' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 perform 1 from public.team_materials m join public.team_product_catalogs c on c.material_id=m.id where m.id=p_catalog and m.team_id=p_team and m.lifecycle='active' for update of m;
 if not found then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 payload:=jsonb_build_object('catalogId',p_catalog,'expectedRevision',p_expected_revision,'mode',p_mode,'dueAt',p_due,'timeZone',p_zone,'target',p_target);
 perform pg_advisory_xact_lock(hashtextextended(p_request::text||p_team::text||p_actor::text,0));
 select * into prior from private.catalog_publication_commands where request_id=p_request and team_id=p_team and actor_id=p_actor;
 if prior.request_id is not null then
  if prior.payload is distinct from payload then raise exception 'INVALID_INPUT' using errcode='22023';end if;return prior.receipt;
 end if;
 if (p_mode='scheduled' and (p_due is null or not isfinite(p_due) or extract(year from p_due)>9999 or p_due<=clock_timestamp() or p_zone is null or not exists(select 1 from pg_timezone_names where name=p_zone))) or (p_mode<>'scheduled' and (p_due is not null or p_zone is not null)) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog for update;
 if coalesce(p.revision,0)<>p_expected_revision then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if exists(select 1 from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and state in('applying','verifying','unknown','cancel_requested')) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if p_target->>'kind'='source' then
  if p_target ? 'videoSetId' or p_target ? 'recipeRevision' or not exists(select 1 from public.team_materials m where m.id=(p_target->>'materialId')::uuid and m.team_id=p_team and m.lifecycle='active' and m.category='video' and private.catalog_publication_source_matches(m.id,p_team,p_target->>'sourceVersion')) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',(p_target->>'materialId')::uuid,p_target->>'sourceVersion') returning id into target_id;
 elsif p_target->>'kind'='video_set' then
  if p_target ? 'materialId' or p_target ? 'sourceVersion' or not exists(select 1 from private.catalog_video_set_recipes r join private.catalog_video_sets s on s.id=r.video_set_id and s.team_id=r.team_id where r.video_set_id=(p_target->>'videoSetId')::uuid and r.team_id=p_team and r.recipe_revision=(p_target->>'recipeRevision')::bigint and s.state not in('canceled','cancel_requested') and private.catalog_video_recipe_consumer_allowed(r.video_set_id,p_team,r.recipe_revision,p_catalog,p_actor)) then raise exception 'WRONG_STATE' using errcode='55000';end if;
  insert into private.catalog_publication_targets(team_id,kind,video_set_id,recipe_revision) values(p_team,'video_set',(p_target->>'videoSetId')::uuid,(p_target->>'recipeRevision')::bigint) returning id into target_id;
 else raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_video_publication_jobs set state='superseded',worker_id=null,lease_until=null where catalog_material_id=p_catalog and state not in('published','superseded');
 insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,due_at,time_zone,target_id)
 values(p_catalog,p_team,p_actor,p_expected_revision+1,p_mode,p_due,p_zone,target_id)
 on conflict(catalog_material_id) do update set actor_id=excluded.actor_id,revision=excluded.revision,mode=excluded.mode,due_at=excluded.due_at,time_zone=excluded.time_zone,target_id=excluded.target_id,updated_at=clock_timestamp();
 insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,actor_id,revision,command_id,target_id,state,blocked_reason)
 values(p_catalog,p_team,p_actor,p_expected_revision+1,p_request,target_id,
 case when p_mode='held' then 'held' when (select legacy_delivery_unverified from private.catalog_video_publication_policies where catalog_material_id=p_catalog) and not exists(select 1 from private.catalog_video_deliveries where catalog_material_id=p_catalog) then 'blocked' else 'waiting' end,
 case when p_mode<>'held' and (select legacy_delivery_unverified from private.catalog_video_publication_policies where catalog_material_id=p_catalog) and not exists(select 1 from private.catalog_video_deliveries where catalog_material_id=p_catalog) then 'legacy_adoption_required' else null end);
 receipt:=public.service_read_catalog_publication(p_team,p_actor,p_catalog);
 insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt) values(p_request,p_team,p_actor,payload,receipt);
 return receipt;
end $$;
alter table private.catalog_update_reconciliations add column publication_job_id uuid references private.catalog_video_publication_jobs(id),add column publication_revision bigint;
create function public.service_claim_catalog_publication_jobs(p_worker uuid,p_limit integer default 3) returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;p private.catalog_video_publication_policies%rowtype;items jsonb:='[]'::jsonb;
begin
 if p_worker is null or p_limit is null or p_limit<1 or p_limit>3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 for j in select q.* from private.catalog_video_publication_jobs q join private.catalog_video_publication_policies policy_row on policy_row.catalog_material_id=q.catalog_material_id and policy_row.revision=q.revision
 where q.state in('waiting','preparing','retry_wait') and q.dispatched_at is null and q.next_attempt_at<=clock_timestamp()
 and (q.lease_until is null or q.lease_until<=clock_timestamp()) and (policy_row.mode='immediate' or (policy_row.mode='scheduled' and policy_row.due_at<=clock_timestamp()))
 order by q.next_attempt_at,q.id limit p_limit for update of q skip locked
 loop
  select * into p from private.catalog_video_publication_policies where catalog_material_id=j.catalog_material_id;
  if not private.can(j.team_id,'process',j.actor_id) or not exists(select 1 from public.team_materials where id=j.catalog_material_id and team_id=j.team_id and lifecycle='active') then
   update private.catalog_video_publication_jobs set state='blocked',blocked_reason='target_unavailable' where id=j.id;continue;
  end if;
  update private.catalog_video_publication_jobs set worker_id=p_worker,lease_until=clock_timestamp()+interval '5 minutes' where id=j.id;
  items:=items||jsonb_build_array(jsonb_build_object('jobId',j.id,'teamId',j.team_id,'actorId',j.actor_id,'catalogId',j.catalog_material_id,
   'policy',jsonb_build_object('mode',p.mode,'revision',p.revision,'dueAt',p.due_at,'timeZone',p.time_zone),
   'job',jsonb_build_object('revision',j.revision,'writerFence',j.writer_fence,'state',j.state,'target',private.catalog_publication_target_json(j.target_id)),
   'active',(public.service_read_catalog_publication(j.team_id,j.actor_id,j.catalog_material_id))->'active'));
 end loop;
 return jsonb_build_object('serverNow',floor(extract(epoch from clock_timestamp())*1000),'items',items);
end $$;
create function public.service_reserve_catalog_publication(p_job uuid,p_worker uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;p private.catalog_video_publication_policies%rowtype;c public.team_product_catalogs%rowtype;f uuid;
begin
 select * into j from private.catalog_video_publication_jobs where id=p_job;
 if j.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_materials where id=j.catalog_material_id for update;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=j.catalog_material_id for update;
 select * into j from private.catalog_video_publication_jobs where id=p_job for update;
 if j.worker_id is distinct from p_worker or j.lease_until<=clock_timestamp() or j.revision<>p.revision or j.state not in('waiting','preparing','retry_wait') or j.dispatched_at is not null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if not private.can(j.team_id,'process',j.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if p.mode='held' or p.legacy_delivery_unverified or (p.mode='scheduled' and p.due_at>clock_timestamp()) then return null;end if;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and publication_job_id is distinct from j.id) then return null;end if;
 if j.writer_fence is not null then return j.writer_fence;end if;
 select * into c from public.team_product_catalogs where material_id=j.catalog_material_id;
 f:=gen_random_uuid();
 insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot,publication_job_id,publication_revision)
 values(j.catalog_material_id,f,c.update_count,c.product_count,c.settings_snapshot,j.id,j.revision);
 update private.catalog_video_publication_jobs set writer_fence=f where id=j.id;
 return f;
end $$;
create function public.service_dispatch_catalog_publication(p_job uuid,p_worker uuid,p_fence uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;p private.catalog_video_publication_policies%rowtype;
begin
 select * into j from private.catalog_video_publication_jobs where id=p_job for update;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=j.catalog_material_id;
 if j.id is null or j.worker_id is distinct from p_worker or j.writer_fence is distinct from p_fence or p_fence is null or j.lease_until<=clock_timestamp() or j.revision<>p.revision or p.mode='held' or (p.mode='scheduled' and p.due_at>clock_timestamp()) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if j.dispatched_at is not null then return false;end if;
 if not private.can(j.team_id,'process',j.actor_id) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and marker=p_fence and publication_job_id=j.id and publication_revision=j.revision) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 update private.catalog_video_publication_jobs set state='applying',dispatched_at=clock_timestamp() where id=j.id;
 return true;
end $$;
create function public.service_settle_catalog_publication(p_job uuid,p_worker uuid,p_fence uuid,p_outcome text,p_provider_revision text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare j private.catalog_video_publication_jobs%rowtype;p private.catalog_video_publication_policies%rowtype;
begin
 select * into j from private.catalog_video_publication_jobs where id=p_job;
 if j.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_materials where id=j.catalog_material_id for update;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=j.catalog_material_id for update;
 select * into j from private.catalog_video_publication_jobs where id=p_job for update;
 if p_outcome not in('verified','unknown','waiting','blocked') or p_outcome is null or j.worker_id is distinct from p_worker or j.writer_fence is distinct from p_fence or p_fence is null or j.revision<>p.revision then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if j.state='published' then
  if p_outcome='verified' and p_provider_revision=j.provider_revision then return true;end if;
  raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
 end if;
 if not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and marker=p_fence and publication_job_id=j.id) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if p_outcome in('waiting','blocked') then
  if j.dispatched_at is not null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  update private.catalog_video_publication_jobs set state=case when p_outcome='waiting' then 'retry_wait' else 'blocked' end,worker_id=null,lease_until=null,writer_fence=null,next_attempt_at=clock_timestamp()+interval '1 minute' where id=j.id;
  delete from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and marker=p_fence and publication_job_id=j.id;return true;
 end if;
 if j.dispatched_at is null then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if p_outcome='unknown' then update private.catalog_video_publication_jobs set state='unknown' where id=j.id;return true;end if;
 if p_provider_revision is null or length(p_provider_revision) not between 1 and 1024 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at) values(j.catalog_material_id,j.team_id,j.target_id,p_provider_revision,clock_timestamp())
 on conflict(catalog_material_id) do update set target_id=excluded.target_id,provider_revision=excluded.provider_revision,verified_at=excluded.verified_at;
 update private.catalog_video_publication_jobs set state='published',provider_revision=p_provider_revision,verified_at=clock_timestamp(),lease_until=null where id=j.id;
 update private.catalog_video_publication_policies set mode='immediate',due_at=null,time_zone=null,legacy_delivery_unverified=false where catalog_material_id=j.catalog_material_id and revision=j.revision;
 delete from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id and marker=p_fence and publication_job_id=j.id;
 return true;
end $$;
create function public.service_defer_catalog_publication(p_job uuid,p_worker uuid,p_state text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_state not in('waiting','blocked') or p_state is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 update private.catalog_video_publication_jobs set state=case when p_state='waiting' then 'retry_wait' else 'blocked' end,worker_id=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '1 minute'
 where id=p_job and worker_id=p_worker and writer_fence is null and dispatched_at is null and state in('waiting','preparing','retry_wait');
 return found;
end $$;
revoke all on function private.catalog_publication_target_json(uuid) from public,anon,authenticated,service_role;
revoke all on function public.service_read_catalog_publication_command(uuid,uuid,uuid,uuid),public.service_read_catalog_publication(uuid,uuid,uuid),public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamptz,text,jsonb),public.service_claim_catalog_publication_jobs(uuid,integer),public.service_reserve_catalog_publication(uuid,uuid),public.service_dispatch_catalog_publication(uuid,uuid,uuid),public.service_settle_catalog_publication(uuid,uuid,uuid,text,text),public.service_defer_catalog_publication(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_read_catalog_publication_command(uuid,uuid,uuid,uuid),public.service_read_catalog_publication(uuid,uuid,uuid),public.service_save_catalog_publication(uuid,uuid,uuid,uuid,bigint,text,timestamptz,text,jsonb),public.service_claim_catalog_publication_jobs(uuid,integer),public.service_reserve_catalog_publication(uuid,uuid),public.service_dispatch_catalog_publication(uuid,uuid,uuid),public.service_settle_catalog_publication(uuid,uuid,uuid,text,text),public.service_defer_catalog_publication(uuid,uuid,text) to service_role;
-- Legacy reconciliation is metadata-only and must never settle a video-cell job.
create or replace function public.service_claim_catalog_reconciliations(p_limit integer default 3)
returns table(catalog_material_id uuid,marker uuid,baseline_version text,drive_file_id text,resource_key text,credential_id uuid)
language plpgsql security definer set search_path='' as $$
begin
 return query with due as (
  select pending.catalog_material_id from private.catalog_update_reconciliations pending
  join public.team_catalog_updater_items item on item.catalog_material_id=pending.catalog_material_id
  where pending.publication_job_id is null and pending.next_check_at<=clock_timestamp() and item.reconciliation_required
  and (item.lease_expires_at is null or item.lease_expires_at<=clock_timestamp())
  order by pending.next_check_at for update of pending skip locked limit least(greatest(p_limit,1),10)
 ), claimed as (
  update private.catalog_update_reconciliations pending set next_check_at=clock_timestamp()+interval '5 minutes'
  from due where pending.catalog_material_id=due.catalog_material_id
  returning pending.catalog_material_id,pending.marker,pending.baseline_version
 ) select claimed.catalog_material_id,claimed.marker,claimed.baseline_version,m.drive_file_id,m.resource_key,c.credential_id
 from claimed join public.team_materials m on m.id=claimed.catalog_material_id join public.team_drive_connections c on c.id=m.connection_id;
end $$;
alter function public.service_resolve_catalog_reconciliation(uuid,uuid,text,text) set schema private;
alter function private.service_resolve_catalog_reconciliation(uuid,uuid,text,text) rename to publication_legacy_resolve_catalog_reconciliation;
revoke all on function private.publication_legacy_resolve_catalog_reconciliation(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.service_resolve_catalog_reconciliation(p_item uuid,p_marker uuid,p_outcome text,p_worker text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.team_materials where id=p_item for update;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item and publication_job_id is not null) then return false;end if;
 return private.publication_legacy_resolve_catalog_reconciliation(p_item,p_marker,p_outcome,p_worker);
end $$;
alter function public.service_finish_catalog_update_write(uuid) set schema private;
alter function private.service_finish_catalog_update_write(uuid) rename to publication_legacy_finish_catalog_update_write;
revoke all on function private.publication_legacy_finish_catalog_update_write(uuid) from public,anon,authenticated,service_role;
create function public.service_finish_catalog_update_write(p_item uuid) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.team_materials where id=p_item for update;
 if exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_item and publication_job_id is not null) then return false;end if;
 return private.publication_legacy_finish_catalog_update_write(p_item);
end $$;
alter function public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb) set schema private;
alter function private.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb) rename to publication_legacy_begin_catalog_update_write;
revoke all on function private.publication_legacy_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb) from public,anon,authenticated,service_role;
create function public.service_begin_catalog_update_write(p_item uuid,p_worker text,p_marker uuid,p_baseline_version text,p_expected_count integer,p_swapped_copy uuid,p_product_count integer,p_settings_snapshot jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.team_materials where id=p_item for update;
 if exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=p_item) then return false;end if;
 return private.publication_legacy_begin_catalog_update_write(p_item,p_worker,p_marker,p_baseline_version,p_expected_count,p_swapped_copy,p_product_count,p_settings_snapshot);
end $$;
revoke all on function public.service_claim_catalog_reconciliations(integer),public.service_resolve_catalog_reconciliation(uuid,uuid,text,text),public.service_finish_catalog_update_write(uuid),public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.service_claim_catalog_reconciliations(integer),public.service_resolve_catalog_reconciliation(uuid,uuid,text,text),public.service_finish_catalog_update_write(uuid),public.service_begin_catalog_update_write(uuid,text,uuid,text,integer,uuid,integer,jsonb) to service_role;
create function public.service_catalog_publication_allows_legacy_write(p_catalog uuid) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=p_catalog);
$$;
revoke all on function public.service_catalog_publication_allows_legacy_write(uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_publication_allows_legacy_write(uuid) to service_role;
create function public.service_authorize_catalog_baseline_check(p_check uuid,p_team uuid,p_actor uuid,p_fence uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.catalog_publication_baseline_checks%rowtype;ctx jsonb;
begin
 select * into b from private.catalog_publication_baseline_checks where id=p_check;
 if b.id is null or b.team_id<>p_team or b.actor_id<>p_actor or b.fence is distinct from p_fence or p_fence is null or not private.can(p_team,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if b.state<>'reading' or b.expires_at<=clock_timestamp() then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 if not exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=b.catalog_material_id and revision=b.revision) or not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=b.catalog_material_id and marker=b.fence and publication_job_id=b.job_id) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 select jsonb_build_object('checkId',b.id,'fence',b.fence,'catalogMaterialId',b.catalog_material_id,'catalogFileId',m.drive_file_id,'catalogResourceKey',m.resource_key,'sourceMaterialId',source.id,'sourceFileId',source.drive_file_id,'sourceResourceKey',source.resource_key,'sourceVersion',b.source_version,'sourceDriveVersion',source.drive_version,'sourceConnectionId',source.connection_id,'sourceLink',coalesce(c.current_video_link,c.video_link),'sourceRootFolderId',source_conn.root_folder_id,'catalogRootFolderId',conn.root_folder_id,'productCount',c.product_count,'catalogCredentialId',conn.credential_id,'sourceCredentialId',source_conn.credential_id) into ctx
 from public.team_product_catalogs c join public.team_materials m on m.id=c.material_id and m.team_id=b.team_id and m.lifecycle='active'
 join public.team_materials source on source.id=b.source_material_id and source.team_id=b.team_id and source.lifecycle='active'
 join public.team_drive_connections conn on conn.id=m.connection_id and conn.state='connected'
 join public.team_drive_connections source_conn on source_conn.id=source.connection_id and source_conn.state='connected'
 where c.material_id=b.catalog_material_id and m.drive_file_id=b.catalog_file_id and source.drive_file_id=b.source_file_id and private.catalog_publication_source_matches(source.id,p_team,b.source_version) and c.product_count=b.product_count and conn.root_folder_id=b.catalog_root_folder_id and source_conn.root_folder_id=b.source_root_folder_id and ((c.current_video_link is null and c.video_material_id=b.source_material_id) or (c.current_video_link is not null and exists(select 1 from public.team_catalog_restitch_copies copy where copy.catalog_material_id=c.material_id and copy.material_id=b.source_material_id and copy.team_id=b.team_id and copy.role='in_use' and copy.shared_link=c.current_video_link and copy.drive_file_id=source.drive_file_id)));
 if ctx is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;return ctx;
end $$;
create function public.service_begin_catalog_baseline_check(p_check uuid,p_team uuid,p_actor uuid,p_catalog uuid,p_expected_revision bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.catalog_video_publication_policies%rowtype;j private.catalog_video_publication_jobs%rowtype;b private.catalog_publication_baseline_checks%rowtype;c public.team_product_catalogs%rowtype;source public.team_materials%rowtype;catalog public.team_materials%rowtype;f uuid;source_root text;catalog_root text;
begin
 if p_check is null or p_actor is null or p_expected_revision is null or not private.can(p_team,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into catalog from public.team_materials where id=p_catalog and team_id=p_team and lifecycle='active' for update;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog and team_id=p_team for update;
 select * into b from private.catalog_publication_baseline_checks where id=p_check for update;
 if b.id is not null then
  if b.team_id<>p_team or b.actor_id<>p_actor or b.catalog_material_id<>p_catalog or b.revision<>p_expected_revision then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
  if b.state='verified' then return jsonb_build_object('receipt',b.receipt);end if;
  return public.service_authorize_catalog_baseline_check(p_check,p_team,p_actor,b.fence);
 end if;
 if catalog.id is null or p.catalog_material_id is null or p.revision<>p_expected_revision then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into j from private.catalog_video_publication_jobs where catalog_material_id=p_catalog and revision=p.revision for update;
 if j.id is null or j.dispatched_at is not null or j.writer_fence is not null or j.state not in('held','blocked','waiting','preparing','retry_wait') or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 select * into c from public.team_product_catalogs where material_id=p_catalog;
 if c.current_video_link is null then
  select * into source from public.team_materials where id=c.video_material_id and team_id=p_team and lifecycle='active';
 else
  select m.* into source from public.team_catalog_restitch_copies copy join public.team_materials m on m.id=copy.material_id and m.team_id=p_team and m.lifecycle='active'
  where copy.catalog_material_id=p_catalog and copy.team_id=p_team and copy.role='in_use' and copy.shared_link=c.current_video_link and copy.drive_file_id=m.drive_file_id;
 end if;
 if source.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select root_folder_id into source_root from public.team_drive_connections where id=source.connection_id and state='connected';
 select root_folder_id into catalog_root from public.team_drive_connections where id=catalog.connection_id and state='connected';
 if source_root is null or catalog_root is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 f:=gen_random_uuid();
 insert into private.catalog_publication_baseline_checks(id,team_id,actor_id,catalog_material_id,revision,job_id,fence,source_material_id,source_version,source_file_id,catalog_file_id,source_root_folder_id,catalog_root_folder_id,product_count) values(p_check,p_team,p_actor,p_catalog,p.revision,j.id,f,source.id,private.catalog_publication_source_version(source.id,p_team),source.drive_file_id,catalog.drive_file_id,source_root,catalog_root,c.product_count);
 insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot,publication_job_id,publication_revision) values(p_catalog,f,c.update_count,c.product_count,c.settings_snapshot,j.id,p.revision);
 return public.service_authorize_catalog_baseline_check(p_check,p_team,p_actor,f);
end $$;
create function public.service_finish_catalog_baseline_check(p_check uuid,p_team uuid,p_actor uuid,p_fence uuid,p_outcome text,p_provider_revision text,p_video_cells_digest text) returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.catalog_publication_baseline_checks%rowtype;target_id uuid;response_snapshot jsonb;
begin
 select * into b from private.catalog_publication_baseline_checks where id=p_check;
 if b.id is null then raise exception 'NOT_FOUND' using errcode='P0002';end if;
 perform 1 from public.team_materials where id=b.catalog_material_id for update;
 perform 1 from private.catalog_video_publication_policies where catalog_material_id=b.catalog_material_id for update;
 select * into b from private.catalog_publication_baseline_checks where id=p_check for update;
 if b.actor_id<>p_actor or b.team_id<>p_team or b.fence is distinct from p_fence or not private.can(p_team,'process',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if b.state='verified' then return b.receipt;end if;
 perform public.service_authorize_catalog_baseline_check(p_check,p_team,p_actor,p_fence);
 if p_outcome not in('blank','source') or p_outcome is null or p_provider_revision is null or length(p_provider_revision) not between 1 and 1024 or p_video_cells_digest is null or p_video_cells_digest !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 if p_outcome='blank' then
  if exists(select 1 from private.catalog_video_deliveries where catalog_material_id=b.catalog_material_id) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 else
  insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',b.source_material_id,b.source_version) returning id into target_id;
  insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at) values(b.catalog_material_id,p_team,target_id,p_provider_revision,clock_timestamp())
  on conflict(catalog_material_id) do update set target_id=excluded.target_id,provider_revision=excluded.provider_revision,verified_at=excluded.verified_at;
 end if;
 update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=b.catalog_material_id;
 update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where id=b.job_id and state='blocked' and blocked_reason='legacy_adoption_required';
 delete from private.catalog_update_reconciliations where catalog_material_id=b.catalog_material_id and marker=p_fence and publication_job_id=b.job_id;
 response_snapshot:=public.service_read_catalog_publication(p_team,p_actor,b.catalog_material_id);
 update private.catalog_publication_baseline_checks set state='verified',closed_at=clock_timestamp(),provider_revision=p_provider_revision,video_cells_digest=p_video_cells_digest,receipt=response_snapshot where id=p_check;
 return response_snapshot;
end $$;
create function public.service_abort_catalog_baseline_check(p_check uuid,p_team uuid,p_actor uuid,p_fence uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare b private.catalog_publication_baseline_checks%rowtype;
begin
 select * into b from private.catalog_publication_baseline_checks where id=p_check for update;
 if b.id is null or b.team_id<>p_team or b.actor_id<>p_actor or b.fence is distinct from p_fence then return false;end if;
 if b.state<>'reading' then return false;end if;
 delete from private.catalog_update_reconciliations where catalog_material_id=b.catalog_material_id and marker=b.fence and publication_job_id=b.job_id;
 update private.catalog_publication_baseline_checks set state='aborted',closed_at=clock_timestamp() where id=b.id;return true;
end $$;
revoke all on function public.service_authorize_catalog_baseline_check(uuid,uuid,uuid,uuid),public.service_begin_catalog_baseline_check(uuid,uuid,uuid,uuid,bigint),public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text),public.service_abort_catalog_baseline_check(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_authorize_catalog_baseline_check(uuid,uuid,uuid,uuid),public.service_begin_catalog_baseline_check(uuid,uuid,uuid,uuid,bigint),public.service_finish_catalog_baseline_check(uuid,uuid,uuid,uuid,text,text,text),public.service_abort_catalog_baseline_check(uuid,uuid,uuid,uuid) to service_role;
create function public.service_read_catalog_baseline_check(p_check uuid,p_team uuid,p_actor uuid,p_catalog uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b private.catalog_publication_baseline_checks%rowtype;
begin
 if p_actor is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into b from private.catalog_publication_baseline_checks where id=p_check and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog;
 if b.id is not null and b.state='aborted' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if b.id is null or b.state<>'verified' then return null;end if;return b.receipt;
end $$;
revoke all on function public.service_read_catalog_baseline_check(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_read_catalog_baseline_check(uuid,uuid,uuid,uuid) to service_role;
-- Agent-readable bounded evidence; no URLs, credentials, cells or content hashes.
create view public.analytics_catalog_video_publications with(security_barrier=true) as
 select p.catalog_material_id,p.team_id,p.actor_id,p.revision policy_revision,p.mode publication_mode,p.due_at,p.time_zone,p.updated_at policy_updated_at,
 desired.kind desired_target_kind,desired.source_material_id desired_source_material_id,desired.source_version desired_source_version,desired.video_set_id desired_video_set_id,desired.recipe_revision desired_recipe_revision,
 j.id job_id,j.command_id,cmd.payload->>'dueAt' job_due_at,cmd.payload->>'timeZone' job_time_zone,cmd.payload->>'mode' requested_mode,j.revision job_revision,j.state job_state,j.blocked_reason,j.writer_fence is not null writer_fence_present,j.dispatched_at,j.lease_until,j.next_attempt_at,j.created_at job_created_at,j.provider_revision job_provider_revision,j.verified_at job_verified_at,
 pending.kind job_target_kind,pending.source_material_id job_source_material_id,pending.source_version job_source_version,pending.video_set_id job_video_set_id,pending.recipe_revision job_recipe_revision,video_set.requested_count requested_generated_video_count,case when video_set.id is null then null else (select count(*) from private.catalog_video_variants child where child.video_set_id=video_set.id and child.state='registered') end registered_generated_video_count,
 active.kind active_target_kind,active.source_material_id active_source_material_id,active.source_version active_source_version,active.video_set_id active_video_set_id,active.recipe_revision active_recipe_revision,d.verified_at active_verified_at,d.provider_revision active_provider_revision,
 p.legacy_delivery_unverified,clock_timestamp() observed_at
 from private.catalog_video_publication_policies p
 join private.catalog_publication_targets desired on desired.id=p.target_id
 left join private.catalog_video_publication_jobs j on j.catalog_material_id=p.catalog_material_id
 left join private.catalog_publication_targets pending on pending.id=j.target_id
 left join private.catalog_publication_commands cmd on cmd.request_id=j.command_id and cmd.team_id=j.team_id and cmd.actor_id=j.actor_id
 left join private.catalog_video_sets video_set on video_set.id=pending.video_set_id
 left join private.catalog_video_deliveries d on d.catalog_material_id=p.catalog_material_id
 left join private.catalog_publication_targets active on active.id=d.target_id;
create view public.analytics_catalog_video_baselines with(security_barrier=true) as
 select id check_id,team_id,actor_id,catalog_material_id,revision,job_id,state,created_at,closed_at,expires_at,provider_revision,video_cells_digest is not null cell_proof_present,receipt is not null receipt_present,clock_timestamp() observed_at
 from private.catalog_publication_baseline_checks;
revoke all on public.analytics_catalog_video_publications,public.analytics_catalog_video_baselines from public,anon,authenticated;
grant select on public.analytics_catalog_video_publications,public.analytics_catalog_video_baselines to service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_video_publications,public.analytics_catalog_video_baselines to wishly_analytics_ro;
 end if;
end $$;

-- Trusted database observation for initial calendar acceptance. No provider I/O.
create function public.service_catalog_publication_clock() returns bigint language sql stable security definer set search_path='' as $$ select floor(extract(epoch from statement_timestamp())*1000)::bigint $$;
revoke all on function public.service_catalog_publication_clock() from public,anon,authenticated;
grant execute on function public.service_catalog_publication_clock() to service_role;

-- Read-only initial creation progress; never reacquires a generation lease.
create function private.catalog_initial_video_progress(p_set uuid,p_cells text,p_held boolean) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('videoSetId',s.id,'requestedCount',s.requested_count,'registeredCount',(select count(*) from private.catalog_video_variants v where v.video_set_id=s.id and v.state='registered'),'state',case when s.state in('ready','unknown','cancel_requested','canceled') then s.state else 'preparing' end,'catalogVideoCells',p_cells,'publicationHeld',p_held,'providerCas','unsupported') from private.catalog_video_sets s where s.id=p_set;
$$;
revoke all on function private.catalog_initial_video_progress(uuid,text,boolean) from public,anon,authenticated,service_role;
create function public.service_read_initial_catalog_video(p_team uuid,p_actor uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;s private.catalog_video_sets%rowtype;n integer;
begin
 if private.can(p_team,'view',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if i.id is null or i.request_payload->>'catalogVideoProtocolVersion' is distinct from '1' then return null;end if;
 if i.state='registered' then
  select * into s from private.catalog_video_sets where team_id=p_team and (catalog_intent_id=i.id and actor_id=p_actor or exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=catalog_video_sets.id and ref.team_id=p_team and ref.actor_id=p_actor and ref.catalog_intent_id=i.id and ref.recipe_revision=1));
  if s.id is null then return i.result;end if;
  return i.result||jsonb_build_object('videoGenerationObservation',private.catalog_initial_video_progress(s.id,case when i.request_payload#>>'{videoPublication,mode}'='scheduled' then 'deferred_blank' else 'assigned' end,exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=(i.checkpoint->>'materialId')::uuid and mode='held')));
 end if;
 select * into s from private.catalog_video_sets where team_id=p_team and (catalog_intent_id=i.id and actor_id=p_actor or exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=catalog_video_sets.id and ref.team_id=p_team and ref.actor_id=p_actor and ref.catalog_intent_id=i.id and ref.recipe_revision=1));
 if s.id is null then return null;end if;
 select count(*) into n from private.catalog_video_variants where video_set_id=s.id and state='registered';
 return jsonb_build_object('outcome','preparing_video','catalogIntentId',i.id,'videoSetId',s.id,'requestedCount',s.requested_count,'registeredCount',n,'state',case when i.state='canceled' then 'canceled' when s.state in('unknown','cancel_requested','canceled') then s.state else 'preparing' end);
end;$$;
revoke all on function public.service_read_initial_catalog_video(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_read_initial_catalog_video(uuid,uuid,text) to service_role;

create table private.catalog_initial_video_cancellations(request_id uuid primary key,team_id uuid not null references public.teams(id),actor_id uuid not null references auth.users(id),request_key text not null,receipt jsonb not null,created_at timestamptz not null default clock_timestamp());
alter table private.catalog_initial_video_cancellations enable row level security;alter table private.catalog_initial_video_cancellations force row level security;
revoke all on private.catalog_initial_video_cancellations from public,anon,authenticated,service_role;
create function public.service_cancel_initial_catalog_video(p_team uuid,p_actor uuid,p_key text,p_request uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;s private.catalog_video_sets%rowtype;prior private.catalog_initial_video_cancellations%rowtype;receipt jsonb;policy private.catalog_video_publication_policies%rowtype;job private.catalog_video_publication_jobs%rowtype;target private.catalog_publication_targets%rowtype;created boolean;catalog uuid;
begin
 if p_request is null or private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into prior from private.catalog_initial_video_cancellations where request_id=p_request;
 if prior.request_id is not null then
  if prior.team_id<>p_team or prior.actor_id<>p_actor or prior.request_key<>p_key then raise exception 'WRONG_STATE' using errcode='55000';end if;return prior.receipt;
 end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key for update;
 if i.id is null or i.request_payload->>'catalogVideoProtocolVersion' is distinct from '1' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 created:=i.state='registered';
 if created then
  catalog:=(i.checkpoint->>'materialId')::uuid;
  if i.request_payload#>>'{videoPublication,mode}' is distinct from 'scheduled' or not exists(select 1 from private.catalog_initial_publication_checks b where b.intent_id=i.id and b.catalog_material_id=catalog and b.state='verified') then raise exception 'WRONG_STATE' using errcode='55000';end if;
  perform 1 from public.team_materials where id=catalog and team_id=p_team and lifecycle='active' for update;
  if not found then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 elsif i.operation_id is not null or i.state in('create_started','created','finalized') then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into s from private.catalog_video_sets where team_id=p_team and (catalog_intent_id=i.id and actor_id=p_actor or exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=catalog_video_sets.id and ref.team_id=p_team and ref.actor_id=p_actor and ref.catalog_intent_id=i.id and ref.recipe_revision=1)) for update;
 if s.id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if created then
  select * into policy from private.catalog_video_publication_policies where catalog_material_id=catalog and team_id=p_team for update;
  select * into job from private.catalog_video_publication_jobs where catalog_material_id=catalog and revision=policy.revision;
  select * into target from private.catalog_publication_targets where id=policy.target_id;
  if target.kind='video_set' and target.video_set_id=s.id and target.recipe_revision=1 then
   if job.dispatched_at is not null or job.writer_fence is not null or job.state in('applying','verifying','unknown','cancel_requested') or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
   -- Hold only the exact original pending publication. A later manual policy
   -- remains its owner's choice; cancellation never clears a writer fence.
   if policy.revision=1 and job.command_id=i.id and job.state not in('published','superseded') then
    perform public.service_save_catalog_publication(p_team,p_actor,p_request,catalog,policy.revision,'held',null,null,private.catalog_publication_target_json(policy.target_id));
   end if;
  end if;
 end if;
 -- A fully ready set can already have another consumer; retain its immutable
 -- registrations. Only unfinished work owned by this original parent is stopped.
 if s.state<>'ready' then
  if s.catalog_intent_id is distinct from i.id then raise exception 'WRONG_STATE' using errcode='55000';end if;
  update private.catalog_video_sets set state=case when exists(select 1 from private.catalog_video_variants where video_set_id=s.id and state in('working','unknown')) then 'cancel_requested' else 'canceled' end,revision=revision+1,updated_at=clock_timestamp() where id=s.id;
 end if;
 if not created then update private.catalog_generation_intents set state='canceled',lease_owner=null,lease_expires_at=null,next_attempt_at=null,updated_at=clock_timestamp() where id=i.id;end if;
 receipt:=public.service_read_initial_catalog_video(p_team,p_actor,p_key);
 insert into private.catalog_initial_video_cancellations(request_id,team_id,actor_id,request_key,receipt) values(p_request,p_team,p_actor,p_key,receipt);
 return receipt;
end;$$;
revoke all on function public.service_cancel_initial_catalog_video(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.service_cancel_initial_catalog_video(uuid,uuid,text,uuid) to service_role;

create function public.service_read_initial_catalog_request(p_team uuid,p_actor uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and request_key=p_key;
 if i.id is null or i.request_payload->>'catalogVideoProtocolVersion' is distinct from '1' or i.state='canceled' then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if i.request_payload->>'restitchEnabled' is distinct from 'false' and private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 return i.request_payload;
end;$$;
revoke all on function public.service_read_initial_catalog_request(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_read_initial_catalog_request(uuid,uuid,text) to service_role;
create table private.catalog_initial_publication_checks (
 intent_id uuid primary key references private.catalog_generation_intents(id),team_id uuid not null,actor_id uuid not null,catalog_material_id uuid not null unique,
 job_id uuid not null references private.catalog_video_publication_jobs(id),fence uuid not null,file_id text not null,connection_id uuid not null,root_folder_id text not null,
 state text not null default 'reading' check(state in('reading','verified')),provider_revision text,cells_digest text,created_at timestamptz not null default clock_timestamp(),verified_at timestamptz
);
alter table private.catalog_initial_publication_checks enable row level security;alter table private.catalog_initial_publication_checks force row level security;
revoke all on private.catalog_initial_publication_checks from public,anon,authenticated,service_role;
create function public.service_begin_initial_catalog_publication(p_team uuid,p_actor uuid,p_intent uuid,p_catalog uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;b private.catalog_initial_publication_checks%rowtype;m public.team_materials%rowtype;conn public.team_drive_connections%rowtype;c public.team_product_catalogs%rowtype;plan jsonb;target_id uuid;job_id uuid;f uuid;mode text;due timestamptz;zone text;receipt jsonb;set_id uuid;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where id=p_intent and team_id=p_team and actor_id=p_actor for update;
 if i.id is null or i.request_payload->>'catalogVideoProtocolVersion' is distinct from '1' or i.state not in('finalized','registered','interrupted') or i.checkpoint->>'materialId' is distinct from p_catalog::text then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if i.request_payload->>'restitchEnabled' is distinct from 'false' and private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=p_catalog and team_id=p_team and lifecycle='active' for update;
 select * into c from public.team_product_catalogs where material_id=p_catalog and team_id=p_team;
 select * into conn from public.team_drive_connections where id=m.connection_id and team_id=p_team and state='connected';
 if m.id is null or c.material_id is null or conn.id is null or jsonb_typeof(i.checkpoint->'sheetRows') is distinct from 'array' or jsonb_array_length(i.checkpoint->'sheetRows')<>c.product_count+2 then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into b from private.catalog_initial_publication_checks where intent_id=p_intent;
 if b.intent_id is not null then
  if b.catalog_material_id<>p_catalog or b.actor_id<>p_actor or b.file_id<>m.drive_file_id or b.connection_id<>m.connection_id or b.root_folder_id<>conn.root_folder_id then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
  if b.state='verified' then return jsonb_build_object('state','verified');end if;
 else
  plan:=i.checkpoint->'initialVideoPlan';
  if jsonb_typeof(plan) is distinct from 'object' or plan#>>'{preferences,catalogVideoProtocolVersion}'<>'1' or plan#>'{preferences,videoPublication}' is distinct from i.request_payload->'videoPublication' or plan#>'{preferences,restitchEnabled}' is distinct from i.request_payload->'restitchEnabled' or plan#>'{preferences,videoVariationCount}' is distinct from i.request_payload->'videoVariationCount' then raise exception 'WRONG_STATE' using errcode='55000';end if;
  if coalesce((plan->>'recipeRevision')::bigint,1)<>1 then raise exception 'WRONG_STATE' using errcode='55000';end if;
  mode:=plan#>>'{preferences,videoPublication,mode}';
  if mode='scheduled' then
   due:=(plan#>>'{preferences,videoPublication,dueAt}')::timestamptz;zone:=plan#>>'{preferences,videoPublication,timeZone}';
   if due is null or not isfinite(due) or due<=to_timestamp((plan->>'acceptedAt')::numeric/1000) or not exists(select 1 from pg_timezone_names where name=zone) then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  elsif mode<>'immediate' or mode is null then raise exception 'INVALID_INPUT' using errcode='22023';end if;
  if exists(select 1 from private.catalog_video_publication_policies where catalog_material_id=p_catalog) or exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
  if plan#>>'{preferences,restitchEnabled}'='true' then
   set_id:=(plan->>'setId')::uuid;
   if not exists(select 1 from private.catalog_video_sets s where s.id=set_id and s.team_id=p_team and ((s.actor_id=p_actor and s.catalog_intent_id=p_intent) or exists(select 1 from private.catalog_video_recipe_references ref where ref.video_set_id=s.id and ref.team_id=p_team and ref.actor_id=p_actor and ref.catalog_intent_id=p_intent and ref.recipe_revision=coalesce((plan->>'recipeRevision')::bigint,1) and s.state='ready')) and s.source_material_id=i.video_material_id and s.product_count=c.product_count and s.state not in('canceled','cancel_requested') and s.requested_count=(plan#>>'{preferences,videoVariationCount}')::integer and (select count(*) from private.catalog_video_variants where video_set_id=s.id)=s.requested_count and (mode='scheduled' or (s.state='ready' and not exists(select 1 from private.catalog_video_variants v left join public.team_materials out on out.id=v.output_material_id and out.team_id=p_team where v.video_set_id=s.id and (v.state<>'registered' or out.id is null or out.lifecycle<>'active'))))) then raise exception 'WRONG_STATE' using errcode='55000';end if;
   insert into private.catalog_publication_targets(team_id,kind,video_set_id,recipe_revision) values(p_team,'video_set',set_id,1) returning id into target_id;
  else
   insert into private.catalog_publication_targets(team_id,kind,source_material_id,source_version) values(p_team,'source',i.video_material_id,private.catalog_publication_source_version(i.video_material_id,p_team)) returning id into target_id;
  end if;
  insert into private.catalog_video_publication_policies(catalog_material_id,team_id,actor_id,revision,mode,due_at,time_zone,target_id) values(p_catalog,p_team,p_actor,1,mode,due,zone,target_id);
  insert into private.catalog_video_publication_jobs(catalog_material_id,team_id,revision,command_id,target_id,actor_id,state,blocked_reason) values(p_catalog,p_team,1,p_intent,target_id,p_actor,'blocked','legacy_adoption_required') returning id into job_id;
  receipt:=public.service_read_catalog_publication(p_team,p_actor,p_catalog);
  insert into private.catalog_publication_commands(request_id,team_id,actor_id,payload,receipt) values(p_intent,p_team,p_actor,jsonb_build_object('catalogId',p_catalog,'mode',mode,'dueAt',due,'timeZone',zone,'target',private.catalog_publication_target_json(target_id)),receipt);
  f:=gen_random_uuid();
  insert into private.catalog_update_reconciliations(catalog_material_id,marker,expected_count,product_count,settings_snapshot,publication_job_id,publication_revision) values(p_catalog,f,c.update_count,c.product_count,c.settings_snapshot,job_id,1);
  insert into private.catalog_initial_publication_checks(intent_id,team_id,actor_id,catalog_material_id,job_id,fence,file_id,connection_id,root_folder_id) values(p_intent,p_team,p_actor,p_catalog,job_id,f,m.drive_file_id,m.connection_id,conn.root_folder_id) returning * into b;
 end if;
 if not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog and marker=b.fence and publication_job_id=b.job_id) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 return jsonb_build_object('state','reading','fence',b.fence,'credentialId',conn.credential_id,'fileId',b.file_id,'rootFolderId',b.root_folder_id,'rows',i.checkpoint->'sheetRows');
end;$$;
create function public.service_finish_initial_catalog_publication(p_team uuid,p_actor uuid,p_intent uuid,p_catalog uuid,p_fence uuid,p_provider_revision text,p_cells_digest text) returns boolean language plpgsql security definer set search_path='' as $$
declare b private.catalog_initial_publication_checks%rowtype;p private.catalog_video_publication_policies%rowtype;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into b from private.catalog_initial_publication_checks where intent_id=p_intent and team_id=p_team and actor_id=p_actor and catalog_material_id=p_catalog for update;
 if exists(select 1 from private.catalog_generation_intents where id=p_intent and request_payload->>'restitchEnabled' is distinct from 'false') and private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 if b.intent_id is null or b.fence<>p_fence then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if b.state='verified' then return b.provider_revision=p_provider_revision and b.cells_digest=p_cells_digest;end if;
 if p_provider_revision is null or length(p_provider_revision) not between 1 and 1024 or p_cells_digest is null or p_cells_digest!~'^[a-f0-9]{64}$' or not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=p_catalog and marker=p_fence and publication_job_id=b.job_id) then raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';end if;
 perform 1 from public.team_materials where id=p_catalog and team_id=p_team and lifecycle='active' and drive_file_id=b.file_id and connection_id=b.connection_id for update;
 if not found then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select * into p from private.catalog_video_publication_policies where catalog_material_id=p_catalog for update;
 if p.revision<>1 or not exists(select 1 from private.catalog_video_publication_jobs where id=b.job_id and state='blocked' and dispatched_at is null) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if exists(select 1 from private.catalog_publication_targets t where t.id=p.target_id and ((t.kind='source' and not private.catalog_publication_source_matches(t.source_material_id,p_team,t.source_version)) or (t.kind='video_set' and (not exists(select 1 from private.catalog_video_sets s where s.id=t.video_set_id and s.team_id=p_team and s.state not in('canceled','cancel_requested') and (p.mode='scheduled' or s.state='ready')) or (p.mode<>'scheduled' and exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team where v.video_set_id=t.video_set_id and (v.state<>'registered' or m.lifecycle is distinct from 'active'))))))) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if p.mode='immediate' then
  insert into private.catalog_video_deliveries(catalog_material_id,team_id,target_id,provider_revision,verified_at) values(p_catalog,p_team,p.target_id,p_provider_revision,clock_timestamp());
  update private.catalog_video_publication_jobs set state='published',blocked_reason=null,provider_revision=p_provider_revision,verified_at=clock_timestamp() where id=b.job_id;
 else
  update private.catalog_video_publication_jobs set state='waiting',blocked_reason=null where id=b.job_id;
 end if;
 update private.catalog_video_publication_policies set legacy_delivery_unverified=false where catalog_material_id=p_catalog;
 update private.catalog_initial_publication_checks set state='verified',provider_revision=p_provider_revision,cells_digest=p_cells_digest,verified_at=clock_timestamp() where intent_id=p_intent;
 delete from private.catalog_update_reconciliations where catalog_material_id=p_catalog and marker=p_fence and publication_job_id=b.job_id;
 return true;
end;$$;
revoke all on function public.service_begin_initial_catalog_publication(uuid,uuid,uuid,uuid),public.service_finish_initial_catalog_publication(uuid,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.service_begin_initial_catalog_publication(uuid,uuid,uuid,uuid),public.service_finish_initial_catalog_publication(uuid,uuid,uuid,uuid,uuid,text,text) to service_role;
create function public.service_initial_catalog_video_context(p_team uuid,p_actor uuid,p_source uuid,p_executor uuid,p_require_executor boolean default true) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.team_materials%rowtype;c public.team_drive_connections%rowtype;executor uuid;defaults jsonb;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true or (p_require_executor is not false and private.can(p_team,'process',p_actor) is not true) then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into m from public.team_materials where id=p_source and team_id=p_team and lifecycle='active' and category='video';
 select * into c from public.team_drive_connections where id=m.connection_id and team_id=p_team and state='connected';
 if m.id is null or c.id is null then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 if p_executor is not null then
  select d.installation_id into executor from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor and d.installation_id=p_executor and d.revoked_at is null and d.expires_at>statement_timestamp();
 else
  select case when count(*)=1 then min(d.installation_id::text)::uuid else null end into executor from private.team_recovery_delegations d where d.team_id=p_team and d.actor_id=p_actor and d.revoked_at is null and d.expires_at>statement_timestamp();
 end if;
 if p_require_executor is not false and executor is null then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 defaults:=private.effective_restitch_defaults_json(p_team,p_actor);
 return jsonb_build_object('executorId',executor,'defaults',defaults,'material',jsonb_build_object('connectionId',m.connection_id,'fileId',m.drive_file_id,'version',m.drive_version,'credentialId',c.credential_id,'rootFolderId',c.root_folder_id));
end;$$;
create function public.service_initial_catalog_video_outputs(p_team uuid,p_actor uuid,p_set uuid,p_recipe bigint) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s private.catalog_video_sets%rowtype;outputs jsonb;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into s from private.catalog_video_sets where id=p_set and team_id=p_team and actor_id=p_actor and state='ready';
 if s.id is null or not exists(select 1 from private.catalog_video_recipe_references where video_set_id=p_set and team_id=p_team and recipe_revision=p_recipe and actor_id=p_actor and catalog_intent_id=s.catalog_intent_id) then raise exception 'WRONG_STATE' using errcode='55000';end if;
 if (select count(*) from private.catalog_video_variants where video_set_id=p_set and state='registered')<>s.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team left join public.team_drive_connections c on c.id=m.connection_id and c.team_id=p_team left join public.team_operations original on original.id=v.operation_id and original.team_id=p_team where v.video_set_id=p_set and (v.state<>'registered' or m.lifecycle is distinct from 'active' or c.state is distinct from 'connected' or original.state is distinct from 'succeeded' or original.actor_id is distinct from p_actor or original.source_material_id is distinct from s.source_material_id or original.result_material_id is distinct from v.output_material_id or not exists(select 1 from private.team_operation_intents original_intent where original_intent.operation_id=original.id and original_intent.team_id=p_team and original_intent.tool_id='restitch' and original_intent.expected_source_version=s.source_version))) then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 select jsonb_agg(jsonb_build_object('rowId',a.recipe_row_id,'materialId',m.id,'connectionId',m.connection_id,'sourceVersion',private.catalog_publication_source_version(m.id,p_team),'fileId',m.drive_file_id,'credentialId',c.credential_id,'rootFolderId',c.root_folder_id)) into outputs
 from private.catalog_video_assignments a join private.catalog_video_variants v on v.video_set_id=a.video_set_id and v.video_variant_index=a.video_variant_index join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team join public.team_drive_connections c on c.id=m.connection_id and c.team_id=p_team
 where a.video_set_id=p_set and a.team_id=p_team and a.recipe_revision=p_recipe;
 return outputs;
end;$$;
revoke all on function public.service_initial_catalog_video_context(uuid,uuid,uuid,uuid,boolean),public.service_initial_catalog_video_outputs(uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.service_initial_catalog_video_context(uuid,uuid,uuid,uuid,boolean),public.service_initial_catalog_video_outputs(uuid,uuid,uuid,bigint) to service_role;

do $$ declare t text;begin foreach t in array array['catalog_publication_targets','catalog_video_deliveries','catalog_initial_publication_checks','catalog_video_publication_jobs','catalog_publication_commands','catalog_publication_baseline_checks','catalog_video_publication_policies','catalog_initial_video_cancellations'] loop execute format('create trigger task_cleanup_reference_fence before insert or update on private.%I for each row execute function private.guard_task_cleanup_reference()',t);end loop;end $$;

-- Default-off writer still produces a durable explanation when a verified due
-- job cannot use an approved provider CAS. Never claims or clears any fence.
create function public.service_mark_due_catalog_publications_unsupported(p_limit integer default 3) returns integer language plpgsql security definer set search_path='' as $$
declare marked integer;
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 with due as (
 select j.id from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision
 join public.team_materials m on m.id=j.catalog_material_id and m.team_id=j.team_id and m.lifecycle='active'
 where j.state in('waiting','preparing','retry_wait') and j.writer_fence is null and j.dispatched_at is null and not p.legacy_delivery_unverified
 and p.mode<>'held' and (p.mode='immediate' or p.due_at<=statement_timestamp())
 and private.can(j.team_id,'view',j.actor_id) and (private.can(j.team_id,'process',j.actor_id) or exists(select 1 from private.catalog_generation_intents original where original.id=j.command_id and original.team_id=j.team_id and original.actor_id=j.actor_id and original.request_payload->>'catalogVideoProtocolVersion'='1' and original.request_payload->>'restitchEnabled'='false' and private.can(j.team_id,'upload',j.actor_id)))
 and not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id)
 order by j.next_attempt_at,j.id for update of j skip locked limit p_limit
 ), changed as (update private.catalog_video_publication_jobs j set state='blocked',blocked_reason='writer_unsupported',worker_id=null,lease_until=null from due where j.id=due.id returning j.id)
 select count(*) into marked from changed;
 return marked;
end;$$;
revoke all on function public.service_mark_due_catalog_publications_unsupported(integer) from public,anon,authenticated;
grant execute on function public.service_mark_due_catalog_publications_unsupported(integer) to service_role;

-- Reuse the existing catalog/Launch cron lane and canonical intent leases.
create function public.service_list_initial_catalog_recovery(p_limit integer default 3) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 3 then raise exception 'INVALID_INPUT' using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('teamId',x.team_id,'actorId',x.actor_id,'idempotencyKey',x.request_key)) from (
 select i.team_id,i.actor_id,i.request_key from private.catalog_generation_intents i
 where i.request_payload->>'catalogVideoProtocolVersion'='1' and i.request_key ~ '^product-catalog:[0-9a-f-]{36}$'
 and i.state in('interrupted','create_started','created','finalized') and i.next_attempt_at<=statement_timestamp() and (i.lease_expires_at is null or i.lease_expires_at<=statement_timestamp())
 and private.can(i.team_id,'view',i.actor_id) and private.can(i.team_id,'upload',i.actor_id) and (i.request_payload->>'restitchEnabled'='false' or private.can(i.team_id,'process',i.actor_id))
 and (i.request_payload->>'restitchEnabled'='false' or i.request_payload#>>'{videoPublication,mode}'='scheduled' or exists(select 1 from private.catalog_video_sets s where s.catalog_intent_id=i.id and s.team_id=i.team_id and s.actor_id=i.actor_id and s.state='ready'))
 order by i.next_attempt_at,i.id limit p_limit
 ) x),'[]'::jsonb);
end;$$;
revoke all on function public.service_list_initial_catalog_recovery(integer) from public,anon,authenticated;
grant execute on function public.service_list_initial_catalog_recovery(integer) to service_role;
create or replace function private.launch_catalog_recovery_due() returns boolean language sql stable security definer set search_path='' as $$
 select jsonb_array_length(public.service_list_launch_catalog_recovery(1))>0 or jsonb_array_length(public.service_list_initial_catalog_recovery(1))>0 or exists(select 1 from private.catalog_video_publication_jobs j join private.catalog_video_publication_policies p on p.catalog_material_id=j.catalog_material_id and p.revision=j.revision where j.state in('waiting','preparing','retry_wait') and j.writer_fence is null and j.dispatched_at is null and not p.legacy_delivery_unverified and p.mode<>'held' and (p.mode='immediate' or p.due_at<=statement_timestamp()) and private.can(j.team_id,'view',j.actor_id) and (private.can(j.team_id,'process',j.actor_id) or exists(select 1 from private.catalog_generation_intents original where original.id=j.command_id and original.team_id=j.team_id and original.actor_id=j.actor_id and original.request_payload->>'catalogVideoProtocolVersion'='1' and original.request_payload->>'restitchEnabled'='false' and private.can(j.team_id,'upload',j.actor_id))) and not exists(select 1 from private.catalog_update_reconciliations where catalog_material_id=j.catalog_material_id))
$$;

create function public.service_capture_initial_catalog_publication_source(p_team uuid,p_actor uuid,p_intent uuid,p_source uuid,p_connection uuid,p_file text,p_expected_version text,p_observed jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;m public.team_materials%rowtype;bytes bigint;observed_version text;observed_checksum text;observed_mime text;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where id=p_intent and team_id=p_team and actor_id=p_actor and video_material_id=p_source and request_payload->>'catalogVideoProtocolVersion'='1' and request_payload->>'restitchEnabled'='false' and state not in('canceled','registered') for update;
 if i.id is null then raise exception 'WRONG_STATE' using errcode='55000';end if;
 select * into m from public.team_materials where id=p_source and team_id=p_team and lifecycle='active' and category='video' for update;
 if m.id is null or m.connection_id is distinct from p_connection or m.drive_file_id is distinct from p_file or m.drive_version is distinct from p_expected_version or not exists(select 1 from public.team_drive_connections where id=p_connection and team_id=p_team and state='connected') then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 observed_version:=p_observed->>'version';observed_checksum:=p_observed->>'checksum';observed_mime:=p_observed->>'mimeType';
 if jsonb_typeof(p_observed) is distinct from 'object' or p_observed->>'fileId' is distinct from p_file or observed_version is null or length(observed_version) not between 1 and 128 or observed_checksum is null or observed_checksum!~*'^([a-f0-9]{32}|[a-f0-9]{64})$' or observed_mime is null or observed_mime!~'^video/' or jsonb_typeof(p_observed->'sizeBytes') is distinct from 'number' or (p_observed->>'sizeBytes')!~'^[0-9]+$' then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 bytes:=(p_observed->>'sizeBytes')::bigint;if bytes<1 or bytes>9007199254740991 then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 update public.team_materials set drive_version=observed_version,checksum=lower(observed_checksum),size_bytes=bytes,mime_type=observed_mime where id=p_source;
 return jsonb_build_object('version',observed_version);
end;$$;
revoke all on function public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_capture_initial_catalog_publication_source(uuid,uuid,uuid,uuid,uuid,text,text,jsonb) to service_role;

-- Original canonical READY recovery needs no new local process or delegation.
create function public.service_read_initial_catalog_ready_binding(p_team uuid,p_actor uuid,p_source uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i private.catalog_generation_intents%rowtype;s private.catalog_video_sets%rowtype;plan jsonb;
begin
 if private.can(p_team,'view',p_actor) is not true or private.can(p_team,'upload',p_actor) is not true or private.can(p_team,'process',p_actor) is not true then raise exception 'PERMISSION_DENIED' using errcode='42501';end if;
 select * into i from private.catalog_generation_intents where team_id=p_team and actor_id=p_actor and video_material_id=p_source and request_key=p_key and request_payload->>'catalogVideoProtocolVersion'='1' and request_payload->>'restitchEnabled'='true' and state<>'canceled';
 if i.id is null then return null;end if;plan:=i.checkpoint->'initialVideoPlan';
 if jsonb_typeof(plan) is distinct from 'object' or jsonb_typeof(plan->'recipeRowIds') is distinct from 'array' or jsonb_typeof(plan->'childRequestIds') is distinct from 'array' then return null;end if;
 select * into s from private.catalog_video_sets where id=(plan->>'setId')::uuid and team_id=p_team and actor_id=p_actor and catalog_intent_id=i.id and state='ready';
 if s.id is null or s.source_material_id<>p_source or s.recipe_revision<>coalesce((plan->>'recipeRevision')::bigint,1) or s.recipe_revision<>1 or s.assignment_seed is distinct from plan->>'assignmentSeed' or s.product_count is distinct from (i.request_payload->>'productCount')::integer or s.requested_count is distinct from (i.request_payload->>'videoVariationCount')::integer or s.settings_snapshot->>'configured' is distinct from 'true' or not(s.settings_snapshot @> coalesce(i.request_payload->'restitchDuration','{}'::jsonb)) then return null;end if;
 if not exists(select 1 from private.catalog_video_recipe_references r where r.video_set_id=s.id and r.team_id=p_team and r.actor_id=p_actor and r.catalog_intent_id=i.id and r.recipe_revision=1) or (select jsonb_agg(v.request_id::text order by v.video_variant_index) from private.catalog_video_variants v where v.video_set_id=s.id) is distinct from plan->'childRequestIds' or jsonb_array_length(plan->'recipeRowIds')<>s.product_count or (select count(distinct value) from jsonb_array_elements_text(plan->'recipeRowIds'))<>s.product_count or (select count(*) from private.catalog_video_assignments where video_set_id=s.id and recipe_revision=1)<>s.product_count or exists(select 1 from jsonb_array_elements_text(plan->'recipeRowIds') expected(row_id) where not exists(select 1 from private.catalog_video_assignments a where a.video_set_id=s.id and a.recipe_revision=1 and a.recipe_row_id::text=expected.row_id)) then return null;end if;
 if not exists(select 1 from public.team_materials m join public.team_drive_connections d on d.id=m.connection_id and d.team_id=m.team_id where m.id=s.source_material_id and m.team_id=p_team and m.lifecycle='active' and d.state='connected' and m.drive_version=s.source_version and m.drive_file_id=s.source_snapshot->>'fileId' and m.connection_id=(s.source_snapshot->>'connectionId')::uuid and m.checksum=s.source_snapshot->>'checksum' and m.size_bytes=(s.source_snapshot->>'sizeBytes')::bigint and m.mime_type=s.source_snapshot->>'mimeType') then return null;end if;
 if (select count(*) from private.catalog_video_variants where video_set_id=s.id)<>s.requested_count or exists(select 1 from private.catalog_video_variants v left join public.team_materials m on m.id=v.output_material_id and m.team_id=p_team left join public.team_drive_connections d on d.id=m.connection_id and d.team_id=p_team left join public.team_operations o on o.id=v.operation_id and o.team_id=p_team where v.video_set_id=s.id and (v.state<>'registered' or m.lifecycle is distinct from 'active' or d.state is distinct from 'connected' or o.state is distinct from 'succeeded' or o.actor_id is distinct from p_actor or o.source_material_id is distinct from s.source_material_id or o.result_material_id is distinct from v.output_material_id or not exists(select 1 from private.team_operation_intents operation_intent where operation_intent.operation_id=o.id and operation_intent.team_id=p_team and operation_intent.tool_id='restitch' and operation_intent.expected_source_version=s.source_version))) then return null;end if;
 return jsonb_build_object('videoSetId',s.id,'catalogIntentId',i.id);
exception when invalid_text_representation or numeric_value_out_of_range then return null;
end;$$;
revoke all on function public.service_read_initial_catalog_ready_binding(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_read_initial_catalog_ready_binding(uuid,uuid,uuid,text) to service_role;
commit;
