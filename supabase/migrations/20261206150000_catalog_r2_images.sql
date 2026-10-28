-- 045. Metadata only. No R2 credentials, provider I/O or production activation.
create table private.catalog_image_config (
  team_id uuid primary key references public.teams(id) on delete cascade,
  mode text not null default 'legacy' check (mode in ('legacy','v2')),
  import_enabled boolean not null default false,
  revision bigint not null default 1,
  max_ready_bytes bigint not null default 50000000000,
  max_entries integer not null default 100000
);
create table public.team_catalog_image_imports (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_scope uuid not null,
  source_kind text not null check (source_kind in ('local','drive')),
  state text not null default 'collecting' check (state in ('collecting','enumerating','sealed','running','completed','partial','failed','cancelled','expired','awaiting_reconciliation')),
  revision bigint not null default 1,
  counts jsonb not null default '{"total":0,"ready":0,"reused":0,"unclassified":0,"failed":0,"expired":0,"cancelled":0}',
  created_at timestamptz not null default now(),
  last_user_activity timestamptz not null default now(),
  source_deadline timestamptz not null default now()+interval '24 hours',
  authorization_epoch bigint not null default 1,
  unique (id,team_id)
);
create table private.catalog_image_import_intents (
  job_id uuid primary key references public.team_catalog_image_imports(id) on delete cascade,
  team_id uuid not null,
  actor_scope uuid not null,
  intent_key text not null,
  request_digest text not null,
  sources jsonb not null default '[]',
  enumeration_cursor jsonb not null default '[]',
  enumeration_complete boolean not null default false,
  enumeration_error_code text,
  has_more_sources boolean not null default false,
  unique (team_id,actor_scope,intent_key)
);
create table private.catalog_image_import_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  team_id uuid not null,
  client_file_key text not null,
  display_name text not null check (length(display_name)<=255),
  source jsonb not null default '{}',
  classification jsonb not null,
  declared_size bigint not null check (declared_size between 1 and 50000000),
  declared_mime text not null,
  state text not null default 'waiting_source' check (state in ('waiting_source','staged','validating','deduplicating','publishing','verifying_origin','verifying_public','committing','ready','reused','failed','cancelled','expired','awaiting_reconciliation')),
  error_code text,
  fence bigint not null default 0,
  lease_owner text,
  lease_until timestamptz,
  attempt_no integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  staging_key text,
  grant_generation integer not null default 0,
  grant_request_key text,
  grant_expires_at timestamptz,
  grant_issued_at timestamptz,
  candidate_publication_id uuid,
  publication_id uuid,
  created_at timestamptz not null default now(),
  foreign key (job_id,team_id) references public.team_catalog_image_imports(id,team_id) on delete cascade,
  unique (job_id,client_file_key),
  unique (id,team_id)
);
create index catalog_image_work on private.catalog_image_import_entries(next_attempt_at,created_at) where state not in ('ready','reused','failed','cancelled','expired');
create table private.catalog_image_grants (
 entry_id uuid not null references private.catalog_image_import_entries(id) on delete cascade,
 generation integer not null, team_id uuid not null, actor_scope uuid not null,
 issued_at timestamptz not null default now(), expires_at timestamptz not null,
 primary key(entry_id,generation)
);
revoke all on private.catalog_image_grants from public,anon,authenticated,service_role;
alter table private.catalog_image_import_intents add column staging_overage boolean not null default false;
create table private.catalog_image_manifest_pages (
  job_id uuid not null references public.team_catalog_image_imports(id) on delete cascade,
  page_key text not null,
  digest text not null,
  primary key(job_id,page_key)
);
create table private.catalog_image_publications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  object_key text not null unique default 'v1/'||gen_random_uuid()::text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check(size_bytes between 1 and 50000000),
  mime text not null check(mime in ('image/png','image/jpeg','image/webp')),
  width integer not null check(width>0),
  height integer not null check(height>0),
  classification jsonb not null,
  state text not null default 'candidate' check(state in ('candidate','put_unknown','origin_verified','public_verified','ready','purging','revoking','revoked','purge_unknown')),
  fence bigint not null default 1,
  owner_entry_id uuid,
  public_url text,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  unique(id,team_id),
  check(width::bigint*height::bigint<=16000000)
);
create unique index catalog_image_dedup on private.catalog_image_publications(team_id,sha256,size_bytes) where state not in ('revoked','purging','revoking','purge_unknown');
create table public.team_catalog_image_pool_entries (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  publication_id uuid not null,
  public_url text not null,
  classification jsonb not null,
  active boolean not null default true,
  revision bigint not null default 1,
  added_at timestamptz not null default now(),
  foreign key(publication_id,team_id) references private.catalog_image_publications(id,team_id) on delete cascade,
  unique(team_id,publication_id)
);
create table private.catalog_image_uses (
  team_id uuid not null references public.teams(id) on delete cascade,
  publication_id uuid not null,
  catalog_attempt_id uuid not null,
  row_identity text not null,
  state text not null default 'reserved' check(state in ('reserved','committed','superseded','unknown')),
  created_at timestamptz not null default now(),
  foreign key(publication_id,team_id) references private.catalog_image_publications(id,team_id) on delete cascade,
  primary key(catalog_attempt_id,row_identity,publication_id)
);
create table private.catalog_image_draws (
  team_id uuid not null references public.teams(id) on delete cascade,
  pool_entry_id uuid not null references public.team_catalog_image_pool_entries(id) on delete cascade,
  primary key(team_id,pool_entry_id)
);
create table private.catalog_image_selections (
  team_id uuid not null references public.teams(id) on delete cascade,
  attempt_id uuid not null,
  scope text not null default 'create',
  images jsonb not null,
  primary key(team_id,attempt_id,scope)
);
-- No cascading FK: cleanup remains possible after team, actor and job deletion.
create table private.catalog_image_purges (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid,
  scope_id uuid not null,
  bucket_kind text not null check(bucket_kind in ('staging','public')),
  object_key text not null,
  reason text not null check(reason in ('expired_staging','orphan_candidate','explicit_revoke','team_deleted')),
  state text not null default 'pending' check(state in ('pending','deleting','cache_purging','complete','unknown')),
  fence bigint not null default 0,
  lease_until timestamptz,
  not_before timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(bucket_kind,object_key)
);
create table private.catalog_image_journal (
  seq bigint generated always as identity primary key,
  team_id uuid,
  job_id uuid,
  entry_id uuid,
  publication_id uuid,
  stage text not null,
  code text,
  occurred_at timestamptz not null default now()
);

alter table public.team_catalog_image_imports enable row level security;
alter table public.team_catalog_image_imports force row level security;
alter table public.team_catalog_image_pool_entries enable row level security;
alter table public.team_catalog_image_pool_entries force row level security;
revoke all on public.team_catalog_image_imports,public.team_catalog_image_pool_entries from public,anon,authenticated;
grant select(id,team_id,source_kind,state,revision,counts,created_at,last_user_activity,source_deadline) on public.team_catalog_image_imports to authenticated;
grant select(id,team_id,publication_id,public_url,classification,active,revision,added_at) on public.team_catalog_image_pool_entries to authenticated;
create policy catalog_image_import_read on public.team_catalog_image_imports for select to authenticated using(private.can(team_id,'view',auth.uid()));
create policy catalog_image_pool_read on public.team_catalog_image_pool_entries for select to authenticated using(private.can(team_id,'view',auth.uid()));
revoke all on private.catalog_image_config,private.catalog_image_import_intents,private.catalog_image_import_entries,private.catalog_image_manifest_pages,private.catalog_image_publications,private.catalog_image_uses,private.catalog_image_draws,private.catalog_image_selections,private.catalog_image_purges,private.catalog_image_journal from public,anon,authenticated,service_role;

