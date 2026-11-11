-- 050. Optional publication of a catalog's video to R2. Metadata only: no
-- credentials, no provider I/O, disabled by default. Additive, except for one
-- nullable column on the publication link receipt and the replacement of
-- service_record_catalog_publication_link with a default sixth argument.

create table private.catalog_video_r2_config (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  policy_confirmed_at timestamptz,
  public_origin text check(public_origin is null or (public_origin ~ '^https://[a-z0-9.-]+$' and public_origin !~ '\.r2\.dev$' and public_origin !~ '\.r2\.cloudflarestorage\.com$')),
  part_bytes integer not null default 16777216 check(part_bytes between 5242880 and 67108864),
  grace_interval interval not null default interval '6 hours',
  team_quota_bytes bigint not null default 5000000000 check(team_quota_bytes>0),
  max_object_bytes bigint not null default 2147483648 check(max_object_bytes>0),
  max_claim_attempts integer not null default 24 check(max_claim_attempts between 1 and 1000),
  updated_at timestamptz not null default now()
);
insert into private.catalog_video_r2_config(singleton) values(true);

create table private.catalog_video_r2_preferences (
  catalog_material_id uuid primary key references public.team_materials(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  enabled boolean not null default false,
  revision bigint not null default 1,
  configured_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table private.catalog_video_r2_copies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  source_material_id uuid not null references public.team_materials(id) on delete cascade,
  requested_by_catalog uuid references public.team_materials(id) on delete set null,
  source_version text not null check(length(source_version) between 1 and 256),
  object_key text not null unique default 'v/'||replace(gen_random_uuid()::text,'-','')||'.mp4',
  state text not null default 'planned' check(state in ('planned','uploading','verifying','ready','retiring','deleted','failed')),
  size_bytes bigint not null check(size_bytes>0),
  mime text not null default 'video/mp4' check(mime='video/mp4'),
  source_md5 text check(source_md5 is null or source_md5 ~ '^[0-9a-f]{32}$'),
  full_hash_verified boolean not null default false,
  part_bytes integer not null check(part_bytes between 5242880 and 67108864),
  upload_id text check(upload_id is null or length(upload_id) between 1 and 1024),
  lease_owner text,
  lease_until timestamptz,
  fence bigint not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check(last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  retire_reason text check(retire_reason is null or retire_reason in ('replaced','disabled','source_removed','catalog_deleted','team_deleted','failed_upload')),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  retire_after timestamptz,
  deleted_at timestamptz,
  unique(id,team_id)
);
create unique index catalog_video_r2_live_copy on private.catalog_video_r2_copies(team_id,source_version) where state not in ('deleted','failed');
create index catalog_video_r2_copy_work on private.catalog_video_r2_copies(next_attempt_at) where state in ('planned','uploading','verifying');
create index catalog_video_r2_copy_retire on private.catalog_video_r2_copies(retire_after) where state='retiring';
create index catalog_video_r2_copy_quota on private.catalog_video_r2_copies(team_id,state);
create index catalog_video_r2_copy_catalog on private.catalog_video_r2_copies(requested_by_catalog) where requested_by_catalog is not null;

create table private.catalog_video_r2_parts (
  copy_id uuid not null references private.catalog_video_r2_copies(id) on delete cascade,
  part_number integer not null check(part_number between 1 and 10000),
  size_bytes integer not null check(size_bytes>0),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  etag text not null check(length(etag) between 1 and 255),
  verified_by text not null check(verified_by in ('provider_checksum','readback')),
  verified_at timestamptz not null default now(),
  primary key(copy_id,part_number)
);

create table private.catalog_video_r2_uses (
  catalog_material_id uuid not null references public.team_materials(id) on delete cascade,
  source_material_id uuid not null,
  copy_id uuid not null references private.catalog_video_r2_copies(id) on delete cascade,
  team_id uuid not null,
  confirmed_at timestamptz not null default now(),
  primary key(catalog_material_id,source_material_id)
);
create index catalog_video_r2_uses_copy on private.catalog_video_r2_uses(copy_id);

-- No FK anywhere: a tombstone must survive the deletion of the team, the
-- catalog, the source material and the copy row itself.
create table private.catalog_video_r2_purges (
  id uuid primary key default gen_random_uuid(),
  team_ref uuid,
  copy_ref uuid,
  object_key text not null unique,
  upload_id text,
  reason text not null check(reason in ('replaced','disabled','source_removed','catalog_deleted','team_deleted','failed_upload')),
  attempts integer not null default 0,
  fence bigint not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  purged_at timestamptz,
  last_error text check(last_error is null or last_error ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  created_at timestamptz not null default now()
);
create index catalog_video_r2_purge_work on private.catalog_video_r2_purges(next_attempt_at) where purged_at is null;

create table private.catalog_video_r2_journal (
  seq bigint generated always as identity primary key,
  team_id uuid,
  copy_id uuid,
  attempt_id uuid,
  intent_id uuid,
  catalog_material_id uuid,
  source_material_id uuid,
  actor_id uuid,
  stage text not null,
  code text,
  link_kind text,
  part_verification text,
  size_bucket text,
  duration_bucket text,
  full_hash_verified boolean,
  occurred_at timestamptz not null default clock_timestamp(),
  received_at timestamptz not null default clock_timestamp()
);
create index catalog_video_r2_journal_team on private.catalog_video_r2_journal(team_id,seq);
create index catalog_video_r2_journal_copy on private.catalog_video_r2_journal(copy_id,seq) where copy_id is not null;
create index catalog_video_r2_journal_catalog on private.catalog_video_r2_journal(catalog_material_id,seq) where catalog_material_id is not null;

create table private.catalog_video_r2_diagnostic_metadata (
  singleton boolean primary key default true check(singleton),
  installed_at timestamptz not null default clock_timestamp(),
  schema_version integer not null default 1
);
insert into private.catalog_video_r2_diagnostic_metadata(singleton) values(true);

-- One content-free mirror per catalog for the existing Realtime channel; the
-- private tables are invisible to Realtime (R17).
create table public.team_catalog_video_r2_signals (
  catalog_material_id uuid primary key references public.team_materials(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  enabled boolean not null default false,
  link_kind text not null default 'drive' check(link_kind in ('drive','r2')),
  copy_state text check(copy_state is null or copy_state in ('planned','uploading','verifying','ready','retiring','deleted','failed')),
  reason text check(reason is null or reason ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  last_successful_update_at timestamptz,
  revision bigint not null default 1 check(revision>0),
  updated_at timestamptz not null default now()
);
alter table public.team_catalog_video_r2_signals enable row level security;
alter table public.team_catalog_video_r2_signals force row level security;
revoke all on public.team_catalog_video_r2_signals from public,anon,authenticated,service_role;
grant select(catalog_material_id,team_id,enabled,link_kind,copy_state,reason,last_successful_update_at,revision,updated_at) on public.team_catalog_video_r2_signals to authenticated;
create policy catalog_video_r2_signal_read on public.team_catalog_video_r2_signals for select to authenticated
 using(private.can(team_id,'view',auth.uid()));
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
  select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='team_catalog_video_r2_signals') then
  alter publication supabase_realtime add table public.team_catalog_video_r2_signals;
 end if;
end $$;

-- The publication link receipt learns which kind of link it holds; null reads as drive.
alter table private.catalog_publication_link_receipts add column link_kind text check(link_kind is null or link_kind in ('drive','r2'));

-- Helpers -------------------------------------------------------------------

create function private.catalog_video_r2_size_bucket(p_bytes bigint) returns text language sql immutable set search_path='' as $$
 select case when p_bytes is null then null when p_bytes<16777216 then 'lt_16m' when p_bytes<67108864 then 'lt_64m' when p_bytes<268435456 then 'lt_256m' when p_bytes<1073741824 then 'lt_1g' else 'ge_1g' end
$$;
create function private.catalog_video_r2_duration_bucket(p_ms bigint) returns text language sql immutable set search_path='' as $$
 select case when p_ms is null then null when p_ms<1000 then 'lt_1s' when p_ms<10000 then 'lt_10s' when p_ms<60000 then 'lt_1m' when p_ms<600000 then 'lt_10m' else 'ge_10m' end
$$;

create function private.catalog_video_r2_journal_write(
 p_team uuid,p_copy uuid,p_catalog uuid,p_source uuid,p_actor uuid,p_stage text,p_code text default null,
 p_link_kind text default null,p_part_verification text default null,p_size_bytes bigint default null,p_duration_ms bigint default null,p_full_hash boolean default null,
 p_attempt uuid default null,p_intent uuid default null
) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_stage not in ('configured','planned','uploading','part_verified','verifying','ready','confirmed','retiring','deleted','purged','failed') then raise exception 'INVALID_INPUT'; end if;
 if p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{0,95}$' then raise exception 'INVALID_INPUT'; end if;
 insert into private.catalog_video_r2_journal(team_id,copy_id,attempt_id,intent_id,catalog_material_id,source_material_id,actor_id,stage,code,link_kind,part_verification,size_bucket,duration_bucket,full_hash_verified)
 values(p_team,p_copy,p_attempt,p_intent,p_catalog,p_source,p_actor,p_stage,p_code,p_link_kind,p_part_verification,private.catalog_video_r2_size_bucket(p_size_bytes),private.catalog_video_r2_duration_bucket(p_duration_ms),p_full_hash);
end $$;

-- Recompute one catalog's public signal from the private state.
create function private.catalog_video_r2_signal(p_catalog uuid,p_reason text default null,p_touch_update boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; v_enabled boolean; v_link text; v_copy private.catalog_video_r2_copies%rowtype; v_reason text;
begin
 select * into m from public.team_materials where id=p_catalog;
 if not found then return; end if;
 select coalesce(enabled,false) into v_enabled from private.catalog_video_r2_preferences where catalog_material_id=p_catalog;
 v_enabled:=coalesce(v_enabled,false);
 v_link:=case when exists(select 1 from private.catalog_video_r2_uses where catalog_material_id=p_catalog) then 'r2' else 'drive' end;
 select c.* into v_copy from private.catalog_video_r2_copies c
  where c.state<>'deleted' and (c.requested_by_catalog=p_catalog or c.id in (select copy_id from private.catalog_video_r2_uses where catalog_material_id=p_catalog))
  order by (c.id in (select copy_id from private.catalog_video_r2_uses where catalog_material_id=p_catalog)) desc,(c.state='ready') desc,c.created_at desc limit 1;
 v_reason:=coalesce(p_reason,case when v_copy.id is not null and v_copy.state in ('planned','uploading','verifying','failed') then v_copy.last_error else null end);
 insert into public.team_catalog_video_r2_signals(catalog_material_id,team_id,enabled,link_kind,copy_state,reason,last_successful_update_at)
 values(p_catalog,m.team_id,v_enabled,v_link,v_copy.state,v_reason,case when p_touch_update then clock_timestamp() else null end)
 on conflict(catalog_material_id) do update set enabled=excluded.enabled,link_kind=excluded.link_kind,copy_state=excluded.copy_state,reason=excluded.reason,
  last_successful_update_at=case when p_touch_update then clock_timestamp() else public.team_catalog_video_r2_signals.last_successful_update_at end,
  revision=public.team_catalog_video_r2_signals.revision+1,updated_at=clock_timestamp();
end $$;

create function private.catalog_video_r2_team_used_bytes(p_team uuid) returns bigint language sql stable security definer set search_path='' as $$
 select coalesce(sum(size_bytes),0)::bigint from private.catalog_video_r2_copies where team_id=p_team and state in ('planned','uploading','verifying','ready','retiring')
$$;

create function private.catalog_video_r2_copy_json(c private.catalog_video_r2_copies) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('state',c.state,'readyAt',c.ready_at,'fullHashVerified',c.full_hash_verified)
$$;

-- User-facing RPCs (service role calls them with the proven actor) ----------

create function public.service_catalog_video_r2_availability(p_actor uuid,p_team uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype; manage boolean;
begin
 if p_actor is null or p_team is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 manage:=private.can(p_team,'manage_metadata',p_actor);
 if not cfg.enabled or cfg.public_origin is null then return jsonb_build_object('available',false,'reason','VIDEO_R2_DISABLED','canManage',manage,'contractVersion',1); end if;
 if cfg.policy_confirmed_at is null then return jsonb_build_object('available',false,'reason','VIDEO_R2_POLICY_PENDING','canManage',manage,'contractVersion',1); end if;
 return jsonb_build_object('available',true,'canManage',manage,'contractVersion',1,'publicOrigin',cfg.public_origin);
end $$;

create function public.service_catalog_video_r2_set_preference(p_actor uuid,p_catalog uuid,p_enabled boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; pref private.catalog_video_r2_preferences%rowtype; cfg private.catalog_video_r2_config%rowtype;
begin
 if p_actor is null or p_catalog is null or p_enabled is null then raise exception 'INVALID_INPUT'; end if;
 select * into m from public.team_materials where id=p_catalog;
 if not found or not exists(select 1 from public.team_product_catalogs where material_id=p_catalog) then raise exception 'NOT_FOUND'; end if;
 if not private.can(m.team_id,'manage_metadata',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 if p_enabled and (not cfg.enabled or cfg.public_origin is null) then raise exception 'VIDEO_R2_DISABLED'; end if;
 if p_enabled and cfg.policy_confirmed_at is null then raise exception 'VIDEO_R2_POLICY_PENDING'; end if;
 insert into private.catalog_video_r2_preferences(catalog_material_id,team_id,enabled,configured_by) values(p_catalog,m.team_id,p_enabled,p_actor)
 on conflict(catalog_material_id) do update set enabled=excluded.enabled,revision=private.catalog_video_r2_preferences.revision+1,configured_by=excluded.configured_by,updated_at=clock_timestamp()
 returning * into pref;
 perform private.catalog_video_r2_journal_write(m.team_id,null,p_catalog,null,p_actor,'configured',case when p_enabled then null else 'VIDEO_R2_DISABLED' end);
 perform private.catalog_video_r2_signal(p_catalog);
 return jsonb_build_object('enabled',pref.enabled,'revision',pref.revision,'updatedAt',pref.updated_at);
end $$;

create function public.service_catalog_video_r2_state(p_actor uuid,p_catalog uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; s public.team_catalog_video_r2_signals%rowtype; cfg private.catalog_video_r2_config%rowtype; v_copy private.catalog_video_r2_copies%rowtype; pref private.catalog_video_r2_preferences%rowtype;
begin
 if p_actor is null or p_catalog is null then raise exception 'INVALID_INPUT'; end if;
 select * into m from public.team_materials where id=p_catalog;
 if not found then raise exception 'NOT_FOUND'; end if;
 if not private.can(m.team_id,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 select * into pref from private.catalog_video_r2_preferences where catalog_material_id=p_catalog;
 select * into s from public.team_catalog_video_r2_signals where catalog_material_id=p_catalog;
 select c.* into v_copy from private.catalog_video_r2_copies c
  where c.state<>'deleted' and (c.requested_by_catalog=p_catalog or c.id in (select copy_id from private.catalog_video_r2_uses where catalog_material_id=p_catalog))
  order by (c.id in (select copy_id from private.catalog_video_r2_uses where catalog_material_id=p_catalog)) desc,(c.state='ready') desc,c.created_at desc limit 1;
 return jsonb_build_object(
  'catalogMaterialId',p_catalog,
  'enabled',coalesce(pref.enabled,false),
  'link',coalesce(s.link_kind,'drive'),
  'lastSuccessfulUpdateAt',s.last_successful_update_at,
  'copy',case when v_copy.id is null then null else private.catalog_video_r2_copy_json(v_copy) end,
  'reason',s.reason,
  'usedBytes',private.catalog_video_r2_team_used_bytes(m.team_id),
  'quotaBytes',cfg.team_quota_bytes,
  'canManage',private.can(m.team_id,'manage_metadata',p_actor),
  'revision',coalesce(s.revision,0));
end $$;

create function public.service_catalog_video_r2_usage(p_actor uuid,p_team uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype;
begin
 if p_actor is null or p_team is null or not private.can(p_team,'view',p_actor) then raise exception 'PERMISSION_DENIED' using errcode='42501'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 return jsonb_build_object(
  'usedBytes',private.catalog_video_r2_team_used_bytes(p_team),
  'quotaBytes',cfg.team_quota_bytes,
  'readyCopies',(select count(*) from private.catalog_video_r2_copies where team_id=p_team and state='ready'),
  'retiringCopies',(select count(*) from private.catalog_video_r2_copies where team_id=p_team and state='retiring'),
  'enabledCatalogs',(select count(*) from private.catalog_video_r2_preferences where team_id=p_team and enabled));
end $$;

-- Create-path option: the durable create intent applies it with the creating
-- actor's permission; a launch applies it with the executing actor's (R19).
create function public.service_catalog_video_r2_apply_create_option(p_actor uuid,p_catalog uuid,p_enabled boolean) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not p_enabled then return jsonb_build_object('enabled',false,'revision',0,'updatedAt',clock_timestamp()); end if;
 return public.service_catalog_video_r2_set_preference(p_actor,p_catalog,true);
end $$;

-- Hot path: one call per video source. Never raises for a missing copy; the
-- caller falls back to Drive on anything but a ready copy (FR-006).
create function public.service_catalog_video_r2_resolve(p_catalog uuid,p_source_material uuid,p_source_version text,p_size_bytes bigint,p_mime text,p_md5 text,p_job uuid default null,p_team uuid default null,p_assume_enabled boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; pref private.catalog_video_r2_preferences%rowtype; cfg private.catalog_video_r2_config%rowtype; c private.catalog_video_r2_copies%rowtype; reason text; v_catalog uuid:=p_catalog;
begin
 if p_source_material is null or p_source_version is null or length(p_source_version) not between 1 and 256 then raise exception 'INVALID_INPUT'; end if;
 if v_catalog is null and p_job is not null then select catalog_material_id into v_catalog from private.catalog_video_publication_jobs where id=p_job; end if;
 if v_catalog is not null then
  select * into pref from private.catalog_video_r2_preferences where catalog_material_id=v_catalog;
  if not found or not pref.enabled then return jsonb_build_object('enabled',false); end if;
 elsif p_team is not null and p_assume_enabled then
  -- Pre-creation scope (the catalog material does not exist yet): the create
  -- request itself carries the option; the preference is written on registration.
  pref.team_id:=p_team; pref.enabled:=true;
 else
  return jsonb_build_object('enabled',false);
 end if;
 select * into m from public.team_materials where id=p_source_material and team_id=pref.team_id;
 if not found then if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog,'VIDEO_R2_SOURCE_UNAVAILABLE'); end if; return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_SOURCE_UNAVAILABLE'); end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 if not cfg.enabled or cfg.public_origin is null then if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog,'VIDEO_R2_DISABLED'); end if; return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_DISABLED'); end if;
 if cfg.policy_confirmed_at is null then if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog,'VIDEO_R2_POLICY_PENDING'); end if; return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_POLICY_PENDING'); end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2:'||pref.team_id::text,0));
 select * into c from private.catalog_video_r2_copies where team_id=pref.team_id and source_version=p_source_version and state not in ('deleted','failed') for update;
 if found then
  if c.requested_by_catalog is null then update private.catalog_video_r2_copies set requested_by_catalog=v_catalog where id=c.id; end if;
  if c.state='ready' then
   if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog); end if;
   return jsonb_build_object('enabled',true,'url',cfg.public_origin||'/'||c.object_key,'copyId',c.id,'state',c.state);
  end if;
  if c.state='retiring' then
   -- A catalog wants it again before deletion: keep it (R7).
   update private.catalog_video_r2_copies set state='ready',retire_after=null,retire_reason=null where id=c.id;
   perform private.catalog_video_r2_journal_write(c.team_id,c.id,v_catalog,c.source_material_id,null,'ready',null,'r2',null,c.size_bytes,null,c.full_hash_verified);
   if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog); end if;
   return jsonb_build_object('enabled',true,'url',cfg.public_origin||'/'||c.object_key,'copyId',c.id,'state','ready');
  end if;
  if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog); end if;
  return jsonb_build_object('enabled',true,'url',null,'copyId',c.id,'state',c.state,'reason',c.last_error);
 end if;
 reason:=case
  when p_mime is distinct from 'video/mp4' then 'VIDEO_R2_UNSUPPORTED_FORMAT'
  when p_size_bytes is null or p_size_bytes<=0 then 'VIDEO_R2_SOURCE_UNAVAILABLE'
  when p_size_bytes>cfg.max_object_bytes then 'TOO_LARGE'
  when private.catalog_video_r2_team_used_bytes(pref.team_id)+p_size_bytes>cfg.team_quota_bytes then 'VIDEO_R2_QUOTA_EXCEEDED'
  else null end;
 if reason is not null then
  perform private.catalog_video_r2_journal_write(pref.team_id,null,v_catalog,p_source_material,null,'failed',reason,'drive',null,p_size_bytes);
  if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog,reason); end if;
  return jsonb_build_object('enabled',true,'url',null,'reason',reason);
 end if;
 insert into private.catalog_video_r2_copies(team_id,source_material_id,requested_by_catalog,source_version,size_bytes,source_md5,part_bytes)
 values(pref.team_id,p_source_material,v_catalog,p_source_version,p_size_bytes,case when p_md5 ~ '^[0-9a-fA-F]{32}$' then lower(p_md5) else null end,cfg.part_bytes) returning * into c;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,v_catalog,p_source_material,null,'planned',null,'drive',null,p_size_bytes);
 if v_catalog is not null then perform private.catalog_video_r2_signal(v_catalog); end if;
 return jsonb_build_object('enabled',true,'url',null,'copyId',c.id,'state','planned');
end $$;

-- Worker RPCs ---------------------------------------------------------------

create function public.service_catalog_video_r2_claim(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; cfg private.catalog_video_r2_config%rowtype; m public.team_materials%rowtype; conn public.team_drive_connections%rowtype; at timestamptz:=clock_timestamp();
begin
 if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 if not cfg.enabled then return null; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2-claim',0));
 select * into c from private.catalog_video_r2_copies where state in ('planned','uploading','verifying') and next_attempt_at<=at and (lease_until is null or lease_until<=at)
  order by next_attempt_at,created_at limit 1 for update skip locked;
 if not found then return null; end if;
 if c.attempts>=cfg.max_claim_attempts then
  update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_INTERRUPTED',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_INTERRUPTED');
  if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
  return null;
 end if;
 select * into m from public.team_materials where id=c.source_material_id and lifecycle='active';
 if found then select * into conn from public.team_drive_connections where id=m.connection_id and state='connected'; end if;
 if m.id is null or conn.id is null or m.drive_file_id is null then
  update private.catalog_video_r2_copies set state='failed',last_error='VIDEO_R2_SOURCE_UNAVAILABLE',lease_owner=null,lease_until=null,fence=fence+1 where id=c.id;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed','VIDEO_R2_SOURCE_UNAVAILABLE');
  if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
  return null;
 end if;
 update private.catalog_video_r2_copies set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1,attempts=attempts+1 where id=c.id returning * into c;
 return jsonb_build_object(
  'copyId',c.id,'teamId',c.team_id,'fence',c.fence,'state',c.state,'objectKey',c.object_key,'sizeBytes',c.size_bytes,'mime',c.mime,'partBytes',c.part_bytes,
  'sourceMd5',c.source_md5,'uploadId',c.upload_id,'sourceVersion',c.source_version,'attempts',c.attempts,
  'catalogMaterialId',c.requested_by_catalog,'sourceMaterialId',c.source_material_id,'connectionId',conn.id,'credentialId',conn.credential_id,
  'rootFolderId',conn.root_folder_id,'fileId',m.drive_file_id,'resourceKey',m.resource_key,'publicOrigin',cfg.public_origin,
  'parts',coalesce((select jsonb_agg(jsonb_build_object('partNumber',p.part_number,'sizeBytes',p.size_bytes,'sha256',p.sha256,'etag',p.etag,'verifiedBy',p.verified_by) order by p.part_number) from private.catalog_video_r2_parts p where p.copy_id=c.id),'[]'::jsonb));
end $$;

create function public.service_catalog_video_r2_renew(p_copy uuid,p_worker text,p_fence bigint) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_video_r2_copies set lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state in ('planned','uploading','verifying');
 return found;
end $$;

create function public.service_catalog_video_r2_begin_upload(p_copy uuid,p_worker text,p_fence bigint,p_upload_id text) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype;
begin
 if p_upload_id is null or length(p_upload_id) not between 1 and 1024 then raise exception 'INVALID_INPUT'; end if;
 update private.catalog_video_r2_copies set state='uploading',upload_id=p_upload_id,lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy and lease_owner=p_worker and fence=p_fence and state in ('planned','uploading') returning * into c;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'uploading',null,null,null,c.size_bytes);
 if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
end $$;

create function public.service_catalog_video_r2_part(p_copy uuid,p_worker text,p_fence bigint,p_part integer,p_size integer,p_sha256 text,p_etag text,p_verified_by text,p_duration_ms bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype;
begin
 if p_verified_by not in ('provider_checksum','readback') then raise exception 'INVALID_INPUT'; end if;
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state='uploading' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 insert into private.catalog_video_r2_parts(copy_id,part_number,size_bytes,sha256,etag,verified_by) values(p_copy,p_part,p_size,lower(p_sha256),p_etag,p_verified_by)
 on conflict(copy_id,part_number) do update set size_bytes=excluded.size_bytes,sha256=excluded.sha256,etag=excluded.etag,verified_by=excluded.verified_by,verified_at=clock_timestamp();
 update private.catalog_video_r2_copies set lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'part_verified',null,null,p_verified_by,p_size,p_duration_ms);
end $$;

create function public.service_catalog_video_r2_verifying(p_copy uuid,p_worker text,p_fence bigint) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; n integer; total bigint;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and lease_until>clock_timestamp() and state in ('uploading','verifying') for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 select count(*),coalesce(sum(size_bytes),0),coalesce(max(part_number),0) into n,total,n from private.catalog_video_r2_parts where copy_id=p_copy;
 if total<>c.size_bytes or (select count(*) from private.catalog_video_r2_parts where copy_id=p_copy)<>(select coalesce(max(part_number),0) from private.catalog_video_r2_parts where copy_id=p_copy) then raise exception 'VIDEO_R2_CHECKSUM_MISMATCH'; end if;
 update private.catalog_video_r2_copies set state='verifying',lease_until=clock_timestamp()+interval '90 seconds' where id=p_copy;
 if c.state<>'verifying' then perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'verifying',null,null,null,c.size_bytes); end if;
