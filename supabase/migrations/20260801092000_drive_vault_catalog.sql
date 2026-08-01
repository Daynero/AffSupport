-- Private Google credential custody, one active Drive root, catalog, metadata,
-- transcript state, tombstones, and durable material provenance.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.google_drive_credentials (
  id uuid primary key default gen_random_uuid(),
  connected_by uuid not null,
  google_permission_id text not null,
  google_account_email text not null,
  vault_secret_id uuid not null,
  scope text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint google_drive_credentials_principal_length check (
    char_length(google_permission_id) between 1 and 512
  ),
  constraint google_drive_credentials_email_length check (
    char_length(google_account_email) between 3 and 320
  ),
  constraint google_drive_credentials_scope_check check (
    position('https://www.googleapis.com/auth/drive' in scope) > 0
  )
);

create unique index google_drive_credentials_owner_principal_idx
  on private.google_drive_credentials (connected_by, google_permission_id);

create table private.drive_oauth_transactions (
  state_hash bytea primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null,
  pkce_verifier_secret_id uuid not null,
  request_origin text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint drive_oauth_transactions_state_hash_length check (octet_length(state_hash) = 32),
  constraint drive_oauth_transactions_expiry_check check (expires_at > created_at)
);

create index drive_oauth_transactions_expiry_idx
  on private.drive_oauth_transactions (expires_at)
  where consumed_at is null;

create table public.team_drive_connections (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  credential_id uuid not null references private.google_drive_credentials(id) on delete restrict,
  root_folder_id text not null,
  root_resource_key text,
  root_folder_name text not null,
  drive_id text,
  drive_kind text not null,
  capability_snapshot jsonb not null default '{}'::jsonb,
  capabilities_checked_at timestamptz,
  state text not null default 'pending',
  initial_sync_state text not null default 'not_started',
  change_page_token text,
  last_synced_at timestamptz,
  last_error_code text,
  connected_at timestamptz,
  detached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_drive_connections_root_id_length check (
    char_length(root_folder_id) between 1 and 1024
  ),
  constraint team_drive_connections_root_name_length check (
    char_length(root_folder_name) between 1 and 255
  ),
  constraint team_drive_connections_kind_check check (drive_kind in ('my_drive', 'shared_drive')),
  constraint team_drive_connections_drive_id_check check (
    (drive_kind = 'my_drive' and drive_id is null)
    or (drive_kind = 'shared_drive' and drive_id is not null)
  ),
  constraint team_drive_connections_state_check check (
    state in ('pending', 'connected', 'needs_reauth', 'unavailable', 'detached')
  ),
  constraint team_drive_connections_sync_state_check check (
    initial_sync_state in ('not_started', 'scanning', 'replaying', 'ready', 'failed')
  ),
  constraint team_drive_connections_detached_at_check check (
    (state = 'detached' and detached_at is not null)
    or (state <> 'detached' and detached_at is null)
  )
);

create unique index team_drive_connections_one_active_idx
  on public.team_drive_connections (team_id)
  where state <> 'detached';
create index team_drive_connections_credential_idx
  on public.team_drive_connections (credential_id)
  where state <> 'detached';

