create function private.catalog_global_classification_valid(value jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(value)='object' and value->>'vocabularyVersion'='catalog-clothing-v1' and
  ((value->>'mode'='matched' and value->>'garment'=any(array['T-Shirt','Tank Top','Polo Shirt','Oxford Shirt','Blouse','Hoodie','Sweatshirt','Cardigan','Sweater','Turtleneck','Crop Top','Midi Dress','Maxi Dress','Wrap Dress','Slip Dress','Shirt Dress','Jumpsuit','Pleated Skirt','Mini Skirt','Chinos','Cargo Pants','Wide Leg Jeans','Slim Jeans','Joggers','Shorts','Leggings','Bomber Jacket','Denim Jacket','Puffer Jacket','Trench Coat','Blazer','Overshirt']) and value->>'color'=any(array['black','white','ivory','navy','olive','sage','terracotta','burgundy','charcoal','sand','camel','dusty rose','sky blue','forest green','mustard','lavender','cream','chocolate','stone grey','coral','denim blue','mint','rust','plum']))
   or (value->>'mode'='unclassified' and value->'garment'='null'::jsonb and value->'color'='null'::jsonb and value->>'reason' in('missing','unknown','ambiguous'))),false)
$$;
revoke all on function private.catalog_global_classification_valid(jsonb) from public,anon,authenticated,service_role;
-- 052. Inactive by default. Global media metadata is independent of tenant ownership.
-- Applying this migration does not activate T0, publish bytes, or delete old objects.
create table private.catalog_global_policy (
  singleton boolean primary key default true check(singleton),
  environment text check(environment in ('dev','beta','production')),
  epoch bigint not null default 0 check(epoch>=0),
  state text not null default 'prepared' check(state in ('prepared','draining','active','cleanup_due','cleanup_running','cleanup_complete')),
  media_origin text check(media_origin ~ '^https://[^/?#@]+$'),
  routing_revision text not null default 'unconfigured' check(length(routing_revision) between 1 and 100),
  accepted_key_versions integer[] not null default array[1],
  serving_verified_at timestamptz,
  serving_revision text,
  activated_at timestamptz,
  delete_after timestamptz,
  source_sha text,
  manifest_digest text,
  release_evidence jsonb not null default '{}',
  check((activated_at is null and delete_after is null) or delete_after=activated_at+interval '720 hours')
);
insert into private.catalog_global_policy(singleton) values(true);

create table private.catalog_global_operators (
  actor_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);
create table private.catalog_global_images (
  id uuid primary key default gen_random_uuid(),
  environment text not null check(environment in ('dev','beta','production')),
  canonical_key text not null unique check(canonical_key='g1/'||id::text),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  mime text not null check(mime in ('image/jpeg','image/png')),
  size_bytes bigint not null check(size_bytes between 1 and 8000000),
  width integer not null check(width between 500 and 16000),
  height integer not null check(height between 500 and 16000),
  classification jsonb not null check(private.catalog_global_classification_valid(classification)),
  garment text generated always as (classification->>'garment') stored,
  color text generated always as (classification->>'color') stored,
  state text not null default 'candidate' check(state in ('candidate','publishing','verifying','ready','failed','unknown')),
  active boolean not null default true,
  content_proof_revision text,
  content_verified_at timestamptz,
  content_expires_at timestamptz,
  next_probe_at timestamptz not null default now(),
  issued_seq bigint not null default 0 check(issued_seq>=0),
  confirmed_uses bigint not null default 0 check(confirmed_uses>=0 and confirmed_uses<=issued_seq),
  created_at timestamptz not null default now(),
  last_confirmed_at timestamptz,
  unique(environment,sha256),
  check(width::bigint*height::bigint<=16000000)
);
create index catalog_global_ready_buckets on private.catalog_global_images(garment,color,id)
  where state='ready' and active;
create table private.catalog_global_aliases (
  id uuid primary key default gen_random_uuid(),
  image_id uuid not null references private.catalog_global_images(id),
  generation bigint not null check(generation between 1 and 9007199254740991),
  public_url text not null unique check(length(public_url)<=2048 and length(split_part(public_url,'/',5)) between 5 and 516 and public_url ~ '^https://[^/?#@]+/g/[A-Za-z0-9_-]+\.(jpg|png)$'),
  key_version integer not null check(key_version between 1 and 65535),
  state text not null default 'planned' check(state in ('planned','verifying','ready','failed','unknown')),
  identity_revision text,
  identity_verified_at timestamptz,
  confirmed_uses integer not null default 0 check(confirmed_uses between 0 and 200),
  unique(image_id,generation),
  unique(id,image_id)
);
create table private.catalog_global_identities (
  id uuid primary key,
  team_id uuid references public.teams(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  creation_intent uuid not null unique,
  material_id uuid unique,
  closed boolean not null default false,
  created_at timestamptz not null default now()
);
create table private.catalog_global_assignments (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references private.catalog_global_identities(id),
  image_id uuid not null references private.catalog_global_images(id),
  alias_id uuid not null,
  issued_slot bigint not null check(issued_slot>0),
  generation bigint not null check(generation=((issued_slot-1)/200)+1),
  state text not null default 'issued' check(state in ('issued','pending_write','confirmed','failed','cancelled','unknown')),
  issued_at timestamptz not null default now(),
  committed_at timestamptz,
  unique(catalog_id,image_id),
  unique(image_id,issued_slot),
  foreign key(alias_id,image_id) references private.catalog_global_aliases(id,image_id)
);
create table private.catalog_global_recipes (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references private.catalog_global_identities(id),
  intent_id uuid not null,
  scope text not null check(scope in ('create','refresh','growth')),
  epoch bigint not null,
  images jsonb not null check(jsonb_typeof(images)='array' and jsonb_array_length(images) between 1 and 400),
  requested_count integer not null check(requested_count between 1 and 400),
  state text not null default 'issued' check(state in ('issued','confirmed','failed','cancelled','unknown')),
  completion_ref uuid,
  created_at timestamptz not null default now(),
  unique(intent_id,scope)
);
create table private.catalog_global_use_receipts (
  assignment_id uuid primary key references private.catalog_global_assignments(id),
  recipe_id uuid not null references private.catalog_global_recipes(id),
  completion_ref uuid not null,
  occurred_at timestamptz not null default now()
);
create table private.catalog_global_jobs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  intent_key text not null check(length(intent_key) between 8 and 200),
  kind text not null check(kind in ('import','alias_prepare','probe')),
  state text not null default 'collecting' check(state in ('collecting','sealed','running','completed','partial','failed','cancelled','unknown')),
  total_files integer not null default 0 check(total_files between 0 and 1000),
  total_bytes bigint not null default 0 check(total_bytes between 0 and 5000000000),
  lease_owner text,
  lease_until timestamptz,
  fence bigint not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  code text,
  created_at timestamptz not null default now(),
  unique(actor_id,intent_key,kind)
);
create table private.catalog_global_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references private.catalog_global_jobs(id),
  file_key text not null check(length(file_key) between 1 and 200),
  display_name text not null check(length(display_name)<=255),
  declared_size bigint not null check(declared_size between 1 and 50000000),
  declared_mime text not null check(declared_mime in ('image/jpeg','image/png','image/webp')),
  classification jsonb not null check(private.catalog_global_classification_valid(classification)),
  state text not null default 'waiting_source' check(state in ('waiting_source','staged','validating','publishing','verifying','ready','reused','failed','cancelled','unknown')),
  staging_key text,
  grant_generation integer not null default 0,
  grant_expires_at timestamptz,
  source_deadline timestamptz not null default now()+interval '24 hours',
  image_id uuid references private.catalog_global_images(id),
  lease_owner text,
  lease_until timestamptz,
  fence bigint not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  code text,
  unique(job_id,file_key)
);
create index catalog_global_entry_work on private.catalog_global_entries(next_attempt_at,id)
  where state not in ('ready','reused','failed','cancelled');