end $$;

create function public.service_catalog_video_r2_ready(p_copy uuid,p_worker text,p_fence bigint,p_full_hash_verified boolean,p_duration_ms bigint default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype;
begin
 update private.catalog_video_r2_copies set state='ready',ready_at=clock_timestamp(),full_hash_verified=coalesce(p_full_hash_verified,false),upload_id=null,lease_owner=null,lease_until=null,last_error=null,next_attempt_at=clock_timestamp()
  where id=p_copy and lease_owner=p_worker and fence=p_fence and state='verifying' returning * into c;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'ready',null,'r2',null,c.size_bytes,p_duration_ms,c.full_hash_verified);
 if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
end $$;

-- The invocation budget ran out mid-copy: keep the verified parts, hand the lease back (FR-014).
create function public.service_catalog_video_r2_yield(p_copy uuid,p_worker text,p_fence bigint) returns void language plpgsql security definer set search_path='' as $$
begin
 update private.catalog_video_r2_copies set lease_owner=null,lease_until=null,next_attempt_at=clock_timestamp() where id=p_copy and lease_owner=p_worker and fence=p_fence and state in ('planned','uploading','verifying');
 if not found then raise exception 'LEASE_MISMATCH'; end if;
end $$;

-- Source identity as the shared `catalogPublicationSourceIdentity` computes it
-- (content-v1 from checksum/mime/size, strict-v1 from the Drive revision), for
-- the legacy updater path that writes stored links without a live Drive read.
create function private.catalog_video_r2_source_identity(m public.team_materials) returns text language plpgsql immutable set search_path='' as $$
declare content boolean; fields text[]; canonical text:=''; f text; mode text;
begin
 if m.id is null or m.connection_id is null or m.drive_file_id is null or m.drive_file_id !~ '^[A-Za-z0-9_-]{1,255}$' then return null; end if;
 content:=m.checksum ~* '^(?:[a-f0-9]{32}|[a-f0-9]{64})$' and m.mime_type ~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$' and length(m.mime_type)<=128 and m.size_bytes is not null and m.size_bytes>=0;
 mode:=case when content then 'content-v1' else 'strict-v1' end;
 if not content and (m.drive_version is null or m.drive_version !~ '^[A-Za-z0-9._:-]{1,128}$') then return null; end if;
 fields:=case when content then array[mode,lower(m.id::text),lower(m.connection_id::text),m.drive_file_id,lower(m.checksum),lower(m.mime_type),m.size_bytes::text] else array[mode,lower(m.id::text),lower(m.connection_id::text),m.drive_file_id,m.drive_version] end;
 foreach f in array fields loop canonical:=canonical||octet_length(f)::text||':'||f; end loop;
 return mode||':'||encode(extensions.digest(canonical,'sha256'),'hex');