create function private.catalog_image_refresh_job(p_job uuid) returns void language plpgsql security definer set search_path='' as $$
declare c jsonb; pending integer; uncertain integer; j public.team_catalog_image_imports%rowtype;
begin
 select * into j from public.team_catalog_image_imports where id=p_job for update;
 if not found then return; end if;
 select jsonb_build_object('total',count(*),'ready',count(*) filter(where state='ready'),'reused',count(*) filter(where state='reused'),'unclassified',count(*) filter(where state in ('ready','reused') and classification->>'mode'='unclassified'),'failed',count(*) filter(where state='failed'),'expired',count(*) filter(where state='expired'),'cancelled',count(*) filter(where state='cancelled')),
 count(*) filter(where state not in ('ready','reused','failed','expired','cancelled','awaiting_reconciliation')),
 count(*) filter(where state='awaiting_reconciliation') into c,pending,uncertain from private.catalog_image_import_entries where job_id=p_job;
 update public.team_catalog_image_imports set counts=c,revision=revision+1,state=case
 when j.state='cancelled' then 'cancelled'
 when j.state='expired' and (c->>'total')::int=0 then 'expired'
 when j.state in ('collecting','enumerating') then j.state
 when pending>0 then 'running'
 when uncertain>0 then 'awaiting_reconciliation'
 when (c->>'ready')::int+(c->>'reused')::int=(c->>'total')::int then case when exists(select 1 from private.catalog_image_import_intents where job_id=p_job and has_more_sources) then 'partial' else 'completed' end
 when (c->>'ready')::int+(c->>'reused')::int>0 then 'partial'
 when (c->>'failed')::int>0 then 'failed'
 when (c->>'expired')::int>0 then 'expired' else 'cancelled' end where id=p_job;
end $$;

create function private.catalog_image_snapshot(p_job uuid,p_cursor text default null,p_limit integer default 100) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('id',j.id,'teamId',j.team_id,'sourceKind',j.source_kind,'state',j.state,'revision',j.revision,'counts',j.counts,'entries',coalesce((select jsonb_agg(x.item order by x.id) from (select e.id,jsonb_build_object('id',e.id,'clientFileKey',case when j.source_kind='local' then e.client_file_key else null end,'displayName',e.display_name,'state',e.state,'classification',e.classification,'errorCode',e.error_code,'declaredSize',e.declared_size,'grantGeneration',e.grant_generation) item from private.catalog_image_import_entries e where e.job_id=j.id and (p_cursor is null or e.id>p_cursor::uuid) order by e.id limit least(greatest(p_limit,1),100)) x),'[]'::jsonb),'hasMore',(select count(*)>least(greatest(p_limit,1),100) from private.catalog_image_import_entries e where e.job_id=j.id and (p_cursor is null or e.id>p_cursor::uuid)),'nextCursor',(select max(x.id::text) from (select id from private.catalog_image_import_entries where job_id=j.id and (p_cursor is null or id>p_cursor::uuid) order by id limit least(greatest(p_limit,1),100)) x),'hasMoreSources',coalesce(i.has_more_sources,false),'errorCode',i.enumeration_error_code) from public.team_catalog_image_imports j join private.catalog_image_import_intents i on i.job_id=j.id where j.id=p_job
$$;