create table private.catalog_global_journal (
  seq bigint generated always as identity primary key,
  flow_id uuid,
  attempt_id uuid,
  team_id uuid,
  actor_id uuid references auth.users(id) on delete set null,
  catalog_id uuid,
  image_id uuid,
  alias_id uuid,
  stage text not null check(length(stage) between 1 and 64),
  code text references public.team_error_codes(code),
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  counts jsonb not null default '{}' check(jsonb_typeof(counts)='object' and octet_length(counts::text)<=2048)
);
create index catalog_global_journal_flow on private.catalog_global_journal(flow_id,seq);
create table private.catalog_image_retirements (
  id uuid primary key default gen_random_uuid(),
  epoch bigint not null,
  kind text not null check(kind in ('object_purge','metadata_unlink')),
  publication_id uuid,
  team_scope uuid,
  object_key text,
  bucket_kind text check(bucket_kind='public'),
  metadata_kind text,
  ledger_id uuid,
  original_owner_scope uuid,
  delete_after timestamptz,
  state text not null default 'retained' check(state in ('retained','due','claimed','pending','unknown','verified_deleted','metadata_unlinked')),
  purge_id uuid,
  code text,
  verified_at timestamptz,
  check((kind='object_purge' and publication_id is not null and object_key ~ '^v1/[a-f0-9-]{36}$' and bucket_kind='public')
    or (kind='metadata_unlink' and object_key is null and metadata_kind is not null)),
  unique(epoch,object_key),
  unique(epoch,team_scope,metadata_kind)
);

-- All operational ownership stays server-side. No accidental default service-table privileges.
do $$ declare relation text; begin
 foreach relation in array array['catalog_global_policy','catalog_global_operators','catalog_global_images','catalog_global_aliases','catalog_global_identities','catalog_global_assignments','catalog_global_recipes','catalog_global_use_receipts','catalog_global_jobs','catalog_global_entries','catalog_global_journal','catalog_image_retirements'] loop
  execute format('alter table private.%I enable row level security',relation);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',relation);
 end loop;
end $$;

create function private.catalog_global_is_active() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.catalog_global_policy where singleton and activated_at is not null)
$$;
revoke all on function private.catalog_global_is_active() from public,anon,authenticated,service_role;

create function private.catalog_global_policy_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.activated_at is not null and
   (new.activated_at is distinct from old.activated_at or new.delete_after is distinct from old.delete_after or new.environment is distinct from old.environment or new.epoch is distinct from old.epoch or new.media_origin is distinct from old.media_origin or new.state in ('prepared','draining')) then
  raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';
 end if;
 return new;
end $$;
revoke all on function private.catalog_global_policy_immutable() from public,anon,authenticated,service_role;
create trigger catalog_global_policy_immutable before update on private.catalog_global_policy
 for each row execute function private.catalog_global_policy_immutable();

