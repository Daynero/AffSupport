-- Idempotent operation sagas, scoped transfer grants, durable catalog work,
-- safe Realtime markers, and append-only audit.

create table public.team_operations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null,
  kind text not null,
  state text not null default 'pending',
  stage text,
  progress smallint not null default 0,
  source_material_id uuid references public.team_materials(id) on delete set null,
  destination_folder_id uuid references public.team_materials(id) on delete set null,
  result_material_id uuid references public.team_materials(id) on delete set null,
  idempotency_key text not null,
  request_nonce text not null,
  reserved_name_key text,
  reservation_expires_at timestamptz,
  reservation_released_at timestamptz,
  bytes_total bigint,
  bytes_completed bigint not null default 0,
  error_code text,
  retryable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_operations_kind_check check (
    kind in (
      'upload', 'download', 'rename', 'move', 'trash', 'restore',
      'content_edit', 'new_version', 'process'
    )
  ),
  constraint team_operations_state_check check (
    state in ('pending', 'running', 'succeeded', 'canceled', 'failed')
  ),
  constraint team_operations_progress_check check (progress between 0 and 100),
  constraint team_operations_idempotency_length check (
    char_length(idempotency_key) between 8 and 200
  ),
  constraint team_operations_nonce_length check (char_length(request_nonce) between 8 and 200),
  constraint team_operations_bytes_check check (
    (bytes_total is null or bytes_total >= 0)
    and bytes_completed >= 0
    and (bytes_total is null or bytes_completed <= bytes_total)
  ),
  constraint team_operations_terminal_time_check check (
    (state in ('succeeded', 'canceled', 'failed') and finished_at is not null)
    or (state in ('pending', 'running') and finished_at is null)
  ),
  constraint team_operations_reservation_check check (
    (reserved_name_key is null and reservation_expires_at is null)
    or (
      reserved_name_key is not null
      and destination_folder_id is not null
      and reservation_expires_at is not null
    )
  ),
  unique (team_id, actor_id, kind, idempotency_key),
  unique (id, team_id)
);

create unique index team_operations_name_reservation_idx
  on public.team_operations (team_id, destination_folder_id, reserved_name_key)
  where reserved_name_key is not null and reservation_released_at is null;
create index team_operations_team_created_idx
  on public.team_operations (team_id, created_at desc);
create index team_operations_active_idx
  on public.team_operations (team_id, state, updated_at)
  where state in ('pending', 'running');
create index team_operations_reservation_expiry_idx
  on public.team_operations (reservation_expires_at)
  where reserved_name_key is not null and reservation_released_at is null;

create table private.team_transfer_grants (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  operation_id uuid references public.team_operations(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null,
  purpose text not null,
  material_id uuid references public.team_materials(id) on delete cascade,
  destination_folder_id uuid references public.team_materials(id) on delete cascade,
  tool_id text,
  max_range_bytes integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  uses integer not null default 0,
  max_uses integer not null default 1,
  created_at timestamptz not null default now(),
  constraint team_transfer_grants_hash_length check (octet_length(token_hash) = 32),
  constraint team_transfer_grants_purpose_check check (
    purpose in ('preview_range', 'download_range', 'process_input', 'process_output', 'finalize')
  ),
  constraint team_transfer_grants_range_check check (
    max_range_bytes between 1 and 33554432
  ),
  constraint team_transfer_grants_uses_check check (
    max_uses between 1 and 10000 and uses between 0 and max_uses
  ),
  constraint team_transfer_grants_expiry_check check (expires_at > created_at)
);

create index team_transfer_grants_operation_idx
  on private.team_transfer_grants (operation_id);
create index team_transfer_grants_expiry_idx
  on private.team_transfer_grants (expires_at)
  where revoked_at is null;

create table private.catalog_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  phase text not null,
  cursor jsonb not null default '{}'::jsonb,
  folder_queue jsonb not null default '[]'::jsonb,
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  state text not null default 'pending',
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint catalog_sync_jobs_phase_check check (
    phase in ('initial_scan', 'change_replay', 'incremental', 'reconcile')
  ),
  constraint catalog_sync_jobs_state_check check (
    state in ('pending', 'leased', 'retry', 'succeeded', 'failed')
  ),
  constraint catalog_sync_jobs_attempts_check check (attempts between 0 and 1000),
  constraint catalog_sync_jobs_cursor_check check (jsonb_typeof(cursor) = 'object'),
  constraint catalog_sync_jobs_queue_check check (jsonb_typeof(folder_queue) = 'array')
);

create index catalog_sync_jobs_claim_idx
  on private.catalog_sync_jobs (next_attempt_at, created_at)
  where state in ('pending', 'retry', 'leased');
create index catalog_sync_jobs_connection_idx
  on private.catalog_sync_jobs (connection_id, state);

create table public.team_audit_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null,
  actor_label_snapshot text,
  action text not null,
  target jsonb not null default '{}'::jsonb,
  result text not null,
  error_code text,
  occurred_at timestamptz not null default now(),
  constraint team_audit_events_action_length check (char_length(action) between 1 and 96),
  constraint team_audit_events_target_object check (jsonb_typeof(target) = 'object'),
  constraint team_audit_events_result_check check (
    result in ('succeeded', 'denied', 'failed', 'canceled')
  )
);

create index team_audit_events_team_time_idx
  on public.team_audit_events (team_id, occurred_at desc);

create table public.team_catalog_events (
  id bigint generated by default as identity primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  material_id uuid,
  event_kind text not null,
  occurred_at timestamptz not null default now(),
  constraint team_catalog_events_kind_check check (
    event_kind in ('upserted', 'tombstoned', 'restored', 'sync_state')
  )
);

create index team_catalog_events_team_time_idx
  on public.team_catalog_events (team_id, occurred_at desc);

alter table public.team_operations enable row level security;
alter table public.team_operations force row level security;
alter table private.team_transfer_grants enable row level security;
alter table private.team_transfer_grants force row level security;
alter table private.catalog_sync_jobs enable row level security;
alter table private.catalog_sync_jobs force row level security;
alter table public.team_audit_events enable row level security;
alter table public.team_audit_events force row level security;
alter table public.team_catalog_events enable row level security;
alter table public.team_catalog_events force row level security;

revoke all on table public.team_operations from public, anon, authenticated;
revoke all on table private.team_transfer_grants from public, anon, authenticated;
revoke all on table private.catalog_sync_jobs from public, anon, authenticated;
revoke all on table public.team_audit_events from public, anon, authenticated;
revoke all on table public.team_catalog_events from public, anon, authenticated;
revoke all on sequence public.team_catalog_events_id_seq from public, anon, authenticated;

comment on table public.team_operations is
  'Idempotent cross-system operation authority; only verified results become succeeded.';
comment on table private.team_transfer_grants is
  'Hashed, expiring, purpose-bound cloud transfer capabilities.';
comment on table public.team_audit_events is
  'Append-only content-free audit trail for critical team actions.';
comment on table public.team_catalog_events is
  'Small content-free Realtime invalidation markers; refetch authoritative catalog rows.';