create function public.service_catalog_image_control_v2(p_action text,p_actor uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; jid uuid; eid uuid; j public.team_catalog_image_imports%rowtype; e private.catalog_image_import_entries%rowtype; cfg private.catalog_image_config%rowtype; item jsonb; v_digest text; total bigint; n integer; read_only boolean; cursor_id uuid; cursor_bucket integer; cursor_created timestamptz; result jsonb; now_at timestamptz:=clock_timestamp();
begin
 if jsonb_typeof(p_payload)<>'object' or p_actor is null then raise exception 'INVALID_INPUT'; end if;
 jid:=nullif(p_payload->>'jobId','')::uuid;
 if jid is not null then select * into j from public.team_catalog_image_imports where id=jid for update; if not found then raise exception 'NOT_FOUND'; end if; t:=j.team_id; else t:=(p_payload->>'teamId')::uuid; if t is null and p_action='remove' then select team_id into t from public.team_catalog_image_pool_entries where id=(p_payload->>'entryId')::uuid; elsif t is null and p_action='revoke' then select team_id into t from private.catalog_image_publications where id=(p_payload->>'publicationId')::uuid; end if; end if;
 if t is null then raise exception 'INVALID_INPUT'; end if;
 read_only:=p_action in ('capabilities','get','list','dictionary','inventory');
 if not private.can(t,case when read_only then 'view' else 'manage_metadata' end,p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 insert into private.catalog_image_config(team_id) values(t) on conflict do nothing;
 select * into cfg from private.catalog_image_config where team_id=t for update;
 if p_action='capabilities' then return jsonb_build_object('enabled',cfg.import_enabled,'importEnabled',cfg.import_enabled,'canManage',private.can(t,'manage_metadata',p_actor),'contractVersion',2,'mode',cfg.mode); end if;
 if p_action='list' then
  if nullif(p_payload->>'cursor','') is not null then
   if p_payload->>'cursor' !~ '^[012]:[0-9a-f-]{36}$' then raise exception 'INVALID_INPUT'; end if;
   cursor_bucket:=split_part(p_payload->>'cursor',':',1)::int;
   cursor_id:=split_part(p_payload->>'cursor',':',2)::uuid;
   select created_at into cursor_created from public.team_catalog_image_imports where id=cursor_id and team_id=t;
   if not found then raise exception 'NOT_FOUND'; end if;
  end if;
  select coalesce(jsonb_agg(private.catalog_image_snapshot(x.id)||jsonb_build_object('_listCursor',x.bucket::text||':'||x.id::text) order by x.bucket,x.created_at desc,x.id desc),'[]'::jsonb) into result from (select q.* from (select id,created_at,case when state in ('collecting','enumerating','sealed','running') then 0 when state='awaiting_reconciliation' then 1 else 2 end bucket from public.team_catalog_image_imports where team_id=t) q where cursor_id is null or q.bucket>cursor_bucket or (q.bucket=cursor_bucket and (q.created_at,q.id)<(cursor_created,cursor_id)) order by q.bucket,q.created_at desc,q.id desc limit 21) x;
  return jsonb_build_object('items',(select coalesce(jsonb_agg(value-'_listCursor'),'[]'::jsonb) from jsonb_array_elements(case when jsonb_array_length(result)>20 then result-20 else result end)),'hasMore',jsonb_array_length(result)>20,'nextCursor',case when jsonb_array_length(result)>20 then result->19->>'_listCursor' else null end);
 end if;
 if p_action='get' then return private.catalog_image_snapshot(jid,p_payload->>'cursor',coalesce((p_payload->>'limit')::int,100)); end if;
 if p_action in ('dictionary','inventory') then
  if p_action='inventory' then
   return jsonb_build_object('revision',cfg.revision,'pairs',coalesce((select jsonb_agg(jsonb_build_object('garment',x.garment,'color',x.color,'count',x.n)) from (select a.classification->>'garment' garment,a.classification->>'color' color,count(*) n from public.team_catalog_image_pool_entries a join private.catalog_image_publications p on p.id=a.publication_id where a.team_id=t and a.active and p.state='ready' and a.classification->>'mode'='matched' group by 1,2) x),'[]'::jsonb),'unclassified',(select count(*) from public.team_catalog_image_pool_entries a join private.catalog_image_publications p on p.id=a.publication_id where a.team_id=t and a.active and p.state='ready' and a.classification->>'mode'='unclassified'),'total',(select count(*) from public.team_catalog_image_pool_entries a join private.catalog_image_publications p on p.id=a.publication_id where a.team_id=t and a.active and p.state='ready'));
  end if;
  cursor_id:=nullif(p_payload->>'cursor','')::uuid;
  select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'publicationId',x.publication_id,'publicUrl',x.public_url,'classification',x.classification,'revision',x.revision) order by x.id),'[]'::jsonb) into result from (select a.* from public.team_catalog_image_pool_entries a join private.catalog_image_publications p on p.id=a.publication_id where a.team_id=t and a.active and p.state='ready' and (cursor_id is null or a.id>cursor_id) order by a.id limit 101) x;
  return jsonb_build_object('items',case when jsonb_array_length(result)>100 then result-100 else result end,'total',(select count(*) from public.team_catalog_image_pool_entries a join private.catalog_image_publications p on p.id=a.publication_id where a.team_id=t and a.active and p.state='ready'),'revision',cfg.revision,'hasMore',jsonb_array_length(result)>100,'nextCursor',case when jsonb_array_length(result)>100 then result->99->>'id' else null end);
 end if;
 if p_action='begin' then
  if not cfg.import_enabled then raise exception 'CATALOG_IMAGE_IMPORT_DISABLED'; end if;
  if coalesce(p_payload->>'contractVersion','')<>'2' or p_payload->>'sourceKind' not in ('local','drive') or length(coalesce(p_payload->>'idempotencyKey','')) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
  v_digest:=encode(extensions.digest((p_payload-'idempotencyKey')::text,'sha256'),'hex');
  select i.job_id into jid from private.catalog_image_import_intents i where i.team_id=t and i.actor_scope=p_actor and i.intent_key=p_payload->>'idempotencyKey';
  if found then if not exists(select 1 from private.catalog_image_import_intents i where i.job_id=jid and i.request_digest=v_digest) then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return private.catalog_image_snapshot(jid); end if;
  if (select count(*) from public.team_catalog_image_imports where team_id=t and state in ('collecting','enumerating','sealed','running'))>=2 then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
  insert into public.team_catalog_image_imports(team_id,actor_id,actor_scope,source_kind,state) values(t,p_actor,p_actor,p_payload->>'sourceKind',case when p_payload->>'sourceKind'='drive' then 'enumerating' else 'collecting' end) returning id into jid;
  insert into private.catalog_image_import_intents(job_id,team_id,actor_scope,intent_key,request_digest,sources,enumeration_cursor) values(jid,t,p_actor,p_payload->>'idempotencyKey',v_digest,coalesce(p_payload->'sourceMaterialIds','[]'::jsonb),coalesce(p_payload->'sourceMaterialIds','[]'::jsonb));
  return private.catalog_image_snapshot(jid);
 end if;
 if p_action='continue' then
  if j.state not in ('partial','completed') or not exists(select 1 from private.catalog_image_import_intents where job_id=jid and has_more_sources) then raise exception 'WRONG_STATE'; end if;
  result:=public.service_catalog_image_control_v2('begin',p_actor,jsonb_build_object('teamId',t,'contractVersion',2,'sourceKind','drive','idempotencyKey',p_payload->>'idempotencyKey','sourceMaterialIds',(select sources from private.catalog_image_import_intents where job_id=jid),'continuedFrom',jid));
  update private.catalog_image_import_intents set enumeration_cursor=(select enumeration_cursor from private.catalog_image_import_intents where job_id=jid) where job_id=(result->>'id')::uuid;
  return result;
 end if;
 if p_action in ('remove','revoke') then
  if p_action='remove' then
   update public.team_catalog_image_pool_entries set active=false,revision=revision+1 where id=(p_payload->>'entryId')::uuid and team_id=t and revision=(p_payload->>'revision')::bigint;
   if not found then raise exception 'WRONG_STATE'; end if;
  else
   if p_payload->>'explicitRevocation'<>'true' then raise exception 'INVALID_INPUT'; end if;
   perform 1 from private.catalog_image_publications p where p.id=(p_payload->>'publicationId')::uuid and p.team_id=t and exists(select 1 from public.team_catalog_image_pool_entries e where e.publication_id=p.id and e.revision=(p_payload->>'revision')::bigint) for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   update private.catalog_image_publications set state='revoking',fence=fence+1 where id=(p_payload->>'publicationId')::uuid;
   update public.team_catalog_image_pool_entries set active=false,revision=revision+1 where publication_id=(p_payload->>'publicationId')::uuid;
   insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason) select id,team_id,'public',object_key,'explicit_revoke' from private.catalog_image_publications where id=(p_payload->>'publicationId')::uuid on conflict(bucket_kind,object_key) do nothing;
  end if;
  update private.catalog_image_config set revision=revision+1 where team_id=t;
  return public.service_catalog_image_control_v2('dictionary',p_actor,jsonb_build_object('teamId',t));
 end if;
 if jid is null then raise exception 'INVALID_INPUT'; end if;
 if p_action='cancel' then
  if j.state='cancelled' then return private.catalog_image_snapshot(jid); end if;
  if j.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'WRONG_STATE'; end if;
  update public.team_catalog_image_imports set state='cancelled',authorization_epoch=authorization_epoch+1 where id=jid;
  update private.catalog_image_import_entries set state='cancelled',lease_until=null,fence=fence+1 where job_id=jid and state not in ('ready','reused','awaiting_reconciliation');
  perform private.catalog_image_refresh_job(jid); return private.catalog_image_snapshot(jid);
 end if;
 if not cfg.import_enabled then raise exception 'CATALOG_IMAGE_IMPORT_DISABLED'; end if;
 if (j.source_deadline<=now_at or j.state in ('cancelled','expired','completed')) and p_action<>'retry' then raise exception 'WRONG_STATE'; end if;
 if p_action='manifest' then
  if j.state<>'collecting' or jsonb_typeof(p_payload->'entries')<>'array' or jsonb_array_length(p_payload->'entries') not between 1 and 100 or length(coalesce(p_payload->>'pageKey','')) not between 1 and 200 then raise exception 'INVALID_INPUT'; end if;
  v_digest:=encode(extensions.digest((p_payload->'entries')::text,'sha256'),'hex');
  if exists(select 1 from private.catalog_image_manifest_pages where job_id=jid and page_key=p_payload->>'pageKey') then
   if not exists(select 1 from private.catalog_image_manifest_pages where job_id=jid and page_key=p_payload->>'pageKey' and digest=encode(extensions.digest((p_payload->'entries')::text,'sha256'),'hex')) then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return private.catalog_image_snapshot(jid);
  end if;
  for item in select value from jsonb_array_elements(p_payload->'entries') loop
   if length(coalesce(item->>'clientFileKey','')) not between 1 and 200 or length(coalesce(item->>'name','')) not between 1 and 255 or (item->>'declaredSize')::bigint not between 1 and 50000000 or jsonb_typeof(item->'classification')<>'object' then raise exception 'INVALID_INPUT'; end if;
   if exists(select 1 from private.catalog_image_import_entries where job_id=jid and client_file_key=item->>'clientFileKey') then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   insert into private.catalog_image_import_entries(job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification) values(jid,t,item->>'clientFileKey',item->>'name',(item->>'declaredSize')::bigint,coalesce(item->>'declaredMime','application/octet-stream'),item->'classification');
  end loop;
  select count(*),coalesce(sum(declared_size),0) into n,total from private.catalog_image_import_entries where job_id=jid;
  if n>1000 or total>5000000000 then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
  insert into private.catalog_image_manifest_pages values(jid,p_payload->>'pageKey',v_digest);
  update public.team_catalog_image_imports set last_user_activity=now_at,source_deadline=now_at+interval '24 hours' where id=jid;
  perform private.catalog_image_refresh_job(jid); return private.catalog_image_snapshot(jid);
 elsif p_action='seal' then
  if j.state<>'collecting' or j.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'WRONG_STATE'; end if;
  if (select count(*) from private.catalog_image_import_entries where job_id=jid)<>(p_payload->>'manifestCount')::int then raise exception 'IMAGE_MANIFEST_INCOMPLETE'; end if;
  update public.team_catalog_image_imports set state='sealed',revision=revision+1,last_user_activity=now_at where id=jid;
  update private.catalog_image_import_intents set enumeration_complete=true where job_id=jid;
  return private.catalog_image_snapshot(jid);
 elsif p_action='retry' then
  update private.catalog_image_import_entries set state=case when state='awaiting_reconciliation' then state when source<>'{}'::jsonb then 'staged' else 'waiting_source' end,reconcile_attempts=0,attempt_no=0,error_code=null,next_attempt_at=now_at,fence=fence+1,lease_until=null,staging_key=case when state in ('failed','expired') and source='{}'::jsonb then null else staging_key end,grant_expires_at=case when state in ('failed','expired') and source='{}'::jsonb then null else grant_expires_at end,grant_request_key=case when state in ('failed','expired') and source='{}'::jsonb then null else grant_request_key end where job_id=jid and state in ('failed','expired','awaiting_reconciliation') and (not (p_payload ? 'entryIds') or id::text in (select jsonb_array_elements_text(p_payload->'entryIds')));
  update private.catalog_image_import_intents set enumeration_error_code=null,lease_until=null,fence=fence+1,has_more_sources=case when not enumeration_complete then false else has_more_sources end where job_id=jid;
  update public.team_catalog_image_imports set state=case when source_kind='drive' and exists(select 1 from private.catalog_image_import_intents where job_id=jid and not enumeration_complete) then 'enumerating' else 'sealed' end,last_user_activity=now_at,source_deadline=now_at+interval '24 hours' where id=jid;
  perform private.catalog_image_refresh_job(jid); return private.catalog_image_snapshot(jid);
 elsif p_action in ('grant','delivered') then
  select * into e from private.catalog_image_import_entries where id=(p_payload->>'entryId')::uuid and job_id=jid for update;
  if not found or j.source_kind<>'local' then raise exception 'NOT_FOUND'; end if;
  if p_action='delivered' then
   if e.grant_generation<>(p_payload->>'grantGeneration')::int or e.grant_generation=0 then raise exception 'WRONG_STATE'; end if;
   if e.state='waiting_source' then update private.catalog_image_import_entries set state='staged',next_attempt_at=now_at where id=e.id; end if;
   perform private.catalog_image_refresh_job(jid); return private.catalog_image_snapshot(jid);
  end if;
  if e.state<>'waiting_source' or j.state not in ('sealed','running') then raise exception 'WRONG_STATE'; end if;
  if e.grant_request_key=p_payload->>'requestKey' and e.grant_expires_at>now_at then return jsonb_build_object('key',e.staging_key,'generation',e.grant_generation,'expiresAt',e.grant_expires_at,'mime',e.declared_mime); end if;
  if e.grant_generation<>coalesce((p_payload->>'generation')::int,0) then raise exception 'WRONG_STATE'; end if;
  if exists(select 1 from private.catalog_image_import_intents where job_id=jid and staging_overage) then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
  if (select count(*) from private.catalog_image_import_entries where team_id=t and grant_expires_at>now_at and state not in ('ready','reused','failed','cancelled','expired'))>=8 or (select count(*) from private.catalog_image_grants where team_id=t and issued_at>now_at-interval '1 minute')>=120 or (select count(*) from private.catalog_image_grants where actor_scope=p_actor and issued_at>now_at-interval '1 minute')>=120 then raise exception 'IMAGE_UPLOAD_CAPACITY_BUSY'; end if;
  update private.catalog_image_import_entries set staging_key=gen_random_uuid()::text,grant_generation=grant_generation+1,grant_request_key=p_payload->>'requestKey',grant_issued_at=now_at,grant_expires_at=now_at+interval '5 minutes' where id=e.id returning * into e;
  insert into private.catalog_image_grants(entry_id,generation,team_id,actor_scope,expires_at) values(e.id,e.grant_generation,t,p_actor,e.grant_expires_at);
  insert into private.catalog_image_purges(scope_id,bucket_kind,object_key,reason,not_before) values(t,'staging',e.staging_key,'expired_staging',e.grant_expires_at+interval '5 minutes');
  return jsonb_build_object('key',e.staging_key,'generation',e.grant_generation,'expiresAt',e.grant_expires_at,'mime',e.declared_mime);
 end if;
 raise exception 'INVALID_INPUT';