create function public.service_catalog_global_readiness(p_actor uuid,p_team uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cfg private.catalog_global_policy%rowtype; usable boolean; reason text;
begin
 if p_actor is null or (p_team is not null and not private.can(p_team,'view',p_actor)) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_global_policy where singleton;
 usable:=cfg.activated_at is not null and cfg.serving_revision=cfg.routing_revision
  and cfg.serving_verified_at>statement_timestamp()-interval '120 seconds'
  and exists(select 1 from private.catalog_global_images i join private.catalog_global_aliases a on a.image_id=i.id and a.generation=(i.issued_seq/200)+1
   where i.environment=cfg.environment and i.active and i.state='ready' and i.content_proof_revision=cfg.routing_revision
   and i.content_expires_at>statement_timestamp() and a.state='ready' and a.key_version=any(cfg.accepted_key_versions));
 reason:=case when usable then null when cfg.activated_at is null then 'GLOBAL_IMAGE_POLICY_CONFLICT'
  when cfg.serving_verified_at is null or cfg.serving_verified_at<=statement_timestamp()-interval '120 seconds' or cfg.serving_revision is distinct from cfg.routing_revision then 'GLOBAL_IMAGE_READINESS_UNKNOWN'
  else 'GLOBAL_IMAGE_POOL_UNAVAILABLE' end;
 return jsonb_build_object('contractVersion',3,'policyEpoch',cfg.epoch,'state',cfg.state,'usable',coalesce(usable,false),'reason',reason,'observedAt',statement_timestamp());
end $$;
revoke all on function public.service_catalog_global_readiness(uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_readiness(uuid,uuid) to service_role;

create function private.catalog_global_image_json(p_assignment uuid,p_epoch bigint) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('kind','global','imageId',i.id,'assignmentId',a.id,'aliasId',u.id,
  'publicUrl',u.public_url,'generation',a.generation,'issuedSlot',a.issued_slot::text,
  'policyEpoch',p_epoch,'classification',i.classification)
 from private.catalog_global_assignments a join private.catalog_global_images i on i.id=a.image_id
 join private.catalog_global_aliases u on u.id=a.alias_id where a.id=p_assignment
$$;
revoke all on function private.catalog_global_image_json(uuid,bigint) from public,anon,authenticated,service_role;

create function public.service_catalog_global_allocate(
 p_actor uuid,p_team uuid,p_catalog uuid,p_intent uuid,p_count integer,
 p_epoch bigint,p_scope text default 'create',p_pairs jsonb default '[]'
) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='50ms' as $$
declare cfg private.catalog_global_policy%rowtype; identity_row private.catalog_global_identities%rowtype;
 recipe private.catalog_global_recipes%rowtype; image_row private.catalog_global_images%rowtype;
 assignment private.catalog_global_assignments%rowtype; alias_row private.catalog_global_aliases%rowtype;
 chosen jsonb:='[]'; result jsonb:='[]'; selected_ids uuid[]:='{}'; row_index integer; pass integer;
 wanted jsonb; cursor_id uuid:=gen_random_uuid(); scan_limit integer; started timestamptz:=clock_timestamp();
 picked_ids uuid[]; uniform_pair jsonb; new_slot bigint; generation_no bigint; candidates private.catalog_global_images[]; candidate_row private.catalog_global_images; candidate_offset integer; candidate_count integer;
begin
 if p_actor is null or not private.can(p_team,'upload',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if p_catalog is null or p_intent is null or p_count is null or p_scope is null or p_epoch is null or p_count not between 1 and 400 or p_scope not in ('create','refresh','growth')
  or jsonb_typeof(p_pairs) is distinct from 'array' or jsonb_array_length(p_pairs)>400 then raise exception 'INVALID_INPUT'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('catalog-global-intent:'||p_intent::text,520)) then raise exception 'GLOBAL_IMAGE_ALLOCATION_UNKNOWN'; end if;
 select * into cfg from private.catalog_global_policy where singleton;
 if cfg.activated_at is null or cfg.epoch<>p_epoch then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT'; end if;
 if cfg.serving_revision is distinct from cfg.routing_revision or cfg.serving_verified_at is null or cfg.serving_verified_at<=clock_timestamp()-interval '120 seconds' then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN'; end if;
 select * into identity_row from private.catalog_global_identities where id=p_catalog or material_id=p_catalog;
 if found and (identity_row.closed or identity_row.team_id is distinct from p_team) then raise exception 'PERMISSION_DENIED'; end if;
 if not found then
  insert into private.catalog_global_identities(id,team_id,actor_id,creation_intent) values(p_catalog,p_team,p_actor,p_catalog) on conflict(id) do nothing;
  select * into identity_row from private.catalog_global_identities where id=p_catalog;
  if identity_row.closed or identity_row.team_id is distinct from p_team then raise exception 'PERMISSION_DENIED'; end if;
 end if;
 if exists(select 1 from private.catalog_global_recipes where intent_id=p_intent and catalog_id<>identity_row.id) then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 select * into recipe from private.catalog_global_recipes where intent_id=p_intent and scope=p_scope;
 if found then
  if recipe.catalog_id<>identity_row.id or recipe.requested_count<>p_count or recipe.epoch<>p_epoch then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return jsonb_build_object('recipeId',recipe.id,'catalogId',recipe.catalog_id,'policyEpoch',recipe.epoch,'images',recipe.images,'reused',true);
 end if;
 -- The common unrestricted/single-bucket batch uses set operations and one image-lock scan.
 -- No per-row SQL, waiting, provider I/O or mutable URL generation is on this path.
 uniform_pair:=case when jsonb_array_length(p_pairs)>0 then p_pairs->0 else 'null'::jsonb end;
 if jsonb_array_length(p_pairs)=0 or (jsonb_array_length(p_pairs)=p_count and not exists(select 1 from jsonb_array_elements(p_pairs) v where v is distinct from uniform_pair)) then
  with locked as materialized (
   select i.id from private.catalog_global_images i
   where i.environment=cfg.environment and i.active and i.state='ready'
    and (uniform_pair='null'::jsonb or i.classification->>'mode'='unclassified' or (i.garment=uniform_pair->>'garment' and i.color=uniform_pair->>'color'))
    and i.content_proof_revision=cfg.routing_revision and i.content_expires_at>statement_timestamp()
    and exists(select 1 from private.catalog_global_aliases u where u.image_id=i.id and u.state='ready' and u.key_version=any(cfg.accepted_key_versions)
     and u.generation=coalesce((select a.generation from private.catalog_global_assignments a where a.catalog_id=identity_row.id and a.image_id=i.id),i.issued_seq/200+1))
   order by (i.id>=cursor_id) desc,i.id limit p_count for update of i skip locked
  ) select array_agg(id) into picked_ids from locked;
  if cardinality(picked_ids)=p_count then
   update private.catalog_global_images i set issued_seq=i.issued_seq+1 where i.id=any(picked_ids)
    and not exists(select 1 from private.catalog_global_assignments a where a.catalog_id=identity_row.id and a.image_id=i.id);
   insert into private.catalog_global_assignments(catalog_id,image_id,alias_id,issued_slot,generation)
    select identity_row.id,i.id,u.id,i.issued_seq,((i.issued_seq-1)/200)+1
    from private.catalog_global_images i join private.catalog_global_aliases u on u.image_id=i.id and u.generation=((i.issued_seq-1)/200)+1
    where i.id=any(picked_ids) and u.state='ready' and u.key_version=any(cfg.accepted_key_versions)
     and not exists(select 1 from private.catalog_global_assignments a where a.catalog_id=identity_row.id and a.image_id=i.id);
   select jsonb_agg(jsonb_build_object('kind','global','imageId',i.id,'assignmentId',a.id,'aliasId',u.id,
    'publicUrl',u.public_url,'generation',a.generation,'issuedSlot',a.issued_slot::text,'policyEpoch',cfg.epoch,'classification',i.classification) order by p.ordinality)
    into result from unnest(picked_ids) with ordinality p(id,ordinality)
    join private.catalog_global_assignments a on a.catalog_id=identity_row.id and a.image_id=p.id
    join private.catalog_global_images i on i.id=a.image_id join private.catalog_global_aliases u on u.id=a.alias_id;
   if jsonb_array_length(result) is distinct from p_count then raise exception 'GLOBAL_IMAGE_POOL_UNAVAILABLE';end if;
   insert into private.catalog_global_recipes(catalog_id,intent_id,scope,epoch,images,requested_count)
    values(identity_row.id,p_intent,p_scope,cfg.epoch,result,p_count) returning * into recipe;
   insert into private.catalog_global_journal(flow_id,attempt_id,team_id,actor_id,catalog_id,stage,counts)
    values(p_intent,p_intent,p_team,p_actor,identity_row.id,'allocated',jsonb_build_object('rows',p_count,'distinct',p_count));
   return jsonb_build_object('recipeId',recipe.id,'catalogId',recipe.catalog_id,'policyEpoch',cfg.epoch,'images',result,'reused',false);
  end if;
 end if;
 scan_limit:=2000;
 -- Read eligible candidate metadata once. Per-row work is a short, non-waiting image lock.
 select array_agg(z order by (z.id>=cursor_id) desc,z.id) into candidates from (
  select i.* from private.catalog_global_images i where i.environment=cfg.environment and i.active and i.state='ready'
   and (jsonb_array_length(p_pairs)=0 or i.classification->>'mode'='unclassified' or exists(select 1 from jsonb_array_elements(p_pairs) wanted_pair where wanted_pair='null'::jsonb or (i.garment=wanted_pair->>'garment' and i.color=wanted_pair->>'color')))
   and i.content_proof_revision=cfg.routing_revision and i.content_expires_at>statement_timestamp()
   and exists(select 1 from private.catalog_global_aliases a where a.image_id=i.id and a.state='ready' and a.key_version=any(cfg.accepted_key_versions)
    and a.generation=coalesce((select x.generation from private.catalog_global_assignments x where x.catalog_id=identity_row.id and x.image_id=i.id),i.issued_seq/200+1))
  order by (i.id>=cursor_id) desc,i.id limit scan_limit
 ) z;
 candidate_count:=coalesce(cardinality(candidates),0);
 if candidate_count=0 then raise exception 'GLOBAL_IMAGE_POOL_UNAVAILABLE';end if;
 for row_index in 0..p_count-1 loop
  if clock_timestamp()-started>interval '750 milliseconds' then raise exception 'GLOBAL_IMAGE_POOL_UNAVAILABLE';end if;
  wanted:=case when jsonb_array_length(p_pairs)>row_index then p_pairs->row_index else null end;
  assignment:=null;image_row:=null;
  for pass in 1..2 loop
   for candidate_offset in 0..candidate_count-1 loop
    candidate_row:=candidates[((row_index+candidate_offset)%candidate_count)+1];
    if pass=1 and candidate_row.id=any(selected_ids) then continue;end if;
    if wanted is not null and wanted<>'null'::jsonb and candidate_row.classification->>'mode'<>'unclassified'
     and (candidate_row.garment is distinct from wanted->>'garment' or candidate_row.color is distinct from wanted->>'color') then continue;end if;
    select * into image_row from private.catalog_global_images where id=candidate_row.id and active and state='ready'
     and content_expires_at>clock_timestamp() and content_proof_revision=cfg.routing_revision for update skip locked;
    if not found then continue;end if;
    select * into assignment from private.catalog_global_assignments where catalog_id=identity_row.id and image_id=image_row.id;
    if not found then
     new_slot:=image_row.issued_seq+1; generation_no:=((new_slot-1)/200)+1;
     select * into alias_row from private.catalog_global_aliases where image_id=image_row.id and generation=generation_no and state='ready' and key_version=any(cfg.accepted_key_versions);
     if not found then continue; end if;
     insert into private.catalog_global_assignments(catalog_id,image_id,alias_id,issued_slot,generation)
      values(identity_row.id,image_row.id,alias_row.id,new_slot,generation_no) returning * into assignment;
     update private.catalog_global_images set issued_seq=new_slot where id=image_row.id;
    end if;
    exit;
   end loop;
   exit when assignment.id is not null;
  end loop;
  if assignment.id is null then raise exception 'GLOBAL_IMAGE_POOL_UNAVAILABLE'; end if;
  selected_ids:=array_append(selected_ids,assignment.image_id);
  result:=result||jsonb_build_array(private.catalog_global_image_json(assignment.id,cfg.epoch));
 end loop;
 insert into private.catalog_global_recipes(catalog_id,intent_id,scope,epoch,images,requested_count)
  values(identity_row.id,p_intent,p_scope,cfg.epoch,result,p_count) returning * into recipe;
 insert into private.catalog_global_journal(flow_id,attempt_id,team_id,actor_id,catalog_id,stage,counts)
  values(p_intent,p_intent,p_team,p_actor,identity_row.id,'allocated',jsonb_build_object('rows',p_count,'distinct',cardinality(array(select distinct unnest(selected_ids)))));
 return jsonb_build_object('recipeId',recipe.id,'catalogId',recipe.catalog_id,'policyEpoch',cfg.epoch,'images',result,'reused',false);
exception when lock_not_available or deadlock_detected or query_canceled then
 raise exception 'GLOBAL_IMAGE_ALLOCATION_UNKNOWN';
end $$;
revoke all on function public.service_catalog_global_allocate(uuid,uuid,uuid,uuid,integer,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_global_allocate(uuid,uuid,uuid,uuid,integer,bigint,text,jsonb) to service_role;

-- Only canonical server completion/reconciliation calls this after provider readback.
create function public.service_catalog_global_confirm(p_team uuid,p_intent uuid,p_completion uuid) returns jsonb language plpgsql security definer set search_path='' set lock_timeout='50ms' as $$
declare r private.catalog_global_recipes%rowtype; a private.catalog_global_assignments%rowtype; delta integer:=0; changed integer;
begin
 if p_completion is null then raise exception 'GLOBAL_IMAGE_ALLOCATION_UNKNOWN'; end if;
 if not exists(select 1 from private.catalog_global_recipes check_recipe join private.catalog_global_identities c on c.id=check_recipe.catalog_id where check_recipe.intent_id=p_intent and c.team_id=p_team and not c.closed) then raise exception 'PERMISSION_DENIED';end if;
 for r in select z.* from private.catalog_global_recipes z join private.catalog_global_identities c on c.id=z.catalog_id
  where z.intent_id=p_intent and c.team_id=p_team and not c.closed order by z.id for update of z loop
  for a in select x.* from private.catalog_global_assignments x
   where x.catalog_id=r.catalog_id and exists(select 1 from jsonb_array_elements(r.images) v where v->>'assignmentId'=x.id::text)
   order by x.image_id for update of x loop
   insert into private.catalog_global_use_receipts(assignment_id,recipe_id,completion_ref)
    values(a.id,r.id,p_completion) on conflict(assignment_id) do nothing;
   get diagnostics changed=row_count;
   if changed=1 then
    update private.catalog_global_assignments set state='confirmed',committed_at=clock_timestamp() where id=a.id;
    update private.catalog_global_images set confirmed_uses=confirmed_uses+1,last_confirmed_at=clock_timestamp() where id=a.image_id;
    update private.catalog_global_aliases set confirmed_uses=confirmed_uses+1 where id=a.alias_id;
    delta:=delta+1;
   end if;
  end loop;
  update private.catalog_global_recipes set state='confirmed',completion_ref=p_completion where id=r.id;
 end loop;
 if exists(select 1 from private.catalog_global_recipes where intent_id=p_intent) then
  insert into private.catalog_global_journal(flow_id,attempt_id,team_id,actor_id,catalog_id,stage,counts) values(p_intent,p_intent,p_team,(select actor_id from private.catalog_global_journal where flow_id=p_intent and stage='allocated' order by seq desc limit 1),(select catalog_id from private.catalog_global_recipes where intent_id=p_intent limit 1),'confirmed',jsonb_build_object('newUses',delta));
 end if;
 return jsonb_build_object('confirmed',delta);
end $$;
revoke all on function public.service_catalog_global_confirm(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_confirm(uuid,uuid,uuid) to service_role;

create function public.service_catalog_global_bind(p_team uuid,p_catalog uuid,p_material uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.team_materials where id=p_material and team_id=p_team) then raise exception 'NOT_FOUND'; end if;
 update private.catalog_global_identities set material_id=p_material where id=p_catalog and team_id=p_team and not closed and (material_id is null or material_id=p_material);
 if not found then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT'; end if;
end $$;
revoke all on function public.service_catalog_global_bind(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_bind(uuid,uuid,uuid) to service_role;

create function private.catalog_global_team_deleted() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_global_identities set closed=true,actor_id=null,material_id=null where team_id=old.id;
 update private.catalog_global_journal set team_id=null where team_id=old.id;
 return old;
end $$;
revoke all on function private.catalog_global_team_deleted() from public,anon,authenticated,service_role;
create trigger catalog_global_before_team_delete before delete on public.teams for each row execute function private.catalog_global_team_deleted();

create function private.catalog_global_image_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.id,new.environment,new.canonical_key,new.sha256,new.mime,new.size_bytes,new.width,new.height,new.classification)
  is distinct from (old.id,old.environment,old.canonical_key,old.sha256,old.mime,old.size_bytes,old.width,old.height,old.classification)
  or new.issued_seq<old.issued_seq or new.confirmed_uses<old.confirmed_uses then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT'; end if;
 return new;
end $$;
revoke all on function private.catalog_global_image_immutable() from public,anon,authenticated,service_role;
create trigger catalog_global_image_immutable before update on private.catalog_global_images
 for each row execute function private.catalog_global_image_immutable();

create function private.catalog_global_assignment_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.catalog_id,new.image_id,new.alias_id,new.issued_slot,new.generation) is distinct from
  (old.catalog_id,old.image_id,old.alias_id,old.issued_slot,old.generation)
  or (old.state='confirmed' and new.state<>'confirmed') then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT'; end if;
 return new;
end $$;
revoke all on function private.catalog_global_assignment_immutable() from public,anon,authenticated,service_role;
create trigger catalog_global_assignment_immutable before update on private.catalog_global_assignments
 for each row execute function private.catalog_global_assignment_immutable();

-- Operator/import work is deliberately separate from the tenant import API.
alter table private.catalog_global_jobs add column payload jsonb not null default '{}' check(octet_length(payload::text)<=16384);
alter table private.catalog_global_entries add column grant_request_key text;
alter table private.catalog_global_entries add column source_sha256 text;
alter table private.catalog_global_images add column owner_entry_id uuid;
alter table private.catalog_global_images add column publication_fence bigint not null default 1;
create unique index catalog_global_background_intents on private.catalog_global_jobs(kind,intent_key) where actor_id is null;
create table private.catalog_global_manifest_pages (
 job_id uuid not null references private.catalog_global_jobs(id), page_key text not null,
 digest text not null, primary key(job_id,page_key)
);
alter table private.catalog_global_manifest_pages enable row level security;
revoke all on private.catalog_global_manifest_pages from public,anon,authenticated,service_role;

create function private.catalog_global_operator(p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select p_actor is not null and (auth.uid() is null or auth.uid()=p_actor)
  and exists(select 1 from private.catalog_global_operators o join public.profiles p on p.id=o.actor_id where o.actor_id=p_actor and p.account_status='active')
$$;
revoke all on function private.catalog_global_operator(uuid) from public,anon,authenticated,service_role;

create function private.catalog_global_job_snapshot(p_job uuid,p_cursor uuid default null) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',j.id,'state',j.state,'kind',j.kind,'totalFiles',j.total_files,'totalBytes',j.total_bytes::text,'code',j.code,
  'counts',(select jsonb_build_object('ready',count(*) filter(where e.state='ready'),'reused',count(*) filter(where e.state='reused'),'failed',count(*) filter(where e.state='failed'),'unknown',count(*) filter(where e.state='unknown'),'waiting',count(*) filter(where e.state not in ('ready','reused','failed','cancelled','unknown'))) from private.catalog_global_entries e where e.job_id=j.id),
  'entries',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'fileKey',e.file_key,'displayName',e.display_name,'state',e.state,'code',e.code,'imageId',e.image_id) order by e.id) from (select * from private.catalog_global_entries where job_id=j.id and (p_cursor is null or id>p_cursor) order by id limit 100)e),'[]'::jsonb),
  'nextCursor',(select e.id::text from private.catalog_global_entries e where e.job_id=j.id and (p_cursor is null or e.id>p_cursor) order by e.id offset 99 limit 1),
  'hasMore',(select count(*)>100 from private.catalog_global_entries e where e.job_id=j.id and (p_cursor is null or e.id>p_cursor)))
 from private.catalog_global_jobs j where j.id=p_job