create table public.team_materials (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  drive_file_id text not null,
  drive_id text,
  resource_key text,
  parent_folder_id text,
  name text not null,
  mime_type text,
  file_extension text,
  kind text not null,
  shortcut_target_id text,
  shortcut_target_resource_key text,
  category text,
  classification_version integer not null default 1,
  classification_source text not null default 'fallback',
  landing_validation_state text,
  landing_validation_version text,
  landing_validation_fingerprint text,
  size_bytes bigint,
  modified_at timestamptz,
  drive_version text,
  checksum text,
  lifecycle text not null default 'active',
  geo text references public.geo_options(code) on delete restrict,
  language text references public.language_options(code) on delete restrict,
  offer text,
  tags text[] not null default '{}'::text[],
  transcript_text text,
  transcript_ingest_state text not null default 'not_applicable',
  transcript_truncated boolean not null default false,
  transcript_indexed_bytes integer not null default 0,
  transcript_source_version text,
  transcript_source_checksum text,
  transcript_ingested_at timestamptz,
  transcript_error_code text,
  search_tsv tsvector not null default ''::tsvector,
  preview_state text not null default 'pending',
  preview_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  trashed_at timestamptz,
  missing_at timestamptz,
  constraint team_materials_name_length check (char_length(name) between 1 and 1024),
  constraint team_materials_kind_check check (kind in ('file', 'folder', 'shortcut')),
  constraint team_materials_category_check check (
    category is null or category in ('video', 'image', 'archive', 'transcript', 'landing', 'other')
  ),
  constraint team_materials_folder_category_check check (
    (kind = 'folder' and category is null) or kind <> 'folder'
  ),
  constraint team_materials_classification_version_check check (classification_version >= 1),
  constraint team_materials_classification_source_check check (
    classification_source in ('mime', 'extension', 'inspected_landing', 'fallback')
  ),
  constraint team_materials_size_check check (size_bytes is null or size_bytes >= 0),
  constraint team_materials_lifecycle_check check (
    lifecycle in ('active', 'trashed', 'missing')
  ),
  constraint team_materials_offer_length check (offer is null or char_length(offer) <= 160),
  constraint team_materials_tags_count check (cardinality(tags) <= 50),
  constraint team_materials_transcript_state_check check (
    transcript_ingest_state in (
      'not_applicable', 'pending', 'full', 'truncated', 'invalid_encoding', 'unavailable'
    )
  ),
  constraint team_materials_transcript_bytes_check check (
    transcript_indexed_bytes between 0 and 1048576
    and (transcript_text is null or octet_length(transcript_text) <= 1048576)
  ),
  constraint team_materials_transcript_truncated_check check (
    transcript_truncated = (transcript_ingest_state = 'truncated')
  ),
  constraint team_materials_lifecycle_times_check check (
    (lifecycle <> 'trashed' or trashed_at is not null)
    and (lifecycle <> 'missing' or missing_at is not null)
  ),
  unique (team_id, drive_file_id),
  unique (id, team_id)
);

create index team_materials_parent_idx
  on public.team_materials (team_id, parent_folder_id, name)
  where lifecycle = 'active';
create index team_materials_connection_idx
  on public.team_materials (connection_id, lifecycle);
create index team_materials_drive_version_idx
  on public.team_materials (team_id, drive_file_id, drive_version);

create table public.team_material_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  source_material_id uuid not null,
  derivative_material_id uuid not null,
  relation text not null,
  source_name_snapshot text not null,
  tool_id text,
  tool_contract_version integer,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint team_material_links_source_fk
    foreign key (source_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_material_links_derivative_fk
    foreign key (derivative_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_material_links_relation_check check (
    relation in ('processed_from', 'version_of')
  ),
  constraint team_material_links_distinct_check check (
    source_material_id <> derivative_material_id
  ),
  constraint team_material_links_snapshot_length check (
    char_length(source_name_snapshot) between 1 and 1024
  ),
  unique (team_id, source_material_id, derivative_material_id, relation)
);

create unique index team_material_links_one_version_parent_idx
  on public.team_material_links (team_id, derivative_material_id)
  where relation = 'version_of';
create index team_material_links_source_idx
  on public.team_material_links (team_id, source_material_id, relation);

alter table private.google_drive_credentials enable row level security;
alter table private.google_drive_credentials force row level security;
alter table private.drive_oauth_transactions enable row level security;
alter table private.drive_oauth_transactions force row level security;
alter table public.team_drive_connections enable row level security;
alter table public.team_drive_connections force row level security;
alter table public.team_materials enable row level security;
alter table public.team_materials force row level security;
alter table public.team_material_links enable row level security;
alter table public.team_material_links force row level security;

revoke all on table private.google_drive_credentials from public, anon, authenticated;
revoke all on table private.drive_oauth_transactions from public, anon, authenticated;
revoke all on table public.team_drive_connections from public, anon, authenticated;
revoke all on table public.team_materials from public, anon, authenticated;
revoke all on table public.team_material_links from public, anon, authenticated;

comment on schema private is 'Wishly server-only integration authority; not exposed by Data API.';
comment on column public.team_materials.parent_folder_id is
  'Cached catalog parent for display/search only; never authorizes a Drive action.';
comment on column public.team_materials.transcript_text is
  'Bounded searchable transcript text; never publish through Realtime, analytics, audit, or logs.';