end $$;

alter table private.catalog_image_import_intents add column lease_owner text,add column lease_until timestamptz,add column fence bigint not null default 0;
alter table private.catalog_image_import_entries add column reconcile_attempts integer not null default 0;

create function public.service_catalog_image_mode_v2(p_team uuid) returns text language sql stable security definer set search_path='' as $$ select coalesce((select mode from private.catalog_image_config where team_id=p_team),'legacy') $$;

create function public.service_catalog_image_claim_v2(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype; j public.team_catalog_image_imports%rowtype; i private.catalog_image_import_intents%rowtype; at timestamptz:=clock_timestamp(); x record;
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-global',0));
 for x in select id from public.team_catalog_image_imports where state in ('collecting','sealed','running') and source_deadline<=at for update skip locked loop
  update private.catalog_image_import_entries set state='expired',error_code='IMAGE_LOCAL_SOURCE_REQUIRED',fence=fence+1,lease_until=null where job_id=x.id and state='waiting_source' and (lease_until is null or lease_until<=clock_timestamp());
  update public.team_catalog_image_imports set state='expired' where id=x.id and state='collecting';
  perform private.catalog_image_refresh_job(x.id);
 end loop;
 if (select count(*) from private.catalog_image_import_entries where lease_until>at)+(select count(*) from private.catalog_image_import_intents where lease_until>at)>=8 then return null; end if;
 select z.* into j from public.team_catalog_image_imports z join private.catalog_image_import_intents y on y.job_id=z.id join private.catalog_image_config c on c.team_id=z.team_id where z.state='enumerating' and c.import_enabled and (y.lease_until is null or y.lease_until<=at) and private.can(z.team_id,'manage_metadata',z.actor_id) order by z.created_at for update of z skip locked limit 1;
 if found then
  update private.catalog_image_import_intents set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1 where job_id=j.id returning * into i;
  return jsonb_build_object('kind','enumerate','jobId',j.id,'teamId',j.team_id,'actorId',j.actor_id,'fence',i.fence,'cursor',i.enumeration_cursor,'sources',i.sources,'admittedCount',(j.counts->>'total')::int,'admittedBytes',(select coalesce(sum(declared_size),0) from private.catalog_image_import_entries where job_id=j.id));
 end if;
 select a.* into e from private.catalog_image_import_entries a join public.team_catalog_image_imports z on z.id=a.job_id join private.catalog_image_config c on c.team_id=a.team_id where c.import_enabled and z.state in ('sealed','running','awaiting_reconciliation') and a.state not in ('ready','reused','failed','expired','cancelled') and (a.state<>'waiting_source' or a.staging_key is not null) and a.next_attempt_at<=at and (a.lease_until is null or a.lease_until<=at) and (select count(*) from private.catalog_image_import_entries q where q.team_id=a.team_id and q.lease_until>at)<2 order by a.next_attempt_at,a.created_at for update of a skip locked limit 1;
 if not found then return null; end if;
 select * into j from public.team_catalog_image_imports where id=e.job_id for update;
 if not private.can(j.team_id,'manage_metadata',j.actor_id) and e.state<>'awaiting_reconciliation' then
  update private.catalog_image_import_entries set state='cancelled',error_code='PERMISSION_DENIED',fence=fence+1,lease_until=null where id=e.id;
  perform private.catalog_image_refresh_job(j.id); return null;
 end if;
 update private.catalog_image_import_entries set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1,attempt_no=attempt_no+case when state in ('waiting_source','awaiting_reconciliation') then 0 else 1 end where id=e.id returning * into e;
 return jsonb_build_object('kind','file','id',e.id,'jobId',j.id,'teamId',j.team_id,'actorId',j.actor_id,'epoch',j.authorization_epoch,'fence',e.fence,'state',e.state,'source',e.source,'stagingKey',e.staging_key,'size',e.declared_size,'mime',e.declared_mime,'classification',e.classification,'candidatePublicationId',e.candidate_publication_id);
end $$;

create function public.service_catalog_image_enumeration_v2(p_job uuid,p_worker text,p_fence bigint,p_entries jsonb,p_cursor jsonb,p_complete boolean,p_more boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare j public.team_catalog_image_imports%rowtype; item jsonb; total bigint; n integer;
begin
 select * into j from public.team_catalog_image_imports where id=p_job for update;
 if j.state<>'enumerating' or not private.can(j.team_id,'manage_metadata',j.actor_id) or not private.can(j.team_id,'download',j.actor_id) or not exists(select 1 from private.catalog_image_import_intents where job_id=p_job and fence=p_fence and lease_owner=p_worker and lease_until>clock_timestamp()) then raise exception 'PERMISSION_DENIED'; end if;
 if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)>100 then raise exception 'INVALID_INPUT'; end if;
 for item in select value from jsonb_array_elements(p_entries) loop
  if (item->>'size')::bigint not between 1 and 50000000 or length(coalesce(item->>'name','')) not between 1 and 255 or jsonb_typeof(item->'classification')<>'object' then raise exception 'INVALID_INPUT'; end if;
  insert into private.catalog_image_import_entries(job_id,team_id,client_file_key,display_name,declared_size,declared_mime,classification,source,state) values(p_job,j.team_id,item->>'fileId',item->>'name',(item->>'size')::bigint,item->>'mime',item->'classification',item->'source','staged') on conflict(job_id,client_file_key) do nothing;
 end loop;
 select count(*),coalesce(sum(declared_size),0) into n,total from private.catalog_image_import_entries where job_id=p_job;
 if n>1000 or total>5000000000 then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
 update private.catalog_image_import_intents set enumeration_cursor=p_cursor,enumeration_complete=p_complete,enumeration_error_code=null,has_more_sources=p_more,lease_until=null where job_id=p_job;
 if p_complete then update public.team_catalog_image_imports set state='sealed',revision=revision+1 where id=p_job; end if;
 perform private.catalog_image_refresh_job(p_job);
end $$;

create function public.service_catalog_image_renew_v2(p_entry uuid,p_worker text,p_fence bigint) returns boolean language plpgsql security definer set search_path='' as $$
declare j public.team_catalog_image_imports%rowtype;
begin
 select z.* into j from public.team_catalog_image_imports z join private.catalog_image_import_entries e on e.job_id=z.id where e.id=p_entry for update of z;
 if not found or j.state in ('cancelled','expired') or not private.can(j.team_id,'manage_metadata',j.actor_id) then return false; end if;
 update private.catalog_image_import_entries set lease_until=clock_timestamp()+interval '90 seconds' where id=p_entry and fence=p_fence and lease_owner=p_worker and lease_until>clock_timestamp() and state not in ('ready','reused','failed','expired','cancelled');
 return found;
end $$;

create function public.service_catalog_image_reserve_v2(p_entry uuid,p_worker text,p_fence bigint,p_image jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype; j public.team_catalog_image_imports%rowtype; p private.catalog_image_publications%rowtype; cfg private.catalog_image_config%rowtype; total bigint; n bigint;
begin
 select z.* into j from public.team_catalog_image_imports z join private.catalog_image_import_entries a on a.job_id=z.id where a.id=p_entry for update of z;
 select * into cfg from private.catalog_image_config where team_id=j.team_id for update;
 select * into e from private.catalog_image_import_entries where id=p_entry for update;
 if e.fence<>p_fence or e.lease_owner<>p_worker or e.lease_until<=clock_timestamp() or j.state in ('cancelled','expired') or not cfg.import_enabled or not private.can(j.team_id,'manage_metadata',j.actor_id) then raise exception 'PERMISSION_DENIED'; end if;
 if p_image->>'sha256' !~ '^[0-9a-f]{64}$' or (p_image->>'size')::bigint<>e.declared_size then raise exception 'IMAGE_CONTENT_INVALID'; end if;
 select * into p from private.catalog_image_publications where team_id=e.team_id and sha256=p_image->>'sha256' and size_bytes=e.declared_size and state not in ('purging','revoking','revoked','purge_unknown') for update;
 if found then
  if p.classification-'reason'<>e.classification-'reason' then raise exception 'IMAGE_CLASSIFICATION_CONFLICT'; end if;
  if p.owner_entry_id<>e.id and p.state<>'ready' and exists(select 1 from private.catalog_image_import_entries where id=p.owner_entry_id and lease_until>clock_timestamp()) then return jsonb_build_object('wait',true); end if;
  if p.state<>'ready' then update private.catalog_image_publications set owner_entry_id=e.id,fence=fence+1 where id=p.id returning * into p; end if;
 else
  select coalesce(sum(size_bytes),0),count(*) into total,n from private.catalog_image_publications where team_id=e.team_id and state<>'revoked';
  if total+e.declared_size>cfg.max_ready_bytes or n>=cfg.max_entries then raise exception 'IMAGE_QUOTA_EXCEEDED'; end if;
  insert into private.catalog_image_publications(team_id,sha256,size_bytes,mime,width,height,classification,owner_entry_id) values(e.team_id,p_image->>'sha256',e.declared_size,p_image->>'mime',(p_image->>'width')::int,(p_image->>'height')::int,e.classification,e.id) returning * into p;
 end if;
 update private.catalog_image_import_entries set candidate_publication_id=p.id,state='publishing' where id=e.id;
 insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,not_before) values(p.id,p.team_id,'public',p.object_key,'orphan_candidate',clock_timestamp()+interval '24 hours') on conflict(bucket_kind,object_key) do nothing;
 return jsonb_build_object('id',p.id,'key',p.object_key,'fence',p.fence,'ready',p.state='ready','sha256',p.sha256,'size',p.size_bytes,'mime',p.mime,'publicUrl',p.public_url);
end $$;

create function public.service_catalog_image_publication_v2(p_entry uuid,p_worker text,p_fence bigint,p_publication uuid,p_publication_fence bigint,p_state text) returns void language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype;
begin
 select * into e from private.catalog_image_import_entries where id=p_entry for update;
 if e.fence<>p_fence or e.lease_owner<>p_worker or e.lease_until<=clock_timestamp() or not exists(select 1 from public.team_catalog_image_imports j where j.id=e.job_id and j.state not in ('cancelled','expired') and private.can(j.team_id,'manage_metadata',j.actor_id)) then raise exception 'PERMISSION_DENIED'; end if;
 if p_state not in ('candidate','put_unknown','origin_verified','public_verified') then raise exception 'INVALID_INPUT'; end if;
 update private.catalog_image_publications set state=p_state where id=p_publication and team_id=e.team_id and fence=p_publication_fence and owner_entry_id=e.id and state not in ('ready','purging','revoking','revoked','purge_unknown');
 if not found then raise exception 'LEASE_MISMATCH'; end if;
end $$;

create function public.service_catalog_image_commit_v2(p_entry uuid,p_worker text,p_fence bigint,p_publication uuid,p_publication_fence bigint,p_url text) returns jsonb language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype; j public.team_catalog_image_imports%rowtype; p private.catalog_image_publications%rowtype; reused boolean;
begin
 select z.* into j from public.team_catalog_image_imports z join private.catalog_image_import_entries a on a.job_id=z.id where a.id=p_entry for update of z;
 perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||j.team_id::text,0));
 perform 1 from private.catalog_image_config where team_id=j.team_id and import_enabled for update;
 if not found then raise exception 'CATALOG_IMAGE_IMPORT_DISABLED'; end if;
 select * into e from private.catalog_image_import_entries where id=p_entry for update;
 select * into p from private.catalog_image_publications where id=p_publication and team_id=e.team_id for update;
 if e.state in ('ready','reused') and e.publication_id=p_publication then return private.catalog_image_snapshot(j.id); end if;
 if e.fence<>p_fence or e.lease_owner<>p_worker or e.lease_until<=clock_timestamp() or j.state in ('cancelled','expired') or not private.can(j.team_id,'manage_metadata',j.actor_id) or p.fence<>p_publication_fence or p.state not in ('public_verified','ready') or e.candidate_publication_id<>p.id then raise exception 'PERMISSION_DENIED'; end if;
 if p_url !~ '^https://[^/?#]+/v1/[0-9a-f-]+$' or right(p_url,length(p.object_key))<>p.object_key then raise exception 'INVALID_INPUT'; end if;
 reused:=p.state='ready';
 update private.catalog_image_publications set state='ready',public_url=p_url,verified_at=clock_timestamp(),owner_entry_id=null where id=p.id;
 insert into public.team_catalog_image_pool_entries(team_id,publication_id,public_url,classification) values(e.team_id,p.id,p_url,p.classification) on conflict(team_id,publication_id) do update set active=true,revision=team_catalog_image_pool_entries.revision+1;
 update private.catalog_image_import_entries set state=case when reused then 'reused' else 'ready' end,publication_id=p.id,error_code=null,lease_until=null where id=e.id;
 update private.catalog_image_config set mode='v2',revision=revision+1 where team_id=e.team_id;
 insert into private.catalog_image_journal(team_id,job_id,entry_id,publication_id,stage) values(e.team_id,j.id,e.id,p.id,case when reused then 'reused' else 'ready' end);
 perform private.catalog_image_refresh_job(j.id); return private.catalog_image_snapshot(j.id);