$$;
revoke all on function private.catalog_global_job_snapshot(uuid,uuid) from public,anon,authenticated,service_role;

create function public.service_catalog_global_control(p_actor uuid,p_action text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_global_policy%rowtype; j private.catalog_global_jobs%rowtype;
 e private.catalog_global_entries%rowtype; item jsonb; entry_key text; page_digest text; old_digest text;
 target_job uuid; target_entry uuid; changed integer; n integer; bytes bigint; versions integer[];
begin
 if not private.catalog_global_operator(p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'INVALID_INPUT'; end if;
 select * into cfg from private.catalog_global_policy where singleton;
 if p_action='configure' then
  if p_payload->>'environment' not in ('dev','beta','production') or length(coalesce(p_payload->>'routingRevision','')) not between 1 and 100
   or coalesce(p_payload->>'mediaOrigin','') !~ '^https://[^/?#@[:space:]]+$'
   or jsonb_typeof(p_payload->'acceptedKeyVersions') is distinct from 'array'
   or jsonb_array_length(p_payload->'acceptedKeyVersions') not between 1 and 8 then raise exception 'INVALID_INPUT'; end if;
  select array_agg(value::int order by value::int desc) into versions from jsonb_array_elements_text(p_payload->'acceptedKeyVersions');
  if exists(select 1 from unnest(versions)v where v not between 1 and 65535) or cardinality(versions)<>(select count(distinct v) from unnest(versions)v) then raise exception 'INVALID_INPUT'; end if;
  if exists(select 1 from private.catalog_global_aliases a join private.catalog_global_assignments x on x.alias_id=a.id where not(a.key_version=any(versions))) then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT'; end if;
  update private.catalog_global_policy set environment=p_payload->>'environment',media_origin=p_payload->>'mediaOrigin',
   routing_revision=p_payload->>'routingRevision',accepted_key_versions=versions,serving_verified_at=null,serving_revision=null where singleton;
  return jsonb_build_object('configured',true,'state',cfg.state);
 end if;
 if cfg.environment is null or cfg.media_origin is null then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN'; end if;
 if p_action='begin' then
  if length(coalesce(p_payload->>'idempotencyKey','')) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
  n:=(p_payload->>'totalFiles')::int;bytes:=(p_payload->>'totalBytes')::bigint;
  if n is null or n not between 1 and 1000 or bytes is null or bytes not between 1 and 5000000000 then raise exception 'INVALID_INPUT'; end if;
  insert into private.catalog_global_jobs(actor_id,intent_key,kind,total_files,total_bytes)
   values(p_actor,p_payload->>'idempotencyKey','import',n,bytes) on conflict(actor_id,intent_key,kind) do nothing;
  select * into j from private.catalog_global_jobs where actor_id=p_actor and intent_key=p_payload->>'idempotencyKey' and kind='import' for update;
  if j.total_files<>n or j.total_bytes<>bytes then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return private.catalog_global_job_snapshot(j.id);
 end if;
 target_job:=nullif(p_payload->>'jobId','')::uuid;
 select * into j from private.catalog_global_jobs where id=target_job and actor_id=p_actor and kind='import' for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if p_action='get' then return private.catalog_global_job_snapshot(j.id,nullif(p_payload->>'cursor','')::uuid); end if;
 if p_action='cancel' then
  update private.catalog_global_jobs set state='cancelled',fence=fence+1,lease_until=null where id=j.id;
  update private.catalog_global_entries set state='cancelled',fence=fence+1,lease_until=null where job_id=j.id and state not in ('ready','reused');
  return private.catalog_global_job_snapshot(j.id);
 end if;
 if p_action='retry' then
  if j.state='cancelled' then raise exception 'WRONG_STATE'; end if;
  update private.catalog_global_entries set state=case when staging_key is null then 'waiting_source' else 'staged' end,attempts=0,next_attempt_at=now(),code=null where job_id=j.id and state='failed' and source_deadline>now();
  update private.catalog_global_jobs set state='sealed',code=null where id=j.id;
  return private.catalog_global_job_snapshot(j.id);
 end if;
 if p_action='manifest' then
  if j.state<>'collecting' or jsonb_typeof(p_payload->'entries') is distinct from 'array'
   or jsonb_array_length(p_payload->'entries') not between 1 and 100 or length(coalesce(p_payload->>'pageKey','')) not between 1 and 200 then raise exception 'INVALID_INPUT'; end if;
  page_digest:=encode(extensions.digest((p_payload->'entries')::text,'sha256'),'hex');
  select digest into old_digest from private.catalog_global_manifest_pages where job_id=j.id and page_key=p_payload->>'pageKey';
  if found then
   if old_digest<>page_digest then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return private.catalog_global_job_snapshot(j.id);
  end if;
  for item in select value from jsonb_array_elements(p_payload->'entries') loop
   if jsonb_typeof(item) is distinct from 'object' or length(coalesce(item->>'fileKey','')) not between 1 and 200
    or length(coalesce(item->>'displayName','')) not between 1 and 255 or item->>'displayName' ~ '[/\\]'
    or (item->>'size')::bigint not between 1 and 50000000
    or item->>'mime' not in ('image/jpeg','image/png','image/webp')
    or not private.catalog_global_classification_valid(item->'classification') then raise exception 'INVALID_INPUT'; end if;
   insert into private.catalog_global_entries(job_id,file_key,display_name,declared_size,declared_mime,classification)
    values(j.id,item->>'fileKey',item->>'displayName',(item->>'size')::bigint,item->>'mime',item->'classification') on conflict(job_id,file_key) do nothing;
   if not exists(select 1 from private.catalog_global_entries where job_id=j.id and file_key=item->>'fileKey' and declared_size=(item->>'size')::bigint and declared_mime=item->>'mime' and classification=item->'classification') then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  end loop;
  if (select count(*) from private.catalog_global_entries where job_id=j.id)>j.total_files or (select sum(declared_size) from private.catalog_global_entries where job_id=j.id)>j.total_bytes then raise exception 'TOO_LARGE'; end if;
  insert into private.catalog_global_manifest_pages(job_id,page_key,digest) values(j.id,p_payload->>'pageKey',page_digest);
  return private.catalog_global_job_snapshot(j.id);
 end if;
 if p_action='seal' then
  if j.state not in ('collecting','sealed','running') then raise exception 'WRONG_STATE'; end if;
  if (select count(*) from private.catalog_global_entries where job_id=j.id)<>j.total_files or (select sum(declared_size) from private.catalog_global_entries where job_id=j.id)<>j.total_bytes then raise exception 'IMAGE_MANIFEST_INCOMPLETE'; end if;
  update private.catalog_global_jobs set state='sealed' where id=j.id and state='collecting';
  return private.catalog_global_job_snapshot(j.id);
 end if;
 target_entry:=nullif(p_payload->>'entryId','')::uuid;
 select * into e from private.catalog_global_entries where id=target_entry and job_id=j.id for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if j.state not in ('collecting','sealed','running') or e.state in ('ready','reused','failed','cancelled') or e.source_deadline<=clock_timestamp() then raise exception 'WRONG_STATE'; end if;
 if p_action='grant' then
  entry_key:=p_payload->>'requestKey';
  if length(coalesce(entry_key,'')) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
  if e.grant_request_key=entry_key and e.grant_expires_at>clock_timestamp() then
   return jsonb_build_object('stagingKey',e.staging_key,'mime',e.declared_mime,'expiresAt',e.grant_expires_at,'generation',e.grant_generation);
  end if;
  if (select count(*) from private.catalog_global_entries where grant_expires_at>clock_timestamp() and state not in ('ready','reused','failed','cancelled'))>=8 then raise exception 'IMAGE_UPLOAD_CAPACITY_BUSY'; end if;
  update private.catalog_global_entries set staging_key=coalesce(staging_key,gen_random_uuid()::text),grant_generation=grant_generation+1,
   grant_request_key=entry_key,grant_expires_at=clock_timestamp()+interval '5 minutes' where id=e.id returning * into e;
  return jsonb_build_object('stagingKey',e.staging_key,'mime',e.declared_mime,'expiresAt',e.grant_expires_at,'generation',e.grant_generation);
 end if;
 if p_action='delivered' then
  if e.staging_key is null then raise exception 'WRONG_STATE'; end if;
  update private.catalog_global_entries set state='staged',next_attempt_at=clock_timestamp() where id=e.id and state='waiting_source';
  return private.catalog_global_job_snapshot(j.id);
 end if;
 raise exception 'INVALID_INPUT';
end $$;
revoke all on function public.service_catalog_global_control(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_global_control(uuid,text,jsonb) to service_role;

-- Durable identity is reserved before a single issued slot is drawn.
create function public.service_catalog_global_identity(p_team uuid,p_actor uuid,p_catalog uuid,p_intent uuid,p_material uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare c private.catalog_global_identities%rowtype;
begin
 if p_catalog is null or p_intent is null or not private.can(p_team,'upload',p_actor) then raise exception 'PERMISSION_DENIED';end if;
 insert into private.catalog_global_identities(id,team_id,actor_id,creation_intent,material_id)
 values(p_catalog,p_team,p_actor,p_intent,p_material) on conflict(id) do nothing;
 select * into c from private.catalog_global_identities where id=p_catalog;
 if c.closed or c.team_id is distinct from p_team or c.creation_intent<>p_intent then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 return c.id;
end $$;
revoke all on function public.service_catalog_global_identity(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_identity(uuid,uuid,uuid,uuid,uuid) to service_role;

-- One bounded operational protocol; only the named-secret worker can reach this service RPC.
create function public.service_catalog_global_work(p_action text,p_worker text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='100ms' as $$
declare e private.catalog_global_entries%rowtype;i private.catalog_global_images%rowtype;c private.catalog_global_policy%rowtype;
 a private.catalog_global_aliases%rowtype;entry_id uuid;result jsonb;generation_no bigint;
begin
 if p_worker is null or length(p_worker) not between 8 and 100 or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>16384 then raise exception 'INVALID_INPUT';end if;
 select * into c from private.catalog_global_policy where singleton;
 if c.environment is null or c.media_origin is null then return null;end if;
 if p_action='claim' then
  -- Same admission lock as045, with both sets of leases counted.
  perform pg_advisory_xact_lock(hashtextextended('catalog-images-global',0));
  if (select count(*) from private.catalog_global_entries where lease_until>clock_timestamp())+
     (select count(*) from private.catalog_image_import_entries where lease_until>clock_timestamp())+
     (select count(*) from private.catalog_image_import_intents where lease_until>clock_timestamp())>=8 then return null;end if;
  select z.* into e from private.catalog_global_entries z join private.catalog_global_jobs j on j.id=z.job_id
   where j.state in('sealed','running','partial','unknown') and z.state in('staged','validating','publishing','verifying','unknown')
   and z.next_attempt_at<=clock_timestamp() and z.attempts<8 and (z.lease_until is null or z.lease_until<=clock_timestamp())
   order by z.next_attempt_at,z.id limit 1 for update of z skip locked;
  if not found then return null;end if;
  update private.catalog_global_entries set lease_owner=p_worker,lease_until=clock_timestamp()+interval '90 seconds',fence=fence+1,attempts=attempts+1,
   state=case when image_id is null then 'validating' else state end where id=e.id returning * into e;
  update private.catalog_global_jobs set state='running' where id=e.job_id;
  return jsonb_build_object('id',e.id,'jobId',e.job_id,'fence',e.fence::text,'stagingKey',e.staging_key,'size',e.declared_size,'mime',e.declared_mime,
   'classification',e.classification,'imageId',e.image_id,'environment',c.environment,'origin',c.media_origin,'revision',c.routing_revision,'keyVersion',c.accepted_key_versions[1]);
 end if;
 if p_action='probe_candidates' then
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'key',s.canonical_key,'sha256',s.sha256,'mime',s.mime,'size',s.size_bytes,
   'generation',((s.issued_seq)/200)+1,'environment',c.environment,'origin',c.media_origin,'revision',c.routing_revision,'keyVersion',c.accepted_key_versions[1])),'[]') into result
  from (select z.* from private.catalog_global_images z where z.environment=c.environment and z.active and z.state in('ready','verifying','unknown') and z.next_probe_at<=clock_timestamp()
   and (coalesce((p_data->>'dueOnly')::boolean,false)=false or z.state<>'ready' or z.content_expires_at<=clock_timestamp()+interval '6 hours'
    or c.serving_revision is distinct from c.routing_revision or c.serving_verified_at is null or c.serving_verified_at<=clock_timestamp()-interval '60 seconds'
    or exists(select 1 from generate_series(z.issued_seq/200+1,z.issued_seq/200+3) g where not exists(select 1 from private.catalog_global_aliases u where u.image_id=z.id and u.generation=g and u.state='ready' and u.key_version=any(c.accepted_key_versions))))
   order by (z.state='ready') desc,z.content_verified_at nulls first,z.id limit 8) s;
  return result;
 end if;
 if p_action='probe' then
  select * into i from private.catalog_global_images where id=(p_data->>'imageId')::uuid for update;
  if i.id is null then raise exception 'NOT_FOUND';end if;
  if exists(select 1 from private.catalog_global_entries where id=i.owner_entry_id and state='cancelled') then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  if p_data->>'revision' is distinct from c.routing_revision or p_data->>'sha256' is distinct from i.sha256 or p_data->>'environment' is distinct from c.environment then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  if p_data->>'success'='true' then
   update private.catalog_global_images set state='ready',next_probe_at=clock_timestamp()+interval '60 seconds',content_proof_revision=c.routing_revision,content_verified_at=clock_timestamp(),content_expires_at=clock_timestamp()+interval '24 hours' where id=i.id;
   update private.catalog_global_policy set serving_verified_at=clock_timestamp(),serving_revision=c.routing_revision where singleton;
  else
   update private.catalog_global_images set state='unknown',next_probe_at=clock_timestamp()+interval '15 minutes' where id=i.id;
  end if;
  insert into private.catalog_global_journal(image_id,stage,code) values(i.id,'serving_probe',case when p_data->>'success'='true' then null else 'GLOBAL_IMAGE_READINESS_UNKNOWN' end);
  return jsonb_build_object('accepted',true);
 end if;
 if p_action='alias' then
  select * into i from private.catalog_global_images where id=(p_data->>'imageId')::uuid for update;
  generation_no:=(p_data->>'generation')::bigint;
  if i.id is null or generation_no not between greatest(1,i.issued_seq/200+1) and i.issued_seq/200+3
   or p_data->>'revision' is distinct from c.routing_revision or (p_data->>'keyVersion')::int<>all(c.accepted_key_versions)
   or p_data->>'url' not like c.media_origin||'/g/%' then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  insert into private.catalog_global_aliases(image_id,generation,public_url,key_version,state,identity_revision,identity_verified_at)
   values(i.id,generation_no,p_data->>'url',(p_data->>'keyVersion')::int,'ready',c.routing_revision,clock_timestamp())
   on conflict(image_id,generation) do nothing;
  select * into a from private.catalog_global_aliases where image_id=i.id and generation=generation_no;
  if a.public_url is distinct from p_data->>'url' then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
  return jsonb_build_object('id',a.id);
 end if;
 entry_id:=(p_data->>'entryId')::uuid;
 select * into e from private.catalog_global_entries where id=entry_id for update;
 if e.id is null or e.lease_owner is distinct from p_worker or e.fence::text is distinct from p_data->>'fence' or e.lease_until<=clock_timestamp() then raise exception 'LEASE_MISMATCH';end if;
 if p_action='renew' then
  update private.catalog_global_entries set lease_until=clock_timestamp()+interval '90 seconds' where id=e.id;
  return jsonb_build_object('renewed',true);
 end if;
 if p_action='reserve' then
  if p_data->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-global-hash:'||c.environment||':'||(p_data->>'sha256'),520));
  select * into i from private.catalog_global_images where environment=c.environment and sha256=p_data->>'sha256';
  if not found then
   i.id:=gen_random_uuid();
   insert into private.catalog_global_images(id,environment,canonical_key,sha256,mime,size_bytes,width,height,classification,owner_entry_id)
   values(i.id,c.environment,'g1/'||i.id::text,p_data->>'sha256',p_data->>'mime',(p_data->>'size')::bigint,(p_data->>'width')::int,(p_data->>'height')::int,e.classification,e.id) returning * into i;
  end if;
  if i.classification-'reason' is distinct from e.classification-'reason' then raise exception 'IMAGE_CLASSIFICATION_CONFLICT';end if;
  if i.owner_entry_id is distinct from e.id and i.state<>'ready' then
   -- An abandoned unpublished reservation must not poison byte dedup forever.
   -- Canonical identity/bytes remain immutable; an issued image is never reassigned.
   if not exists(select 1 from private.catalog_global_assignments where image_id=i.id)
    and (i.owner_entry_id is null or exists(select 1 from private.catalog_global_entries old_entry
     where old_entry.id=i.owner_entry_id and (old_entry.state in('failed','cancelled') or old_entry.source_deadline<=clock_timestamp())
      and (old_entry.lease_until is null or old_entry.lease_until<=clock_timestamp()))) then
    update private.catalog_global_images set owner_entry_id=e.id,state='verifying',next_probe_at=clock_timestamp() where id=i.id returning * into i;
   else raise exception 'IMAGE_UPLOAD_CAPACITY_BUSY';end if;
  end if;
  update private.catalog_global_entries set image_id=i.id,state='publishing' where id=e.id;
  return jsonb_build_object('id',i.id,'key',i.canonical_key,'sha256',i.sha256,'mime',i.mime,'size',i.size_bytes,'ready',i.state='ready');
 end if;
 if p_action='finish' then
  if p_data->>'success'='true' then
   if not exists(select 1 from private.catalog_global_images where id=e.image_id and state='ready' and content_expires_at>clock_timestamp()) then raise exception 'GLOBAL_IMAGE_READINESS_UNKNOWN';end if;
   update private.catalog_global_entries set state=case when exists(select 1 from private.catalog_global_images img where img.id=e.image_id and img.owner_entry_id is distinct from e.id) then 'reused' else 'ready' end,lease_owner=null,lease_until=null,code=null where id=e.id;
  else
   if p_data->>'code' is null or not exists(select 1 from public.team_error_codes where code=p_data->>'code') then raise exception 'INVALID_INPUT';end if;
   update private.catalog_global_entries set state=case when attempts>=8 then 'failed' else 'unknown' end,lease_owner=null,lease_until=null,code=p_data->>'code',next_attempt_at=clock_timestamp()+interval '30 seconds' where id=e.id;
  end if;
  if e.staging_key is not null then insert into private.catalog_image_purges(scope_id,bucket_kind,object_key,reason,not_before) values(e.job_id,'staging',e.staging_key,'expired_staging',greatest(clock_timestamp(),coalesce(e.grant_expires_at,clock_timestamp()))+interval '5 minutes') on conflict(bucket_kind,object_key) do nothing;end if;
  update private.catalog_global_jobs j set state=case when exists(select 1 from private.catalog_global_entries where job_id=j.id and state not in('ready','reused','failed','cancelled')) then 'running'
   when exists(select 1 from private.catalog_global_entries where job_id=j.id and state in('failed','cancelled')) then 'partial' else 'completed' end where id=e.job_id;
  insert into private.catalog_global_journal(flow_id,attempt_id,image_id,stage,code) values(e.job_id,e.id,e.image_id,'import_finished',case when p_data->>'success'='true' then null else p_data->>'code' end);
  return jsonb_build_object('finished',true);
 end if;
 raise exception 'INVALID_INPUT';
end $$;
revoke all on function public.service_catalog_global_work(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_catalog_global_work(text,text,jsonb) to service_role;
create function public.service_catalog_global_alias_plan(p_image uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with image as (
  select i.*,p.accepted_key_versions from private.catalog_global_images i cross join private.catalog_global_policy p where i.id=p_image and p.singleton
 ), current_plan as (
  select g generation,a.public_url url,coalesce(a.key_version,i.accepted_key_versions[1]) key_version,false historical
  from image i cross join lateral generate_series(i.issued_seq/200+1,i.issued_seq/200+3) g
  left join private.catalog_global_aliases a on a.image_id=i.id and a.generation=g
 ), retained_keys as (
  -- One immutable issued URL per old key, never a daily scan of historical URLs.
  select distinct on(a.key_version) a.generation,a.public_url url,a.key_version,true historical
  from image i join private.catalog_global_aliases a on a.image_id=i.id
  where a.state='ready' and a.key_version=any(i.accepted_key_versions)
   and exists(select 1 from private.catalog_global_assignments x where x.alias_id=a.id)
   and not exists(select 1 from current_plan c where c.key_version=a.key_version)
  order by a.key_version,a.generation,a.id
 )
 select coalesce(jsonb_agg(jsonb_build_object('generation',generation,'url',url,'keyVersion',key_version,'historical',historical) order by historical,generation),'[]')
 from(select * from current_plan union all select * from retained_keys) plan
$$;
revoke all on function public.service_catalog_global_alias_plan(uuid) from public,anon,authenticated;
grant execute on function public.service_catalog_global_alias_plan(uuid) to service_role;
-- Content-free server lifecycle receipts; client collection cannot change exact counters.
create function private.catalog_global_job_journal() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.state is distinct from old.state then
  insert into private.catalog_global_journal(flow_id,actor_id,stage,code,counts) values(new.id,new.actor_id,'import_'||new.state,new.code,jsonb_build_object('files',new.total_files));
 end if;
 return new;
end $$;
create function private.catalog_global_entry_journal() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' or new.state is distinct from old.state then
  insert into private.catalog_global_journal(flow_id,attempt_id,actor_id,image_id,stage,code) values(new.job_id,new.id,(select actor_id from private.catalog_global_jobs where id=new.job_id),new.image_id,new.state,new.code);
 end if;
 return new;
end $$;
revoke all on function private.catalog_global_job_journal(),private.catalog_global_entry_journal() from public,anon,authenticated,service_role;
create trigger catalog_global_job_journal after insert or update of state on private.catalog_global_jobs for each row execute function private.catalog_global_job_journal();
create trigger catalog_global_entry_journal after insert or update of state on private.catalog_global_entries for each row execute function private.catalog_global_entry_journal();

create table private.catalog_global_acceptance (
 manifest_digest text primary key,environment text not null,routing_revision text not null,source_sha text not null,
 evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'),evidence jsonb not null,recorded_at timestamptz not null default now(),expires_at timestamptz not null
);
alter table private.catalog_global_acceptance enable row level security;
revoke all on private.catalog_global_acceptance from public,anon,authenticated,service_role;
create function public.service_catalog_global_acceptance(p_evidence jsonb,p_digest text) returns void language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(p_evidence) is distinct from 'object' or octet_length(p_evidence::text)>16384 or p_evidence->>'schema' is distinct from '1'
  or p_evidence->>'http' is distinct from 'verified' or p_evidence->>'browser' is distinct from 'verified'
  or p_evidence->>'installed_macos' is distinct from 'verified' or p_evidence->>'installed_windows' is distinct from 'verified'
  or p_evidence->>'meta_import' is distinct from 'verified' or p_evidence->>'origin_request_fanout' is distinct from 'verified'
  or p_evidence->>'retirement' is distinct from 'verified' or p_evidence->>'diagnostics' is distinct from 'verified'
  or p_evidence->>'performance' is distinct from 'verified' or p_evidence->>'drained_legacy_writes' is distinct from 'verified'
  or p_evidence->>'drained_legacy_deletions' is distinct from 'verified'
  or p_evidence#>>'{builds,current,policy_aware}' is distinct from 'true' or p_evidence#>>'{builds,rollback,policy_aware}' is distinct from 'true'
  or (p_evidence->>'observed_at')::timestamptz<clock_timestamp()-interval '120 seconds' then raise exception 'GLOBAL_IMAGE_POLICY_CONFLICT';end if;
 insert into private.catalog_global_acceptance(manifest_digest,environment,routing_revision,source_sha,evidence_digest,evidence,expires_at)
 values(p_evidence->>'manifest_digest',p_evidence->>'environment',p_evidence->>'routing_revision',p_evidence->>'source_sha',p_digest,p_evidence,(p_evidence->>'observed_at')::timestamptz+interval '120 seconds')
 on conflict(manifest_digest) do update set evidence_digest=excluded.evidence_digest,evidence=excluded.evidence,expires_at=excluded.expires_at,recorded_at=clock_timestamp();
end $$;
revoke all on function public.service_catalog_global_acceptance(jsonb,text) from public,anon,authenticated;
grant execute on function public.service_catalog_global_acceptance(jsonb,text) to service_role;

-- A deleted material cannot reattach a new catalog to an old lifetime pair identity.
create function private.catalog_global_material_deleted() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_global_identities set closed=true,actor_id=null,material_id=null where material_id=old.id;
 return old;
end $$;
revoke all on function private.catalog_global_material_deleted() from public,anon,authenticated,service_role;
create trigger catalog_global_material_deleted before delete on public.team_materials for each row execute function private.catalog_global_material_deleted();

create index catalog_global_unknown_recipes on private.catalog_global_recipes using gin(images jsonb_path_ops) where state='unknown';
create function private.catalog_global_recipe_outcome() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state is distinct from old.state and new.state<>'confirmed' then
  insert into private.catalog_global_journal(flow_id,attempt_id,catalog_id,actor_id,team_id,stage)
   select new.intent_id,new.intent_id,new.catalog_id,c.actor_id,c.team_id,new.state from private.catalog_global_identities c where c.id=new.catalog_id;
 end if;
 return new;
end $$;
revoke all on function private.catalog_global_recipe_outcome() from public,anon,authenticated,service_role;
create trigger catalog_global_recipe_outcome after update of state on private.catalog_global_recipes for each row execute function private.catalog_global_recipe_outcome();