end $$;

-- Legacy updater (no publication job): keep or plan the copy of the catalog's
-- in-use video from the indexed material row; never a live Drive read here.
create function public.service_catalog_video_r2_resolve_current(p_catalog uuid,p_source_material uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare pref private.catalog_video_r2_preferences%rowtype; cat public.team_product_catalogs%rowtype; src uuid; m public.team_materials%rowtype; version text;
begin
 if p_catalog is null then raise exception 'INVALID_INPUT'; end if;
 select * into pref from private.catalog_video_r2_preferences where catalog_material_id=p_catalog;
 if not found or not pref.enabled then return jsonb_build_object('enabled',false); end if;
 src:=p_source_material;
 if src is null then
  select * into cat from public.team_product_catalogs where material_id=p_catalog;
  if cat.material_id is null then return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_SOURCE_UNAVAILABLE'); end if;
  select copy.material_id into src from public.team_catalog_restitch_copies copy where copy.catalog_material_id=p_catalog and copy.team_id=cat.team_id and copy.role='in_use' and cat.current_video_link is not null and copy.shared_link=cat.current_video_link limit 1;
  src:=coalesce(src,cat.video_material_id);
 end if;
 select * into m from public.team_materials where id=src and team_id=pref.team_id and lifecycle='active';
 if m.id is null then perform private.catalog_video_r2_signal(p_catalog,'VIDEO_R2_SOURCE_UNAVAILABLE'); return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_SOURCE_UNAVAILABLE'); end if;
 version:=private.catalog_video_r2_source_identity(m);
 if version is null then perform private.catalog_video_r2_signal(p_catalog,'VIDEO_R2_SOURCE_UNAVAILABLE'); return jsonb_build_object('enabled',true,'url',null,'reason','VIDEO_R2_SOURCE_UNAVAILABLE'); end if;
 return public.service_catalog_video_r2_resolve(p_catalog,m.id,version,m.size_bytes,m.mime_type,m.checksum)||jsonb_build_object('sourceMaterialId',m.id,'sourceVersion',version);
end $$;

-- A failed attempt: terminal failures tombstone the object (and the multipart
-- upload) so the sweep can clean up; transient ones back off and keep the
-- verified parts for the next claim (FR-014).
create function public.service_catalog_video_r2_release(p_copy uuid,p_worker text,p_fence bigint,p_code text,p_terminal boolean) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; backoff interval;
begin
 if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,95}$' then raise exception 'INVALID_INPUT'; end if;
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and state in ('planned','uploading','verifying') for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 if p_terminal then
  update private.catalog_video_r2_copies set state='failed',last_error=p_code,lease_owner=null,lease_until=null,fence=fence+1 where id=p_copy;
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(c.team_id,c.id,c.object_key,c.upload_id,'failed_upload') on conflict(object_key) do nothing;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'failed',p_code);
 else
  backoff:=make_interval(secs=>least(900,30*power(2,least(c.attempts,5))));
  update private.catalog_video_r2_copies set last_error=p_code,lease_owner=null,lease_until=null,next_attempt_at=clock_timestamp()+backoff where id=p_copy;
 end if;
 if c.requested_by_catalog is not null then perform private.catalog_video_r2_signal(c.requested_by_catalog); end if;