end $$;

create function public.service_catalog_image_release_v2(p_entry uuid,p_worker text,p_fence bigint,p_code text default null,p_unknown boolean default false,p_wait boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype; state_after text;
begin
 select * into e from private.catalog_image_import_entries where id=p_entry for update;
 if not found or e.fence<>p_fence or e.lease_owner<>p_worker or e.lease_until<=clock_timestamp() or e.state in ('ready','reused','cancelled','expired') then return; end if;
 if p_code='IMAGE_TOO_LARGE' then update private.catalog_image_import_intents set staging_overage=true where job_id=e.job_id; end if;
 if p_unknown and e.candidate_publication_id is not null then update private.catalog_image_publications set uncertain_write=true where id=e.candidate_publication_id; end if;
 if p_wait then state_after:=case when e.candidate_publication_id is null and e.source='{}'::jsonb then 'waiting_source' else 'staged' end;
 elsif p_unknown then state_after:='awaiting_reconciliation';
 elsif e.attempt_no<3 and p_code in ('IMAGE_PROVIDER_UNAVAILABLE','IMAGE_PROVIDER_RATE_LIMITED','IMAGE_SOURCE_UNAVAILABLE') then state_after:='staged'; else state_after:='failed'; end if;
 update private.catalog_image_import_entries set state=state_after,error_code=p_code,lease_until=null,reconcile_attempts=reconcile_attempts+case when p_unknown then 1 else 0 end,next_attempt_at=case when p_unknown and reconcile_attempts>=7 then 'infinity'::timestamptz when p_unknown then clock_timestamp()+interval '15 minutes' when p_wait then clock_timestamp()+interval '15 seconds' when e.attempt_no<2 then clock_timestamp()+interval '1 minute' else clock_timestamp()+interval '5 minutes' end where id=e.id;
 insert into private.catalog_image_journal(team_id,job_id,entry_id,publication_id,stage,code) values(e.team_id,e.job_id,e.id,e.candidate_publication_id,state_after,p_code);
 perform private.catalog_image_refresh_job(e.job_id);
end $$;

create function public.service_catalog_image_candidate_v2(p_entry uuid,p_worker text,p_fence bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare e private.catalog_image_import_entries%rowtype; p private.catalog_image_publications%rowtype;
begin
 select * into e from private.catalog_image_import_entries where id=p_entry and fence=p_fence and lease_owner=p_worker and lease_until>clock_timestamp();
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 select * into p from private.catalog_image_publications where id=e.candidate_publication_id and team_id=e.team_id and state not in ('purging','revoking','revoked','purge_unknown') for update;
 if not found then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
 update private.catalog_image_publications set owner_entry_id=e.id,fence=fence+1 where id=p.id and state<>'ready' returning * into p;
 if not found then select * into p from private.catalog_image_publications where id=e.candidate_publication_id; end if;
 insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,not_before) values(p.id,p.team_id,'public',p.object_key,'orphan_candidate',clock_timestamp()+interval '24 hours') on conflict(bucket_kind,object_key) do nothing;
 return jsonb_build_object('id',p.id,'key',p.object_key,'fence',p.fence,'ready',p.state='ready','sha256',p.sha256,'size',p.size_bytes,'mime',p.mime,'publicUrl',p.public_url);
end $$;

alter table private.catalog_image_publications add column uncertain_write boolean not null default false;
alter table private.catalog_image_purges add column uncertain_write boolean not null default false;

create function public.service_draw_product_catalog_images_v2(p_team uuid,p_count integer,p_attempt uuid default null,p_scope text default 'create') returns jsonb language plpgsql security definer set search_path='' as $$
declare images jsonb:='[]'; item jsonb; a record; chosen uuid; index_no integer;
begin
 if p_count not between 1 and 400 or p_scope not in ('create','growth','refresh') then raise exception 'INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 if public.service_catalog_image_mode_v2(p_team)<>'v2' then return null; end if;
 if p_attempt is not null then
  select s.images into images from private.catalog_image_selections s where s.team_id=p_team and s.attempt_id=p_attempt and s.scope=p_scope;
  if found then
   if exists(select 1 from jsonb_array_elements(images) x left join private.catalog_image_publications p on p.id=(x->>'publicationId')::uuid and p.team_id=p_team where p.state is distinct from 'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
   return images;
  end if;
 end if;
 images:='[]';
 if not exists(select 1 from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.team_id=p_team and e.active and p.state='ready') then return images; end if;
 for index_no in 1..p_count loop
  select e.id into chosen from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.team_id=p_team and e.active and p.state='ready' and not exists(select 1 from private.catalog_image_draws d where d.team_id=p_team and d.pool_entry_id=e.id) order by random() limit 1;
  if chosen is null then
   delete from private.catalog_image_draws where team_id=p_team;
   select e.id into chosen from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.team_id=p_team and e.active and p.state='ready' order by random() limit 1;
  end if;
  select e.*,p.fence as publication_fence into a from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.id=chosen and p.state='ready' for update of p;
  if not found then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
  insert into private.catalog_image_draws values(p_team,chosen) on conflict do nothing;
  item:=jsonb_build_object('kind','r2','publicationId',a.publication_id,'poolEntryId',a.id,'publicUrl',a.public_url,'classification',a.classification,'revision',a.revision);
  images:=images||jsonb_build_array(item);
  if p_attempt is not null then insert into private.catalog_image_uses(team_id,publication_id,catalog_attempt_id,row_identity) values(p_team,a.publication_id,p_attempt,p_scope||':'||index_no::text) on conflict do nothing; end if;
 end loop;
 if p_attempt is not null then insert into private.catalog_image_selections values(p_team,p_attempt,p_scope,images); end if;
 return images;
end $$;

create function public.service_catalog_image_finalize_uses_v2(p_team uuid,p_attempt uuid,p_delivered boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 perform 1 from private.catalog_image_publications p join private.catalog_image_uses u on u.publication_id=p.id where u.team_id=p_team and u.catalog_attempt_id=p_attempt order by p.id for update of p;
 if p_delivered and exists(select 1 from private.catalog_image_uses u join private.catalog_image_publications p on p.id=u.publication_id where u.team_id=p_team and u.catalog_attempt_id=p_attempt and p.state<>'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
 update private.catalog_image_uses set state=case when p_delivered then 'committed' else 'unknown' end where team_id=p_team and catalog_attempt_id=p_attempt and state<>'committed';
end $$;

create function public.service_catalog_image_admit_v2(p_team uuid,p_expected_revision bigint) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog_image_mode:'||p_team::text,0));
 update private.catalog_image_config c set mode='v2',revision=revision+1 where c.team_id=p_team and c.revision=p_expected_revision and c.import_enabled and exists(select 1 from public.team_catalog_image_pool_entries e join private.catalog_image_publications p on p.id=e.publication_id where e.team_id=p_team and e.active and p.state='ready');
 return found;
end $$;

create function public.service_catalog_image_purge_claim_v2() returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.catalog_image_purges%rowtype; p private.catalog_image_publications%rowtype;
begin
 select * into q from private.catalog_image_purges where state in ('pending','unknown','deleting','cache_purging') and attempts<8 and not_before<=clock_timestamp() and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 if q.bucket_kind='staging' and exists(select 1 from private.catalog_image_import_entries where staging_key=q.object_key and lease_until>clock_timestamp()) then return null; end if;
 if q.publication_id is not null then
  select * into p from private.catalog_image_publications where id=q.publication_id for update;
  if found and q.reason='orphan_candidate' then
   if p.state='ready' then update private.catalog_image_purges set state='complete' where id=q.id; return null; end if;
   if p.state='put_unknown' or p.uncertain_write or exists(select 1 from private.catalog_image_import_entries e where e.candidate_publication_id=p.id and (e.lease_until>clock_timestamp() or e.state not in ('failed','expired','cancelled'))) or exists(select 1 from private.catalog_image_uses where publication_id=p.id) or exists(select 1 from public.team_catalog_image_pool_entries where publication_id=p.id) then return null; end if;
   update private.catalog_image_publications set state='purging',fence=fence+1 where id=p.id;
  end if;
  q.uncertain_write:=q.uncertain_write or coalesce(p.uncertain_write,false) or coalesce(p.state='put_unknown',false);
 end if;
 update private.catalog_image_purges set state='deleting',fence=fence+1,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1,uncertain_write=q.uncertain_write where id=q.id returning * into q;
 return jsonb_build_object('id',q.id,'key',q.object_key,'kind',q.bucket_kind,'fence',q.fence,'uncertain',q.uncertain_write);
end $$;

create function public.service_catalog_image_purge_finish_v2(p_id uuid,p_fence bigint,p_success boolean) returns void language plpgsql security definer set search_path='' as $$
declare q private.catalog_image_purges%rowtype;
begin
 select * into q from private.catalog_image_purges where id=p_id and fence=p_fence and lease_until>clock_timestamp() for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 update private.catalog_image_purges set state=case when p_success and not uncertain_write then 'complete' else 'unknown' end,lease_until=null,next_attempt_at=clock_timestamp()+interval '15 minutes' where id=p_id;
 if p_success and not q.uncertain_write then update private.catalog_image_publications set state='revoked',fence=fence+1 where id=q.publication_id and state in ('purging','revoking','purge_unknown'); end if;
end $$;

create function private.catalog_image_before_team_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into private.catalog_image_purges(publication_id,scope_id,bucket_kind,object_key,reason,uncertain_write,not_before) select id,old.id,'public',object_key,'team_deleted',uncertain_write or state='put_unknown',clock_timestamp()+interval '2 minutes' from private.catalog_image_publications where team_id=old.id on conflict(bucket_kind,object_key) do update set reason='team_deleted',uncertain_write=catalog_image_purges.uncertain_write or excluded.uncertain_write;
 insert into private.catalog_image_purges(scope_id,bucket_kind,object_key,reason,not_before) select old.id,'staging',staging_key,'expired_staging',greatest(coalesce(grant_expires_at,clock_timestamp()),clock_timestamp())+interval '5 minutes' from private.catalog_image_import_entries where team_id=old.id and staging_key is not null on conflict(bucket_kind,object_key) do nothing;
 return old;
end $$;
create trigger catalog_images_before_team_delete before delete on public.teams for each row execute function private.catalog_image_before_team_delete();

create function private.catalog_image_membership_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare t uuid; u uuid; x record;
begin
 t:=old.team_id; u:=old.user_id;
 update public.team_catalog_image_imports set authorization_epoch=authorization_epoch+1,revision=revision+1 where team_id=t and actor_id=u and state in ('collecting','enumerating','sealed','running','awaiting_reconciliation');
 update private.catalog_image_import_entries e set fence=fence+1,lease_until=null,state=case when candidate_publication_id is not null then 'awaiting_reconciliation' when not private.can(t,'manage_metadata',u) then 'cancelled' when state='waiting_source' then 'waiting_source' else 'staged' end where team_id=t and state not in ('ready','reused','failed','cancelled','expired') and exists(select 1 from public.team_catalog_image_imports j where j.id=e.job_id and j.actor_id=u);
 for x in select id from public.team_catalog_image_imports where team_id=t and actor_id=u and state in ('collecting','enumerating','sealed','running','awaiting_reconciliation') loop
  if not private.can(t,'manage_metadata',u) then
   update private.catalog_image_import_intents set fence=fence+1,lease_until=null where job_id=x.id;
   update public.team_catalog_image_imports set state=case when exists(select 1 from private.catalog_image_import_entries where job_id=x.id and state='awaiting_reconciliation') then 'awaiting_reconciliation' else 'cancelled' end where id=x.id;
  end if;
  perform private.catalog_image_refresh_job(x.id);
 end loop;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
create trigger catalog_images_membership_epoch after update of base_role,permission_overrides,status or delete on public.team_members for each row execute function private.catalog_image_membership_changed();


create function public.service_catalog_image_validate_uses_v2(p_team uuid,p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 perform 1 from private.catalog_image_publications p join private.catalog_image_uses u on u.publication_id=p.id where u.team_id=p_team and u.catalog_attempt_id=p_attempt order by p.id for update of p;
 if exists(select 1 from private.catalog_image_uses u join private.catalog_image_publications p on p.id=u.publication_id where u.team_id=p_team and u.catalog_attempt_id=p_attempt and p.state<>'ready') then raise exception 'IMAGE_PUBLICATION_REVOKED'; end if;
end $$;
-- Validate every outgoing R2 row, including images retained from earlier attempts.
-- Historical pool removal is not publication revocation; pool revision/active are intentionally ignored.
create function public.service_catalog_image_validate_rows_v2(p_team uuid,p_images jsonb) returns void language plpgsql security definer set search_path='' as $$
declare image jsonb;
begin
 if p_team is null or jsonb_typeof(p_images) is distinct from 'array' then raise exception 'INVALID_RESPONSE'; end if;
 if jsonb_array_length(p_images)>400 then raise exception 'INVALID_RESPONSE'; end if;
 for image in select value from jsonb_array_elements(p_images) loop
  if jsonb_typeof(image) is distinct from 'object' or image->>'kind' is distinct from 'r2'
   or jsonb_typeof(image->'publicationId') is distinct from 'string'
   or jsonb_typeof(image->'poolEntryId') is distinct from 'string'
   or coalesce(image->>'publicationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or coalesce(image->>'poolEntryId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or jsonb_typeof(image->'publicUrl') is distinct from 'string'
   or jsonb_typeof(image->'classification') is distinct from 'object'
   or jsonb_typeof(image->'revision') is distinct from 'number' then raise exception 'INVALID_RESPONSE'; end if;
  -- Match the shared safe-integer shape without narrowing through bigint/integer casts.
  if (image->>'revision')::numeric<0 or (image->>'revision')::numeric>9007199254740991
   or (image->>'revision')::numeric<>trunc((image->>'revision')::numeric) then raise exception 'INVALID_RESPONSE'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-draw:'||p_team::text,0));
 perform 1 from private.catalog_image_publications p
  where p.team_id=p_team and p.id in (select (value->>'publicationId')::uuid from jsonb_array_elements(p_images))
  order by p.id for update of p;
 if exists(select 1 from jsonb_array_elements(p_images) x
  left join private.catalog_image_publications p on p.id=(x->>'publicationId')::uuid and p.team_id=p_team
  left join public.team_catalog_image_pool_entries e on e.id=(x->>'poolEntryId')::uuid and e.team_id=p_team and e.publication_id=p.id
  where p.state is distinct from 'ready' or e.id is null
   or p.public_url is distinct from x->>'publicUrl' or e.public_url is distinct from x->>'publicUrl'
   or p.classification is distinct from x->'classification' or e.classification is distinct from x->'classification') then
  raise exception 'IMAGE_PUBLICATION_REVOKED';
 end if;
end $$;

create function public.service_catalog_image_expire_v2() returns void language plpgsql security definer set search_path='' as $$
declare x record;
begin
 for x in select id from public.team_catalog_image_imports where state in ('collecting','sealed','running') and source_deadline<=clock_timestamp() for update skip locked loop
  update private.catalog_image_import_entries set state='expired',error_code='IMAGE_LOCAL_SOURCE_REQUIRED',fence=fence+1,lease_until=null where job_id=x.id and state='waiting_source' and (lease_until is null or lease_until<=clock_timestamp());
  update public.team_catalog_image_imports set state='expired' where id=x.id and state='collecting';
  perform private.catalog_image_refresh_job(x.id);
 end loop;
end $$;

create function private.invoke_catalog_images_worker() returns bigint language plpgsql security definer set search_path='' as $$
declare endpoint text; secret text; rid bigint;
begin
 perform public.service_catalog_image_expire_v2();
 if not exists(select 1 from private.catalog_image_config where import_enabled) and not exists(select 1 from private.catalog_image_purges where state<>'complete' and attempts<8) then return null; end if;
 if not exists(select 1 from public.team_catalog_image_imports j join private.catalog_image_import_intents i on i.job_id=j.id where j.state='enumerating' and (i.lease_until is null or i.lease_until<=clock_timestamp())) and not exists(select 1 from private.catalog_image_import_entries e join public.team_catalog_image_imports j on j.id=e.job_id where j.state in ('sealed','running','awaiting_reconciliation') and e.state not in ('ready','reused','failed','expired','cancelled') and (e.state<>'waiting_source' or e.staging_key is not null) and e.next_attempt_at<=clock_timestamp() and (e.lease_until is null or e.lease_until<=clock_timestamp())) and not exists(select 1 from private.catalog_image_purges where state<>'complete' and attempts<8 and next_attempt_at<=clock_timestamp()) then return null; end if;
 select regexp_replace(decrypted_secret,'/catalog-sync/?$','/catalog-images/worker') into endpoint from vault.decrypted_secrets where name='wishly_catalog_sync_url' order by created_at desc limit 1;
 select decrypted_secret into secret from vault.decrypted_secrets where name='wishly_catalog_sync_secret' order by created_at desc limit 1;
 if endpoint is null or secret is null or length(secret)<32 or endpoint !~ '^https?://[^/]+/functions/v1/catalog-images/worker$' then return null; end if;
 select net.http_post(url:=endpoint,headers:=jsonb_build_object('content-type','application/json','x-catalog-sync-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=65000) into rid;
 return rid;
end $$;
select cron.schedule('soty-catalog-images','30 seconds',$cron$select private.invoke_catalog_images_worker()$cron$);


create function public.service_catalog_image_progress_v2(p_entry uuid,p_worker text,p_fence bigint,p_stage text) returns void language plpgsql security definer set search_path='' as $$
declare job uuid;
begin
 if p_stage not in ('validating','deduplicating','publishing','verifying_origin','verifying_public','committing') then raise exception 'INVALID_INPUT'; end if;
 if not public.service_catalog_image_renew_v2(p_entry,p_worker,p_fence) then raise exception 'LEASE_MISMATCH'; end if;
 update private.catalog_image_import_entries set state=p_stage where id=p_entry and fence=p_fence returning job_id into job;
 perform private.catalog_image_refresh_job(job);
end $$;

create function public.service_catalog_image_update_attempt_v2(p_catalog uuid,p_worker text) returns uuid language sql stable security definer set search_path='' as $$
 select a.attempt_id from public.team_catalog_update_attempts a join public.team_catalog_updater_items i on i.catalog_material_id=a.catalog_material_id and i.round_due_at=a.round_due_at where i.catalog_material_id=p_catalog and i.lease_owner=p_worker and i.lease_expires_at>clock_timestamp() and a.result='running'
$$;

create function public.service_catalog_image_enumeration_error_v2(p_job uuid,p_worker text,p_fence bigint,p_code text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,95}$' then raise exception 'INVALID_INPUT'; end if;
 if not exists(select 1 from private.catalog_image_import_intents where job_id=p_job and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp()) then raise exception 'LEASE_MISMATCH'; end if;
 update private.catalog_image_import_intents set lease_until=null,has_more_sources=true,enumeration_error_code=p_code where job_id=p_job;
 update public.team_catalog_image_imports set state=case when exists(select 1 from private.catalog_image_import_entries where job_id=p_job) then 'sealed' else 'failed' end,revision=revision+1 where id=p_job;
 insert into private.catalog_image_journal(team_id,job_id,stage,code) select team_id,id,'failed',p_code from public.team_catalog_image_imports where id=p_job;
end $$;


create function public.service_catalog_image_kick_v2() returns void language plpgsql security definer set search_path='' as $$
begin perform private.invoke_catalog_images_worker(); end $$;


-- Control idempotency includes grants/cancel/retry/remove/revoke; no client can
-- reset bounded attempt counters by replaying the same request.
create table private.catalog_image_control_requests (
 actor_scope uuid not null, scope_id text not null, action text not null,
 request_key text not null, digest text not null, response jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor_scope,scope_id,action,request_key)
);
revoke all on private.catalog_image_control_requests from public,anon,authenticated,service_role;
alter function public.service_catalog_image_control_v2(text,uuid,jsonb) set schema private;
alter function private.service_catalog_image_control_v2(text,uuid,jsonb) rename to catalog_image_control_impl_v2;
create function public.service_catalog_image_control_v2(p_action text,p_actor uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; scope text; d text; old_request private.catalog_image_control_requests%rowtype; result jsonb;
begin
 if p_action in ('capabilities','get','list','dictionary','inventory','begin','manifest','grant','delivered') then return private.catalog_image_control_impl_v2(p_action,p_actor,p_payload); end if;
 k:=coalesce(p_payload->>'idempotencyKey',p_payload->>'requestKey',encode(extensions.digest(p_payload::text,'sha256'),'hex'));
 scope:=coalesce(p_payload->>'jobId',p_payload->>'entryId',p_payload->>'publicationId',p_payload->>'teamId');
 if scope is null or length(k) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 d:=encode(extensions.digest((p_payload-'idempotencyKey'-'requestKey')::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('catalog-images-control:'||p_actor::text||scope||p_action||k,0));
 select * into old_request from private.catalog_image_control_requests where actor_scope=p_actor and scope_id=scope and action=p_action and request_key=k;
 if found then
  if old_request.digest<>d then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  -- Never replay a response to an actor who no longer belongs to its team.
  if not private.can((old_request.response->>'teamId')::uuid,'manage_metadata',p_actor) and not exists(select 1 from public.team_catalog_image_pool_entries e where e.team_id=(p_payload->>'teamId')::uuid and private.can(e.team_id,'manage_metadata',p_actor)) then
   -- Dictionary mutations may omit teamId; resolve the existing resource.
   if not exists(select 1 from public.team_catalog_image_pool_entries e where e.id::text=scope and private.can(e.team_id,'manage_metadata',p_actor)) and not exists(select 1 from private.catalog_image_publications q where q.id::text=scope and private.can(q.team_id,'manage_metadata',p_actor)) then raise exception 'PERMISSION_DENIED'; end if;
  end if;
  return old_request.response;
 end if;
 result:=private.catalog_image_control_impl_v2(p_action,p_actor,p_payload);
 insert into private.catalog_image_control_requests values(p_actor,scope,p_action,k,d,result,now());
 return result;
end $$;

do $$ declare f record; begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and (p.proname like 'service_catalog_image_%' or p.proname='service_draw_product_catalog_images_v2')) or (n.nspname='private' and p.proname like '%catalog_image%') loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',f.nspname,f.proname,f.args);
  if f.nspname='public' then execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.args); end if;
 end loop;
end $$;

do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  alter publication supabase_realtime add table public.team_catalog_image_imports;
 end if;
end $$;

-- New metadata can refer to source materials in JSON/UUID fields; preserve the
-- platform's late-reference exclusion fence instead of exempting new tables.
do $$ declare t record; begin
 for t in select * from private.task_cleanup_reference_tables() where table_name like '%catalog_image%' loop
  if not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and g.tgname='task_cleanup_reference_fence') then
   execute format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
  end if;
 end loop;
end $$;

-- Defense in depth: private metadata also obeys the platform RLS contract.
-- Only owner-run security-definer functions/views may cross this boundary.
alter table private.catalog_image_config enable row level security;
alter table private.catalog_image_import_intents enable row level security;
alter table private.catalog_image_import_entries enable row level security;
alter table private.catalog_image_grants enable row level security;
alter table private.catalog_image_manifest_pages enable row level security;
alter table private.catalog_image_publications enable row level security;
alter table private.catalog_image_uses enable row level security;
alter table private.catalog_image_draws enable row level security;
alter table private.catalog_image_selections enable row level security;
alter table private.catalog_image_purges enable row level security;
alter table private.catalog_image_journal enable row level security;
alter table private.catalog_image_control_requests enable row level security;
revoke all on private.catalog_image_config,private.catalog_image_import_intents,private.catalog_image_import_entries,private.catalog_image_grants,private.catalog_image_manifest_pages,private.catalog_image_publications,private.catalog_image_uses,private.catalog_image_draws,private.catalog_image_selections,private.catalog_image_purges,private.catalog_image_journal,private.catalog_image_control_requests from public,anon,authenticated,service_role;
