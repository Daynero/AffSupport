-- 057 M1 (T006): the foundation of Soty spaces on R2 (specs/057-r2-workspaces/data-model.md).
--
-- Additive only. A space gets a storage backend fixed at creation; R2 materials are rows of the
-- same team_materials (research R1) without Drive fields; objects, references, usage,
-- reservations, uploads, derivative jobs, purges, reconciliations, a Realtime signal table and a
-- content-free journal are new. Nothing the running production reads changes behaviour for a
-- Drive space: every new trigger on team_materials fires only for rows without a connection.
--
-- Content identity (research R3, 2026-11-28): content_id is SHA-256 over the part size, the
-- length and the part ETags (MD5) R2 reports, so dedup holds within one space only:
-- unique (team_id, content_id) for originals, never across spaces.

-- 1. The backend of a space ----------------------------------------------------------------

alter table public.teams
  add column storage_backend text not null default 'drive',
  add column storage_pilot boolean not null default false,
  add column content_revision bigint not null default 0,
  add column access_epoch bigint not null default 0,
  add column storage_root_material_id uuid;
alter table public.teams
  add constraint teams_storage_backend_check check (storage_backend in ('drive', 'r2')),
  add constraint teams_content_revision_check check (content_revision >= 0),
  add constraint teams_access_epoch_check check (access_epoch >= 0),
  add constraint teams_storage_root_backend_check
    check (storage_root_material_id is null or storage_backend = 'r2');

create function private.teams_storage_backend_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.storage_backend is distinct from old.storage_backend then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger teams_storage_backend_fixed before update of storage_backend on public.teams
  for each row execute function private.teams_storage_backend_fixed();

-- An R2 space never gets a Drive connection, so catalog-sync, the Drive watchers and every
-- connection-joined path never see it (data-model invariant).
create function private.team_drive_connection_backend() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.teams t where t.id = new.team_id and t.storage_backend <> 'drive') then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger team_drive_connections_backend before insert or update of team_id
  on public.team_drive_connections
  for each row execute function private.team_drive_connection_backend();

-- 2. Objects -----------------------------------------------------------------------------

create table public.space_objects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  kind text not null default 'original' check (kind in ('original', 'derivative')),
  content_id text not null check (content_id ~ '^[0-9a-f]{64}$'),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 0 and 107374182400),
  content_type text not null check (char_length(content_type) between 3 and 255),
  r2_key text not null,
  derivative_of uuid,
  recipe_version integer check (recipe_version is null or recipe_version between 1 and 9999),
  variant text check (variant is null or variant in ('row', 'tile', 'full', 'poster', 'sprite')),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  width integer check (width is null or width between 1 and 65535),
  height integer check (height is null or height between 1 and 65535),
  codec text check (codec is null or codec ~ '^[a-z0-9._-]{1,32}$'),
  fps numeric(7, 3) check (fps is null or (fps > 0 and fps <= 1000)),
  state text not null default 'committed' check (state in ('committed', 'purge_pending', 'purged')),
  -- Where the object currently counts (maintained by private.space_object_account only).
  usage_category text check (usage_category is null or usage_category in
    ('materials', 'catalogs', 'process', 'attachments', 'versions', 'trash')),
  usage_shared boolean not null default false,
  created_at timestamptz not null default now(),
  purged_at timestamptz,
  unique (id, team_id),
  constraint space_objects_key_check check (
    (kind = 'original' and derivative_of is null and recipe_version is null and variant is null
      and r2_key = 't/' || team_id::text || '/o/' || content_id)
    or (kind = 'derivative' and derivative_of is not null and recipe_version is not null and variant is not null
      and r2_key ~ ('^t/' || team_id::text || '/d/[0-9a-f]{64}/' || recipe_version::text || '/' || variant || '$'))
  ),
  constraint space_objects_purged_check check ((state = 'purged') = (purged_at is not null)),
  foreign key (derivative_of, team_id) references public.space_objects(id, team_id) on delete cascade
);
create unique index space_objects_content_idx on public.space_objects (team_id, content_id)
  where kind = 'original' and state <> 'purged';
create unique index space_objects_key_idx on public.space_objects (r2_key) where state <> 'purged';
create index space_objects_derivative_idx on public.space_objects (derivative_of) where derivative_of is not null;

-- 3. Materials on R2 ---------------------------------------------------------------------

alter table public.team_materials alter column connection_id drop not null;
alter table public.team_materials alter column drive_file_id drop not null;
alter table public.team_materials
  add column space_object_id uuid,
  add column material_revision bigint not null default 0;