end $$;

-- Set-replace of a catalog's uses after a confirmed catalog write (M8/R7).
create function public.service_catalog_video_r2_confirm_use(p_catalog uuid,p_link_kind text,p_uses jsonb default '[]'::jsonb,p_job uuid default null) returns void language plpgsql security definer set search_path='' as $$
declare m public.team_materials%rowtype; item jsonb; c private.catalog_video_r2_copies%rowtype; previous uuid[]; freed uuid; cfg private.catalog_video_r2_config%rowtype; v_catalog uuid:=p_catalog;
begin
 if v_catalog is null and p_job is not null then select catalog_material_id into v_catalog from private.catalog_video_publication_jobs where id=p_job; end if;
 if v_catalog is null or p_link_kind not in ('drive','r2') or jsonb_typeof(p_uses) is distinct from 'array' or jsonb_array_length(p_uses)>400 then raise exception 'INVALID_INPUT'; end if;
 select * into m from public.team_materials where id=v_catalog;
 if not found then raise exception 'NOT_FOUND'; end if;
 -- A catalog that never had the option leaves no trace here (SC-001).
 if jsonb_array_length(p_uses)=0 and not exists(select 1 from private.catalog_video_r2_preferences where catalog_material_id=v_catalog) and not exists(select 1 from private.catalog_video_r2_uses where catalog_material_id=v_catalog) then return; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2:'||m.team_id::text,0));
 select coalesce(array_agg(distinct copy_id),'{}') into previous from private.catalog_video_r2_uses where catalog_material_id=v_catalog;
 if p_link_kind='r2' then
  for item in select value from jsonb_array_elements(p_uses) loop
   if item->>'copyId' is not null then
    select * into c from private.catalog_video_r2_copies where id=(item->>'copyId')::uuid and team_id=m.team_id and source_material_id=(item->>'sourceMaterialId')::uuid for update;
   else
    select * into c from private.catalog_video_r2_copies where team_id=m.team_id and source_material_id=(item->>'sourceMaterialId')::uuid and source_version=item->>'sourceVersion' and state not in ('deleted','failed') for update;
   end if;
   if not found or c.state not in ('ready','retiring') then raise exception 'VIDEO_R2_CATALOG_WRITE_FAILED'; end if;
   if c.state='retiring' then
    update private.catalog_video_r2_copies set state='ready',retire_after=null,retire_reason=null where id=c.id;
    perform private.catalog_video_r2_journal_write(c.team_id,c.id,v_catalog,c.source_material_id,null,'ready',null,'r2',null,c.size_bytes,null,c.full_hash_verified);
   end if;
   insert into private.catalog_video_r2_uses(catalog_material_id,source_material_id,copy_id,team_id) values(v_catalog,c.source_material_id,c.id,m.team_id)
   on conflict(catalog_material_id,source_material_id) do update set copy_id=excluded.copy_id,confirmed_at=clock_timestamp();
  end loop;
 end if;
 -- Mark the reason before the delete so the use trigger retires with it.
 update private.catalog_video_r2_copies set retire_reason=case when p_link_kind='drive' then 'disabled' else 'replaced' end
  where id=any(previous) and state='ready' and (p_link_kind='drive' or not exists(select 1 from private.catalog_video_r2_uses u where u.catalog_material_id=v_catalog and u.copy_id=catalog_video_r2_copies.id and exists(select 1 from jsonb_array_elements(p_uses) x where (x->>'sourceMaterialId')::uuid=u.source_material_id)));
 delete from private.catalog_video_r2_uses u where u.catalog_material_id=v_catalog and (p_link_kind='drive' or not exists(select 1 from jsonb_array_elements(p_uses) x where (x->>'sourceMaterialId')::uuid=u.source_material_id));
 -- A use replaced in place (same source, new copy) never fires the delete trigger: retire the freed copies here.
 for freed in select unnest(previous) loop
  if not exists(select 1 from private.catalog_video_r2_uses where copy_id=freed) then
   select * into c from private.catalog_video_r2_copies where id=freed and state='ready' for update;
   if found then
    update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason=coalesce(c.retire_reason,case when p_link_kind='drive' then 'disabled' else 'replaced' end),fence=fence+1 where id=c.id;
    perform private.catalog_video_r2_journal_write(c.team_id,c.id,v_catalog,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
   end if;
  end if;
 end loop;
 perform private.catalog_video_r2_journal_write(m.team_id,null,v_catalog,null,null,'confirmed',null,p_link_kind);
 perform private.catalog_video_r2_signal(v_catalog,null,true);
end $$;

-- When the last use of a ready copy disappears (set-replace, catalog deletion
-- cascade), the copy becomes a deletion candidate after the grace window.
create function private.catalog_video_r2_use_removed() returns trigger language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; cfg private.catalog_video_r2_config%rowtype;
begin
 if exists(select 1 from private.catalog_video_r2_uses where copy_id=old.copy_id) then return old; end if;
 select * into c from private.catalog_video_r2_copies where id=old.copy_id and state='ready' for update;
 if not found then return old; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason=coalesce(c.retire_reason,'catalog_deleted'),fence=fence+1 where id=c.id;
 perform private.catalog_video_r2_journal_write(c.team_id,c.id,old.catalog_material_id,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
 return old;
end $$;
create trigger catalog_video_r2_use_removed after delete on private.catalog_video_r2_uses for each row execute function private.catalog_video_r2_use_removed();

-- Ready copies nobody uses (a job that planned them never confirmed) retire
-- after the grace window; a late confirm_use revives a retiring copy.
create function public.service_catalog_video_r2_retire_orphans() returns integer language plpgsql security definer set search_path='' as $$
declare cfg private.catalog_video_r2_config%rowtype; n integer:=0; c record;
begin
 select * into cfg from private.catalog_video_r2_config where singleton;
 for c in select * from private.catalog_video_r2_copies where state='ready' and ready_at<clock_timestamp()-cfg.grace_interval and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id) for update skip locked loop
  update private.catalog_video_r2_copies set state='retiring',retire_after=clock_timestamp()+cfg.grace_interval,retire_reason='replaced',fence=fence+1 where id=c.id;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'retiring',null,null,null,c.size_bytes);
  n:=n+1;
 end loop;
 return n;
end $$;

create function public.service_catalog_video_r2_claim_retire(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype; cfg private.catalog_video_r2_config%rowtype; at timestamptz:=clock_timestamp();
begin
 if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2-retire',0));
 select * into c from private.catalog_video_r2_copies where state='retiring' and retire_after<=at and next_attempt_at<=at and (lease_until is null or lease_until<=at)
  and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=catalog_video_r2_copies.id) order by retire_after limit 1 for update skip locked;
 if not found then return null; end if;
 update private.catalog_video_r2_copies set lease_owner=p_worker,lease_until=at+interval '90 seconds',fence=fence+1,attempts=attempts+1 where id=c.id returning * into c;
 return jsonb_build_object('copyId',c.id,'teamId',c.team_id,'fence',c.fence,'objectKey',c.object_key,'publicOrigin',cfg.public_origin,'reason',coalesce(c.retire_reason,'replaced'));
end $$;

create function public.service_catalog_video_r2_mark_deleted(p_copy uuid,p_worker text,p_fence bigint,p_success boolean,p_code text default null) returns void language plpgsql security definer set search_path='' as $$
declare c private.catalog_video_r2_copies%rowtype;
begin
 select * into c from private.catalog_video_r2_copies where id=p_copy and lease_owner=p_worker and fence=p_fence and state='retiring' for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 if p_success then
  update private.catalog_video_r2_copies set state='deleted',deleted_at=clock_timestamp(),lease_owner=null,lease_until=null,last_error=null where id=p_copy;
  perform private.catalog_video_r2_journal_write(c.team_id,c.id,c.requested_by_catalog,c.source_material_id,null,'deleted',null,null,null,c.size_bytes);
 else
  update private.catalog_video_r2_copies set lease_owner=null,lease_until=null,last_error=coalesce(p_code,'VIDEO_R2_CLEANUP_PARTIAL'),next_attempt_at=clock_timestamp()+interval '15 minutes' where id=p_copy;
 end if;