alter table public.team_materials
  add constraint team_materials_material_revision_check check (material_revision >= 0),
  add constraint team_materials_space_object_fk foreign key (space_object_id, team_id)
    references public.space_objects(id, team_id) on delete restrict;
-- A Drive row keeps both Drive fields and no object; an R2 row has neither Drive field and is a
-- folder, a file with its object, or a catalog feed (whose CSV lives in the public bucket).
alter table public.team_materials
  add constraint team_materials_storage_shape_check check (
    (connection_id is not null and drive_file_id is not null and space_object_id is null)
    or (connection_id is null and drive_file_id is null and kind <> 'shortcut' and (
      kind = 'folder'
      or space_object_id is not null
      or companion_kind is not distinct from 'product_catalog'))
  ) not valid;
alter table public.team_materials validate constraint team_materials_storage_shape_check;
create index team_materials_space_object_idx on public.team_materials (space_object_id)
  where space_object_id is not null;
-- One root per R2 space: the only R2 row without a parent.
create unique index team_materials_r2_root_idx on public.team_materials (team_id)
  where connection_id is null and parent_folder_id is null;

-- R2 rows only (a Drive row always has a connection): the space is R2, the parent is an R2
-- folder of the same space named by its uuid, the tree has no cycle, and a user-visible change
-- raises material_revision (FR-040).
create function private.space_material_shape() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_backend text;
  v_parent uuid;
  v_cursor uuid;
  v_depth integer := 0;
begin
  select t.storage_backend into v_backend from public.teams t where t.id = new.team_id;
  if v_backend is distinct from 'r2' then
    raise exception 'STORAGE_BACKEND_MISMATCH' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' and new.team_id is distinct from old.team_id then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if new.parent_folder_id is not null and (tg_op = 'INSERT' or new.parent_folder_id is distinct from old.parent_folder_id) then
    if new.parent_folder_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    v_parent := new.parent_folder_id::uuid;
    if v_parent = new.id then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    -- Moves of folders in one space are serialized, so two crossing moves cannot make a cycle.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('space-tree:' || new.team_id::text, 0));
    if not exists (
      select 1 from public.team_materials p
      where p.id = v_parent and p.team_id = new.team_id and p.kind = 'folder' and p.connection_id is null
    ) then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if new.kind = 'folder' and tg_op = 'UPDATE' then
      v_cursor := v_parent;
      while v_cursor is not null loop
        if v_cursor = new.id then
          raise exception 'INVALID_INPUT' using errcode = '22023';
        end if;
        v_depth := v_depth + 1;
        if v_depth > 1000 then
          raise exception 'INVALID_INPUT' using errcode = '22023';
        end if;
        select case when p.parent_folder_id is null then null else p.parent_folder_id::uuid end
          into v_cursor from public.team_materials p where p.id = v_cursor;
      end loop;
    end if;
  end if;
  if tg_op = 'UPDATE' and (
    new.name is distinct from old.name
    or new.parent_folder_id is distinct from old.parent_folder_id
    or new.lifecycle is distinct from old.lifecycle
    or new.space_object_id is distinct from old.space_object_id
  ) then
    new.material_revision := old.material_revision + 1;
  end if;
  return new;
end;
$$;
create trigger team_materials_space_shape before insert or update on public.team_materials
  for each row when (new.connection_id is null)
  execute function private.space_material_shape();

-- The process-output fence keys on the Drive file id; an R2 row has none and is fenced by its
-- object instead. Same body as 20261206138000 plus the first line.
create or replace function private.fence_process_output_adoption() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare u private.process_upload_ownership%rowtype;
begin
 if new.drive_file_id is null then return new; end if;
 if tg_op='UPDATE' and old.drive_file_id is not distinct from new.drive_file_id then return new;end if;
 insert into private.process_output_identity_fences(file_id) values(new.drive_file_id) on conflict do nothing;
 perform 1 from private.process_output_identity_fences where file_id=new.drive_file_id for update;
 select * into u from private.process_upload_ownership where file_id=new.drive_file_id for update;
 if not found then return new;end if;
 if pg_catalog.current_setting('soty.process_output_catalog_ingest',true)='on' and u.upload_state<>'published'
  and not exists(select 1 from public.team_materials m where m.drive_file_id=new.drive_file_id) then
  return null;
 end if;
 if u.cleanup_mutation_started_at is not null then
  raise exception 'PROCESS_RESULT_UNCERTAIN' using errcode='55000';
 end if;
 return new;