end $$;

create function public.service_catalog_video_r2_claim_purge(p_worker text) returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.catalog_video_r2_purges%rowtype; cfg private.catalog_video_r2_config%rowtype; at timestamptz:=clock_timestamp();
begin
 if p_worker is null or length(p_worker) not between 8 and 200 then raise exception 'INVALID_INPUT'; end if;
 select * into cfg from private.catalog_video_r2_config where singleton;
 perform pg_advisory_xact_lock(hashtextextended('catalog-video-r2-purge',0));
 select * into q from private.catalog_video_r2_purges where purged_at is null and next_attempt_at<=at and attempts<64 and (lease_until is null or lease_until<=at) order by next_attempt_at limit 1 for update skip locked;
 if not found then return null; end if;
 update private.catalog_video_r2_purges set lease_until=at+interval '90 seconds',fence=fence+1,attempts=attempts+1 where id=q.id returning * into q;
 return jsonb_build_object('id',q.id,'fence',q.fence,'objectKey',q.object_key,'uploadId',q.upload_id,'reason',q.reason,'publicOrigin',cfg.public_origin,'teamRef',q.team_ref,'copyRef',q.copy_ref);
end $$;

create function public.service_catalog_video_r2_mark_purged(p_id uuid,p_fence bigint,p_success boolean,p_code text default null) returns void language plpgsql security definer set search_path='' as $$
declare q private.catalog_video_r2_purges%rowtype;
begin
 select * into q from private.catalog_video_r2_purges where id=p_id and fence=p_fence and lease_until>clock_timestamp() for update;
 if not found then raise exception 'LEASE_MISMATCH'; end if;
 if p_success then
  update private.catalog_video_r2_purges set purged_at=clock_timestamp(),lease_until=null,last_error=null where id=p_id;
  perform private.catalog_video_r2_journal_write(q.team_ref,q.copy_ref,null,null,null,'purged');
 else
  update private.catalog_video_r2_purges set lease_until=null,last_error=coalesce(p_code,'VIDEO_R2_CLEANUP_PARTIAL'),next_attempt_at=clock_timestamp()+make_interval(mins=>least(240,5*power(2,least(attempts,6)))) where id=p_id;
 end if;
end $$;

-- Tombstones survive every cascade (R14). The team trigger runs first on team
-- deletion; the copy trigger covers source-material cascades and direct deletes.
create function private.catalog_video_r2_before_team_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) select old.id,id,object_key,upload_id,'team_deleted' from private.catalog_video_r2_copies where team_id=old.id and state<>'deleted' on conflict(object_key) do nothing;
 return old;
end $$;
create trigger catalog_video_r2_before_team_delete before delete on public.teams for each row execute function private.catalog_video_r2_before_team_delete();

create function private.catalog_video_r2_before_copy_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.state<>'deleted' then
  insert into private.catalog_video_r2_purges(team_ref,copy_ref,object_key,upload_id,reason) values(old.team_id,old.id,old.object_key,old.upload_id,coalesce(old.retire_reason,'source_removed')) on conflict(object_key) do nothing;
 end if;
 return old;
end $$;
create trigger catalog_video_r2_before_copy_delete before delete on private.catalog_video_r2_copies for each row execute function private.catalog_video_r2_before_copy_delete();

-- Background invocation through the existing catalog-sync vault entries (R15).
create function private.catalog_video_r2_worker_endpoint() returns text language sql stable security definer set search_path='' as $$
 select case when e ~ '^https?://[^/]+/functions/v1/catalog-video-r2/worker$' then e else null end
 from (select regexp_replace(decrypted_secret,'/catalog-sync/?$','/catalog-video-r2/worker') e from vault.decrypted_secrets where name='wishly_catalog_sync_url' order by created_at desc limit 1) x
$$;

create function private.catalog_video_r2_has_work(p_route text) returns boolean language sql stable security definer set search_path='' as $$
 select case when p_route='claim' then exists(select 1 from private.catalog_video_r2_config where enabled) and exists(select 1 from private.catalog_video_r2_copies where state in ('planned','uploading','verifying') and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()))
  else exists(select 1 from private.catalog_video_r2_copies where state='retiring' and retire_after<=clock_timestamp())
   or exists(select 1 from private.catalog_video_r2_copies c where c.state='ready' and not exists(select 1 from private.catalog_video_r2_uses u where u.copy_id=c.id) and c.ready_at<clock_timestamp()-(select grace_interval from private.catalog_video_r2_config))
   or exists(select 1 from private.catalog_video_r2_purges where purged_at is null and next_attempt_at<=clock_timestamp() and attempts<64) end
$$;

create function private.invoke_catalog_video_r2_worker(p_route text) returns bigint language plpgsql security definer set search_path='' as $$
declare endpoint text; secret text; rid bigint;
begin
 if p_route not in ('claim','sweep') then raise exception 'INVALID_INPUT'; end if;
 if not private.catalog_video_r2_has_work(p_route) then return null; end if;
 endpoint:=private.catalog_video_r2_worker_endpoint();
 select decrypted_secret into secret from vault.decrypted_secrets where name='wishly_catalog_sync_secret' order by created_at desc limit 1;
 if endpoint is null or secret is null or length(secret)<32 then return null; end if;
 select net.http_post(url:=endpoint,headers:=jsonb_build_object('content-type','application/json','x-catalog-sync-secret',secret),body:=jsonb_build_object('route',p_route),timeout_milliseconds:=65000) into rid;
 return rid;
end $$;
select cron.schedule('soty-catalog-video-r2-claim','30 seconds',$cron$select private.invoke_catalog_video_r2_worker('claim')$cron$);
select cron.schedule('soty-catalog-video-r2-sweep','*/5 * * * *',$cron$select private.invoke_catalog_video_r2_worker('sweep')$cron$);

create function public.service_catalog_video_r2_kick(p_route text default 'claim') returns void language plpgsql security definer set search_path='' as $$
begin perform private.invoke_catalog_video_r2_worker(p_route); end $$;

-- Publication link receipt: accept an R2 URL only for a ready copy of exactly
-- this source version while the catalog's option is on (H2 / R2).
drop function public.service_record_catalog_publication_link(uuid,uuid,uuid,text,text);
create function public.service_record_catalog_publication_link(p_job uuid,p_worker uuid,p_material uuid,p_source_version text,p_url text,p_link_kind text default 'drive')returns boolean language plpgsql security definer set search_path='' as $$
declare context jsonb;previous private.catalog_publication_link_receipts%rowtype;v_catalog uuid;
begin
 if p_link_kind not in ('drive','r2') then raise exception 'INVALID_INPUT'; end if;
 context:=public.service_catalog_publication_cells_context(p_job,p_worker);
 if p_link_kind='drive' then
  if context->>'state' is distinct from 'ready' or p_url is null or length(p_url)>8192 or p_url not like 'https://drive.google.com/file/d/%/view?usp=sharing%' or not exists(select 1 from jsonb_array_elements(context->'sources')source(value)where source.value->>'materialId'=p_material::text and source.value->>'sourceVersion'=p_source_version and (p_url='https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing' or left(p_url,length('https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing&resourcekey='))='https://drive.google.com/file/d/'||(source.value->>'fileId')||'/view?usp=sharing&resourcekey='))then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 else
  select catalog_material_id into v_catalog from private.catalog_video_publication_jobs where id=p_job;
  if context->>'state' is distinct from 'ready' or p_url is null or length(p_url)>2048 or v_catalog is null
   or not exists(select 1 from jsonb_array_elements(context->'sources')source(value)where source.value->>'materialId'=p_material::text and source.value->>'sourceVersion'=p_source_version)
   or not exists(select 1 from private.catalog_video_r2_copies c join private.catalog_video_r2_config cfg on cfg.singleton join private.catalog_video_r2_preferences pref on pref.catalog_material_id=v_catalog and pref.enabled and pref.team_id=c.team_id
        where c.state='ready' and c.source_material_id=p_material and c.source_version=p_source_version and cfg.public_origin is not null and p_url=cfg.public_origin||'/'||c.object_key)
  then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 end if;
 select * into previous from private.catalog_publication_link_receipts where job_id=p_job and material_id=p_material for update;
 if previous.job_id is not null and (previous.source_version<>p_source_version or previous.url<>p_url)then raise exception 'SOURCE_CHANGED' using errcode='55000';end if;
 insert into private.catalog_publication_link_receipts(job_id,material_id,source_version,url,link_kind,due_verified_at)values(p_job,p_material,p_source_version,p_url,p_link_kind,case when context->>'phase'='due'then clock_timestamp()else null end)
 on conflict(job_id,material_id)do update set due_verified_at=case when context->>'phase'='due'then clock_timestamp()else private.catalog_publication_link_receipts.due_verified_at end;
 return true;