end $function$;

-- 4. References and usage ----------------------------------------------------------------

create table public.space_object_refs (
  object_id uuid not null,
  owner_kind text not null check (owner_kind in ('material', 'task_attachment', 'process_output', 'derivative')),
  owner_id uuid not null,
  team_id uuid not null,
  category text not null check (category in
    ('materials', 'catalogs', 'process', 'attachments', 'versions', 'trash', 'derivative')),
  counted boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (object_id, owner_kind, owner_id),
  foreign key (object_id, team_id) references public.space_objects(id, team_id) on delete cascade,
  constraint space_object_refs_derivative_check check (
    (owner_kind = 'derivative') = (category = 'derivative') and (category <> 'derivative' or not counted)
  )
);
create index space_object_refs_owner_idx on public.space_object_refs (owner_kind, owner_id);
create index space_object_refs_team_idx on public.space_object_refs (team_id, category);

create table public.space_storage_usage (
  team_id uuid not null references public.teams(id) on delete cascade,
  category text not null check (category in ('materials', 'catalogs', 'process', 'attachments', 'versions', 'trash')),
  bytes bigint not null default 0 check (bytes >= 0),
  objects bigint not null default 0 check (objects >= 0),
  shared_bytes bigint not null default 0 check (shared_bytes >= 0 and shared_bytes <= bytes),
  revision bigint not null default 0 check (revision >= 0),
  primary key (team_id, category)
);