end $$;
revoke all on function public.service_record_catalog_publication_link(uuid,uuid,uuid,text,text,text)from public,anon,authenticated;
grant execute on function public.service_record_catalog_publication_link(uuid,uuid,uuid,text,text,text)to service_role;

-- Analytics projections (031): closed stages and codes, no content.
create view public.analytics_catalog_video_r2_journal with(security_invoker=false) as
select j.seq::text evidence_id,j.team_id,j.copy_id,j.attempt_id,j.intent_id,j.catalog_material_id,j.source_material_id,j.actor_id,
  case when j.stage in ('configured','planned','uploading','part_verified','verifying','ready','confirmed','retiring','deleted','purged','failed') then j.stage else 'unknown' end stage,
  case when j.code is null then null when j.code in ('VIDEO_R2_DISABLED','VIDEO_R2_POLICY_PENDING','VIDEO_R2_NOT_CONFIGURED','VIDEO_R2_SOURCE_UNAVAILABLE','VIDEO_R2_UNSUPPORTED_FORMAT','VIDEO_R2_QUOTA_EXCEEDED','VIDEO_R2_PROVIDER_UNAVAILABLE','VIDEO_R2_PROVIDER_RATE_LIMITED','VIDEO_R2_TIMEOUT','VIDEO_R2_UPLOAD_UNKNOWN','VIDEO_R2_CHECKSUM_MISMATCH','VIDEO_R2_PUBLIC_UNREACHABLE','VIDEO_R2_CATALOG_WRITE_FAILED','VIDEO_R2_CANCELED','VIDEO_R2_INTERRUPTED','VIDEO_R2_CLEANUP_PARTIAL','PERMISSION_DENIED','SOURCE_CHANGED','TOO_LARGE') then j.code else 'UNKNOWN' end code,
  j.link_kind,j.part_verification,j.size_bucket,j.duration_bucket,j.full_hash_verified,j.occurred_at,j.received_at
from private.catalog_video_r2_journal j;
create view public.analytics_catalog_video_r2_copies with(security_invoker=false) as
select c.id copy_id,c.team_id,c.requested_by_catalog catalog_material_id,c.source_material_id,c.state,private.catalog_video_r2_size_bucket(c.size_bytes) size_bucket,c.full_hash_verified,c.attempts,c.last_error,
  c.retire_reason,c.created_at,c.ready_at,c.retire_after,c.deleted_at,(select count(*) from private.catalog_video_r2_uses u where u.copy_id=c.id) use_count,
  (select count(*) from private.catalog_video_r2_parts p where p.copy_id=c.id) parts_verified
from private.catalog_video_r2_copies c;
create view public.analytics_catalog_video_r2_purges with(security_invoker=false) as
select q.id purge_id,q.team_ref team_id,q.copy_ref copy_id,q.reason,q.attempts,q.purged_at is not null purged,q.last_error,q.created_at,q.purged_at,q.next_attempt_at from private.catalog_video_r2_purges q;
create view public.analytics_catalog_video_r2_coverage with(security_invoker=false) as
select schema_version,installed_at,(select enabled from private.catalog_video_r2_config) capture_enabled from private.catalog_video_r2_diagnostic_metadata;
revoke all on public.analytics_catalog_video_r2_journal,public.analytics_catalog_video_r2_copies,public.analytics_catalog_video_r2_purges,public.analytics_catalog_video_r2_coverage from public,anon,authenticated,service_role;
do $$ begin
 if exists(select 1 from pg_roles where rolname='wishly_analytics_ro') then
  grant select on public.analytics_catalog_video_r2_journal,public.analytics_catalog_video_r2_copies,public.analytics_catalog_video_r2_purges,public.analytics_catalog_video_r2_coverage to wishly_analytics_ro;
 end if;
end $$;

-- Grants: nothing for browser roles; service_role may call the public RPCs only.
do $$ declare f record; begin
 for f in select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname like 'service_catalog_video_r2_%') or (n.nspname='private' and p.proname like '%catalog_video_r2%') loop
  execute format('revoke all on function %I.%I(%s) from public,anon,authenticated,service_role',f.nspname,f.proname,f.args);
  if f.nspname='public' then execute format('grant execute on function %I.%I(%s) to service_role',f.nspname,f.proname,f.args); end if;
 end loop;
end $$;

-- The platform's late-reference fence applies to the new metadata too.
do $$ declare t record; begin
 for t in select * from private.task_cleanup_reference_tables() where table_name like '%catalog_video_r2%' loop
  if not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=t.schema_name and c.relname=t.table_name and g.tgname='task_cleanup_reference_fence') then
   execute format('create trigger task_cleanup_reference_fence before insert or update on %I.%I for each row execute function private.guard_task_cleanup_reference()',t.schema_name,t.table_name);
  end if;
 end loop;
end $$;

-- Defense in depth: private metadata also obeys the platform RLS contract.
alter table private.catalog_video_r2_config enable row level security;
alter table private.catalog_video_r2_preferences enable row level security;
alter table private.catalog_video_r2_copies enable row level security;
alter table private.catalog_video_r2_parts enable row level security;
alter table private.catalog_video_r2_uses enable row level security;
alter table private.catalog_video_r2_purges enable row level security;
alter table private.catalog_video_r2_journal enable row level security;
alter table private.catalog_video_r2_diagnostic_metadata enable row level security;
revoke all on private.catalog_video_r2_config,private.catalog_video_r2_preferences,private.catalog_video_r2_copies,private.catalog_video_r2_parts,private.catalog_video_r2_uses,private.catalog_video_r2_purges,private.catalog_video_r2_journal,private.catalog_video_r2_diagnostic_metadata from public,anon,authenticated,service_role;