-- A delta to one (space, category) row. Not an upsert with the delta as the inserted row: a
-- CHECK is evaluated on the proposed row before ON CONFLICT, so a negative delta would fail.
create function private.space_usage_add(p_team uuid, p_category text, p_bytes bigint, p_objects integer, p_shared bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.space_storage_usage set
    bytes = bytes + p_bytes,
    objects = objects + p_objects,
    shared_bytes = shared_bytes + p_shared,
    revision = revision + 1
  where team_id = p_team and category = p_category;
  if found then return; end if;
  if p_bytes < 0 or p_objects < 0 or p_shared < 0 then
    raise exception 'WRONG_STATE' using errcode = '55000';
  end if;
  insert into public.space_storage_usage as u (team_id, category, bytes, objects, shared_bytes, revision)
  values (p_team, p_category, p_bytes, p_objects, p_shared, 1)
  on conflict (team_id, category) do update set
    bytes = u.bytes + excluded.bytes,
    objects = u.objects + excluded.objects,
    shared_bytes = u.shared_bytes + excluded.shared_bytes,
    revision = u.revision + 1;
end;
$$;

-- An object counts once per space, in the first category of the priority list that a counted
-- reference names; with more than one counted reference its bytes are also shared (FR-047).
create function private.space_object_account(p_object uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.space_objects%rowtype;
  v_category text;
  v_shared boolean;
begin
  select * into o from public.space_objects where id = p_object for update;
  if not found then return; end if;
  select r.category into v_category from public.space_object_refs r
   where r.object_id = p_object and r.counted
   order by array_position(array['materials', 'catalogs', 'process', 'attachments', 'versions', 'trash'], r.category)
   limit 1;
  v_shared := (select count(*) from public.space_object_refs r where r.object_id = p_object and r.counted) > 1;
  if v_category is null then v_shared := false; end if;
  if o.usage_category is not distinct from v_category and o.usage_shared = v_shared then return; end if;
  if o.usage_category is not null then
    perform private.space_usage_add(o.team_id, o.usage_category, -o.byte_size, -1,
      case when o.usage_shared then -o.byte_size else 0 end);
  end if;
  if v_category is not null then
    perform private.space_usage_add(o.team_id, v_category, o.byte_size, 1,
      case when v_shared then o.byte_size else 0 end);
  end if;
  update public.space_objects set usage_category = v_category, usage_shared = v_shared where id = p_object;
end;
$$;

create function private.space_object_refs_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform private.space_object_account(old.object_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.object_id is distinct from old.object_id) then
    perform private.space_object_account(new.object_id);
  end if;
  return null;
end;
$$;
create trigger space_object_refs_account after insert or update or delete on public.space_object_refs
  for each row execute function private.space_object_refs_changed();

-- An object row that goes away takes its counted bytes with it, before its references cascade.
create function private.space_object_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.usage_category is not null then
    perform private.space_usage_add(old.team_id, old.usage_category, -old.byte_size, -1,
      case when old.usage_shared then -old.byte_size else 0 end);
  end if;
  return old;
end;
$$;
create trigger space_objects_removed before delete on public.space_objects
  for each row execute function private.space_object_removed();

-- 5. Pilots ------------------------------------------------------------------------------

create table public.storage_r2_pilots (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_space_bytes bigint not null check (max_space_bytes > 0 and max_space_bytes <= 10995116277760),
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  removed_at timestamptz
);
alter table public.storage_r2_pilots enable row level security;
alter table public.storage_r2_pilots force row level security;
revoke all on table public.storage_r2_pilots from public, anon, authenticated;

create table private.storage_r2_pilot_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  user_id uuid not null,
  action text not null check (action in ('add', 'update', 'remove')),
  max_space_bytes bigint,
  created_at timestamptz not null default now()
);
revoke all on table private.storage_r2_pilot_events from public, anon, authenticated;

create function private.is_storage_r2_pilot_user(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1 from public.storage_r2_pilots p where p.user_id = p_user and p.removed_at is null);
$$;

create function public.is_storage_r2_pilot() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_storage_r2_pilot_user(auth.uid());
$$;

create function public.admin_list_storage_r2_pilots()
returns table (user_id uuid, email text, max_space_bytes text, added_at timestamptz, removed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  return query
  select p.user_id, u.email::text, p.max_space_bytes::text, p.added_at, p.removed_at
  from public.storage_r2_pilots p
  join auth.users u on u.id = p.user_id
  order by p.added_at;
end;
$$;

create function public.admin_add_storage_r2_pilot(p_email text, p_max_bytes bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_target uuid;
  v_existing public.storage_r2_pilots%rowtype;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_max_bytes is null or p_max_bytes <= 0 or p_max_bytes > 10995116277760 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select u.id into v_target from auth.users u
   where lower(u.email) = lower(btrim(coalesce(p_email, ''))) limit 1;
  if v_target is null then
    raise exception 'STORAGE_R2_PILOT_UNKNOWN_EMAIL' using errcode = 'P0002';
  end if;
  select * into v_existing from public.storage_r2_pilots where user_id = v_target for update;
  insert into public.storage_r2_pilots (user_id, max_space_bytes, added_by)
  values (v_target, p_max_bytes, auth.uid())
  on conflict (user_id) do update set max_space_bytes = excluded.max_space_bytes,
    added_by = excluded.added_by, removed_at = null,
    added_at = case when public.storage_r2_pilots.removed_at is null then public.storage_r2_pilots.added_at else now() end;
  insert into private.storage_r2_pilot_events (actor_id, user_id, action, max_space_bytes)
  values (auth.uid(), v_target, case when v_existing.user_id is null or v_existing.removed_at is not null then 'add' else 'update' end, p_max_bytes);
  return v_target;
end;
$$;

-- Removing a pilot never deletes or closes the spaces they created (US11).
create function public.admin_remove_storage_r2_pilot(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  update public.storage_r2_pilots set removed_at = now() where user_id = p_user_id and removed_at is null;
  if not found then return false; end if;
  insert into private.storage_r2_pilot_events (actor_id, user_id, action) values (auth.uid(), p_user_id, 'remove');
  return true;
end;
$$;

-- 6. Reservations, uploads, derivatives, purges, reconciliation ---------------------------

create table public.space_storage_reservations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  operation_id uuid not null unique,
  bytes bigint not null check (bytes between 0 and 107374182400),
  purpose text not null check (purpose in ('upload', 'process_output', 'catalog_generation')),
  state text not null default 'reserved' check (state in ('reserved', 'committed', 'released', 'uncertain')),
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint space_storage_reservations_settled_check check ((state in ('reserved', 'uncertain')) = (settled_at is null))
);
create index space_storage_reservations_open_idx on public.space_storage_reservations (team_id)
  where state in ('reserved', 'uncertain');

create table public.space_uploads (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  reservation_id uuid not null references public.space_storage_reservations(id),
  declared_content_id text not null check (declared_content_id ~ '^[0-9a-f]{64}$'),
  declared_sha256 text check (declared_sha256 is null or declared_sha256 ~ '^[0-9a-f]{64}$'),
  declared_bytes bigint not null check (declared_bytes between 0 and 107374182400),
  part_bytes integer not null check (part_bytes in (16777216, 67108864)),
  part_count integer not null check (part_count between 1 and 10000),
  name text not null check (char_length(name) between 1 and 1024),
  content_type text not null check (char_length(content_type) between 3 and 255),
  parent_material_id uuid references public.team_materials(id) on delete set null,
  r2_upload_id text check (r2_upload_id is null or char_length(r2_upload_id) between 1 and 1024),
  staging_key text not null,
  ingress text not null check (ingress in ('explorer', 'agent_output', 'inbox', 'mobile', 'share_target')),
  actor_id uuid references auth.users(id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  state text not null default 'open' check (state in ('open', 'completing', 'committed', 'aborted', 'expired', 'rejected')),
  result_material_id uuid references public.team_materials(id) on delete set null,
  object_id uuid references public.space_objects(id) on delete set null,
  reject_code text check (reject_code is null or reject_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint space_uploads_staging_key_check check (staging_key = 't/' || team_id::text || '/u/' || id::text),
  unique (team_id, actor_id, idempotency_key)
);
create index space_uploads_open_idx on public.space_uploads (team_id, expires_at) where state in ('open', 'completing');
create trigger task_cleanup_reference_fence before insert or update on public.space_uploads
  for each row execute function private.guard_task_cleanup_reference();

create table public.space_upload_derivatives (
  upload_id uuid not null references public.space_uploads(id) on delete cascade,
  variant text not null check (variant in ('row', 'tile', 'full', 'poster', 'sprite')),
  content_type text not null check (content_type in ('image/webp', 'image/jpeg')),
  bytes integer not null check (bytes between 1 and 2097152),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  staging_key text not null,
  state text not null default 'declared' check (state in ('declared', 'accepted', 'rejected')),
  primary key (upload_id, variant)
);

create table public.space_derivative_jobs (
  object_id uuid not null references public.space_objects(id) on delete cascade,
  recipe_version integer not null check (recipe_version between 1 and 9999),
  team_id uuid not null references public.teams(id) on delete cascade,
  reason text not null check (reason in ('browser_unsupported', 'missing_media_facts', 'client_skipped')),
  state text not null default 'pending_agent' check (state in ('pending_agent', 'claimed', 'ready', 'unsupported', 'failed')),
  claimed_by_device uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 100),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (object_id, recipe_version),
  constraint space_derivative_jobs_lease_check check ((state = 'claimed') = (lease_until is not null))
);
create index space_derivative_jobs_pending_idx on public.space_derivative_jobs (team_id, created_at)
  where state in ('pending_agent', 'claimed');

create table public.space_object_purges (
  object_id uuid primary key references public.space_objects(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  r2_key text not null,
  due_at timestamptz not null,
  reason text not null check (reason in ('trash_expired', 'trash_emptied', 'catalog_deleted', 'space_deleted', 'orphan')),
  state text not null default 'due' check (state in ('due', 'deleted', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 1000),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index space_object_purges_due_idx on public.space_object_purges (due_at) where state = 'due';

create table public.space_storage_reconciliations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  state text not null default 'running' check (state in ('running', 'done', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  listed bigint not null default 0 check (listed >= 0),
  ledger bigint not null default 0 check (ledger >= 0),
  orphans_found bigint not null default 0 check (orphans_found >= 0),
  orphans_deleted bigint not null default 0 check (orphans_deleted >= 0),
  missing bigint not null default 0 check (missing >= 0)
);

-- 7. Realtime signal ---------------------------------------------------------------------

-- Content-free mirror for the existing Realtime channel: the private state is invisible to it.
create table public.team_space_storage_signals (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  kind text not null check (kind in ('content', 'usage', 'derivative')),
  folder_id uuid,
  revision bigint not null check (revision >= 0),
  created_at timestamptz not null default now()
);
create index team_space_storage_signals_team_idx on public.team_space_storage_signals (team_id, created_at);
create trigger task_cleanup_reference_fence before insert or update on public.team_space_storage_signals
  for each row execute function private.guard_task_cleanup_reference();
alter table public.team_space_storage_signals enable row level security;
alter table public.team_space_storage_signals force row level security;
revoke all on public.team_space_storage_signals from public, anon, authenticated, service_role;
grant select (id, team_id, kind, folder_id, revision, created_at) on public.team_space_storage_signals to authenticated;
create policy space_storage_signal_read on public.team_space_storage_signals for select to authenticated
  using (private.can(team_id, 'view', auth.uid()));
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') and not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'team_space_storage_signals') then
    alter publication supabase_realtime add table public.team_space_storage_signals;
  end if;
end $$;

-- Every other new public table is server-only: RLS on, no client grants.
do $$
declare t text;
begin
  foreach t in array array['space_objects', 'space_object_refs', 'space_storage_usage', 'space_storage_reservations',
    'space_uploads', 'space_upload_derivatives', 'space_derivative_jobs', 'space_object_purges',
    'space_storage_reconciliations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- 8. Journal -----------------------------------------------------------------------------

-- One content-free row per stage (T011). Never a name, a path, a bucket key, a URL or a grant.
create table private.space_storage_journal (
  id bigint generated always as identity primary key,
  operation_id uuid not null,
  attempt integer not null check (attempt between 1 and 1000),
  stage text not null check (stage in ('create', 'admit', 'parts', 'complete', 'commit', 'abort', 'mutate',
    'trash_empty', 'read_grant', 'derivative', 'purge', 'reconcile')),
  outcome text not null check (outcome in ('ok', 'rejected', 'failed', 'unknown')),
  code text check (code is null or code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  bytes bigint check (bytes is null or bytes >= 0),
  team_id uuid,
  ingress text check (ingress is null or ingress in ('explorer', 'agent_output', 'inbox', 'mobile', 'share_target')),
  client text not null check (client ~ '^(web|agent|server)/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\+[0-9]{1,6})?$'),
  occurred_at timestamptz not null default clock_timestamp()
);
create index space_storage_journal_operation_idx on private.space_storage_journal (operation_id, occurred_at);
create index space_storage_journal_team_idx on private.space_storage_journal (team_id, occurred_at);
revoke all on table private.space_storage_journal from public, anon, authenticated;

create function public.service_write_space_storage_journal(
  p_operation uuid, p_attempt integer, p_stage text, p_outcome text, p_code text,
  p_bytes bigint, p_team uuid, p_ingress text, p_client text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_operation is null
    or p_attempt is null or p_attempt not between 1 and 1000
    or p_stage is null or p_stage not in ('create', 'admit', 'parts', 'complete', 'commit', 'abort', 'mutate',
      'trash_empty', 'read_grant', 'derivative', 'purge', 'reconcile')
    or p_outcome is null or p_outcome not in ('ok', 'rejected', 'failed', 'unknown')
    or (p_code is not null and p_code !~ '^[A-Z][A-Z0-9_]{0,95}$')
    or (p_bytes is not null and p_bytes < 0)
    or (p_ingress is not null and p_ingress not in ('explorer', 'agent_output', 'inbox', 'mobile', 'share_target'))
    or p_client is null or p_client !~ '^(web|agent|server)/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\+[0-9]{1,6})?$'
  then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  insert into private.space_storage_journal (operation_id, attempt, stage, outcome, code, bytes, team_id, ingress, client)
  values (p_operation, p_attempt, p_stage, p_outcome, p_code, p_bytes, p_team, p_ingress, p_client);
end;
$$;

-- Journal 90 days, signals one day.
create function private.prune_space_storage_history() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_journal integer; v_signals integer;
begin
  delete from private.space_storage_journal where occurred_at < now() - interval '90 days';
  get diagnostics v_journal = row_count;
  delete from public.team_space_storage_signals where created_at < now() - interval '1 day';
  get diagnostics v_signals = row_count;
  return v_journal + v_signals;
end;
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('soty-space-storage-retention', '41 * * * *',
      $cron$select private.prune_space_storage_history()$cron$);
  end if;
end $$;

-- 9. Grants ------------------------------------------------------------------------------

revoke all on function private.teams_storage_backend_fixed(), private.team_drive_connection_backend(),
  private.space_material_shape(), private.space_usage_add(uuid, text, bigint, integer, bigint),
  private.space_object_account(uuid), private.space_object_refs_changed(), private.space_object_removed(),
  private.is_storage_r2_pilot_user(uuid), private.prune_space_storage_history()
  from public, anon, authenticated;
revoke all on function public.is_storage_r2_pilot() from public, anon;
grant execute on function public.is_storage_r2_pilot() to authenticated;
revoke all on function public.admin_list_storage_r2_pilots() from public, anon;
grant execute on function public.admin_list_storage_r2_pilots() to authenticated;
revoke all on function public.admin_add_storage_r2_pilot(text, bigint) from public, anon;
grant execute on function public.admin_add_storage_r2_pilot(text, bigint) to authenticated;
revoke all on function public.admin_remove_storage_r2_pilot(uuid) from public, anon;
grant execute on function public.admin_remove_storage_r2_pilot(uuid) to authenticated;
revoke all on function public.service_write_space_storage_journal(uuid, integer, text, text, text, bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_write_space_storage_journal(uuid, integer, text, text, text, bigint, uuid, text, text)
  to service_role;
