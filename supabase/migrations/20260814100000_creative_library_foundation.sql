-- Feature 005: Creative Library relational authority.
-- Google Drive remains the byte authority; these rows contain team-scoped state and relations.

alter table public.team_materials
  add column library_stage text,
  add column structural_offer text,
  add column structural_language text,
  add column structural_type text,
  add column placement_state text not null default 'unplaced',
  add column placement_revision bigint not null default 0,
  add column language_decision_source text,
  add column language_decision_revision bigint not null default 0,
  add column thumbnail_state text not null default 'pending',
  add column thumbnail_source_version text,
  add column thumbnail_time_ms integer,
  add constraint team_materials_library_stage_check
    check (library_stage is null or library_stage in ('finds', 'library')),
  add constraint team_materials_structural_offer_check
    check (structural_offer is null or char_length(btrim(structural_offer)) between 1 and 120),
  add constraint team_materials_structural_language_check
    check (structural_language is null or char_length(structural_language) between 1 and 35),
  add constraint team_materials_structural_type_check
    check (structural_type is null or char_length(btrim(structural_type)) between 1 and 64),
  add constraint team_materials_placement_state_check
    check (placement_state in ('unplaced','planning','moving','ready','reconciling','failed')),
  add constraint team_materials_placement_revision_check check (placement_revision >= 0),
  add constraint team_materials_language_source_check
    check (language_decision_source is null or language_decision_source in ('manual','automatic','unknown')),
  add constraint team_materials_language_revision_check check (language_decision_revision >= 0),
  add constraint team_materials_thumbnail_state_check
    check (thumbnail_state in ('pending','running','ready','unknown','failed','stale','canceled')),
  add constraint team_materials_thumbnail_time_check check (
    thumbnail_time_ms is null or thumbnail_time_ms between 0 and 86400000
  );

create index team_materials_library_browse_idx
  on public.team_materials (team_id, library_stage, lifecycle, created_at desc, id);
create index team_materials_library_placement_idx
  on public.team_materials (
    team_id, library_stage, lower(structural_offer), structural_language, lower(structural_type)
  ) where lifecycle = 'active';

create table public.team_upload_batches (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  stage text not null,
  offer text not null,
  geo text not null references public.geo_options(code) on delete restrict,
  language text references public.language_options(code) on delete restrict,
  language_mode text not null,
  type_hint text,
  state text not null default 'pending',
  total_items integer not null,
  succeeded_items integer not null default 0,
  failed_items integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_upload_batches_stage_check check (stage in ('finds','library')),
  constraint team_upload_batches_offer_check check (char_length(btrim(offer)) between 1 and 120),
  constraint team_upload_batches_language_mode_check check (language_mode in ('manual','auto')),
  constraint team_upload_batches_language_shape_check check (
    (language_mode = 'manual' and language is not null)
    or (language_mode = 'auto' and language is null)
  ),
  constraint team_upload_batches_type_check check (
    type_hint is null or char_length(btrim(type_hint)) between 1 and 64
  ),
  constraint team_upload_batches_state_check check (
    state in ('pending','running','partial','succeeded','canceled','failed')
  ),
  constraint team_upload_batches_total_check check (total_items between 1 and 500),
  constraint team_upload_batches_counters_check check (
    succeeded_items >= 0 and failed_items >= 0
    and succeeded_items + failed_items <= total_items
  ),
  constraint team_upload_batches_finished_check check (
    (state in ('succeeded','canceled','failed') and finished_at is not null)
    or (state not in ('succeeded','canceled','failed'))
  ),
  unique (id, team_id)
);

create index team_upload_batches_list_idx
  on public.team_upload_batches (team_id, created_at desc, id);

create table public.team_upload_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  team_id uuid not null references public.teams(id) on delete cascade,
  operation_id uuid references public.team_operations(id) on delete set null,
  client_item_key text not null,
  requested_name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  state text not null default 'pending',
  progress integer not null default 0,
  material_id uuid,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_upload_batch_items_batch_fk
    foreign key (batch_id, team_id)
    references public.team_upload_batches(id, team_id) on delete cascade,
  constraint team_upload_batch_items_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_upload_batch_items_key_check
    check (client_item_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint team_upload_batch_items_name_check
    check (char_length(btrim(requested_name)) between 1 and 512),
  constraint team_upload_batch_items_mime_check
    check (char_length(mime_type) between 3 and 255 and position('/' in mime_type) > 1),
  constraint team_upload_batch_items_size_check check (size_bytes between 0 and 107374182400),
  constraint team_upload_batch_items_state_check check (
    state in ('pending','uploading','finalizing','succeeded','failed','canceled')
  ),
  constraint team_upload_batch_items_progress_check check (progress between 0 and 100),
  constraint team_upload_batch_items_result_check check (
    (state = 'succeeded' and material_id is not null and error_code is null)
    or state <> 'succeeded'
  ),
  unique (batch_id, client_item_key),
  unique (operation_id)
);

create index team_upload_batch_items_batch_state_idx
  on public.team_upload_batch_items (batch_id, state, created_at, id);

create table private.team_library_folders (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  connection_id uuid not null references public.team_drive_connections(id) on delete cascade,
  material_id uuid not null,
  parent_folder_id text not null,
  segment text not null,
  value text not null,
  normalized_key text not null,
  drive_folder_id text not null,
  resource_key text,
  state text not null default 'creating',
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_library_folders_segment_check check (segment in ('stage','offer','language','type')),
  constraint team_library_folders_value_check check (char_length(btrim(value)) between 1 and 120),
  constraint team_library_folders_key_check check (char_length(normalized_key) between 1 and 160),
  constraint team_library_folders_provider_check check (
    char_length(parent_folder_id) between 1 and 1024
    and char_length(drive_folder_id) between 1 and 1024
  ),
  constraint team_library_folders_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete cascade,
  constraint team_library_folders_state_check check (state in ('creating','ready','missing','failed')),
  unique (team_id, parent_folder_id, segment, normalized_key),
  unique (team_id, drive_folder_id),
  unique (team_id, material_id)
);

create table private.team_material_enrichments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  material_id uuid not null,
  source_version text not null,
  kind text not null,
  decision_revision bigint not null default 0,
  state text not null default 'pending',
  attempts integer not null default 0,
  lease_owner uuid,
  lease_expires_at timestamptz,
  result_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_material_enrichments_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete cascade,
  constraint team_material_enrichments_version_check check (char_length(source_version) between 1 and 256),
  constraint team_material_enrichments_kind_check check (kind in ('language','thumbnail','landing_preview')),
  constraint team_material_enrichments_revision_check check (decision_revision >= 0),
  constraint team_material_enrichments_state_check check (
    state in ('pending','running','ready','unknown','failed','stale','canceled')
  ),
  constraint team_material_enrichments_attempts_check check (attempts between 0 and 100),
  constraint team_material_enrichments_lease_check check (
    (state = 'running' and lease_owner is not null and lease_expires_at is not null)
    or state <> 'running'
  ),
  unique (team_id, material_id, source_version, kind)
);

create index team_material_enrichments_queue_idx
  on private.team_material_enrichments (team_id, state, created_at, id)
  where state in ('pending','failed','running');

create table public.team_library_requirements (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  source_material_id uuid not null,
  source_version text not null,
  kind text not null,
  variant text not null,
  state text not null default 'pending',
  current_result_id uuid,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint team_library_requirements_source_fk
    foreign key (source_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_library_requirements_version_check check (char_length(source_version) between 1 and 256),
  constraint team_library_requirements_kind_check check (
    kind in ('transcription','translation','landing_optimization')
  ),
  constraint team_library_requirements_variant_check check (
    char_length(variant) between 1 and 64
    and (kind <> 'transcription' or variant = 'original')
    and (kind = 'transcription' or variant <> 'original')
  ),
  constraint team_library_requirements_state_check check (
    state in ('pending','leased','running','ready','failed','canceled','stale','skipped')
  ),
  constraint team_library_requirements_ready_check check (
    (state = 'ready' and current_result_id is not null and completed_at is not null)
    or state <> 'ready'
  ),
  unique (team_id, source_material_id, source_version, kind, variant),
  unique (id, team_id)
);

create index team_library_requirements_queue_idx
  on public.team_library_requirements (team_id, state, kind, created_at, id)
  where state in ('pending','failed','leased','running');

create table private.team_library_attempts (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null,
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  agent_instance_id uuid not null,
  state text not null default 'leased',
  lease_token_hash bytea not null,
  lease_expires_at timestamptz not null,
  last_heartbeat_at timestamptz not null default now(),
  progress integer not null default 0,
  stage text,
  error_code text,
  result_material_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_library_attempts_requirement_fk
    foreign key (requirement_id, team_id)
    references public.team_library_requirements(id, team_id) on delete cascade,
  constraint team_library_attempts_result_fk
    foreign key (result_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_library_attempts_hash_check check (octet_length(lease_token_hash) = 32),
  constraint team_library_attempts_state_check check (
    state in ('leased','running','ready','failed','canceled','expired','skipped')
  ),
  constraint team_library_attempts_progress_check check (progress between 0 and 100),
  constraint team_library_attempts_stage_check check (stage is null or char_length(stage) between 1 and 64),
  constraint team_library_attempts_terminal_check check (
    (state in ('ready','failed','canceled','expired','skipped') and finished_at is not null)
    or state in ('leased','running')
  ),
  unique (id, team_id)
);

create unique index team_library_attempts_one_active_idx
  on private.team_library_attempts (requirement_id)
  where state in ('leased','running');
create index team_library_attempts_expiry_idx
  on private.team_library_attempts (lease_expires_at, requirement_id)
  where state in ('leased','running');

create table public.team_library_results (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  requirement_id uuid not null,
  source_material_id uuid not null,
  source_version text not null,
  kind text not null,
  variant text not null,
  material_id uuid not null,
  state text not null default 'current',
  accepted_attempt_id uuid not null,
  accepted_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  stale_at timestamptz,
  constraint team_library_results_requirement_fk
    foreign key (requirement_id, team_id)
    references public.team_library_requirements(id, team_id) on delete restrict,
  constraint team_library_results_source_fk
    foreign key (source_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_library_results_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_library_results_attempt_fk
    foreign key (accepted_attempt_id, team_id)
    references private.team_library_attempts(id, team_id) on delete restrict,
  constraint team_library_results_version_check check (char_length(source_version) between 1 and 256),
  constraint team_library_results_kind_check check (
    kind in ('transcription','translation','landing_optimization')
  ),
  constraint team_library_results_variant_check check (char_length(variant) between 1 and 64),
  constraint team_library_results_state_check check (state in ('current','stale','superseded')),
  constraint team_library_results_stale_check check (
    (state = 'current' and stale_at is null) or (state <> 'current' and stale_at is not null)
  )
);

alter table public.team_library_requirements
  add constraint team_library_requirements_current_result_fk
  foreign key (current_result_id) references public.team_library_results(id) on delete restrict;

create unique index team_library_results_one_current_idx
  on public.team_library_results (requirement_id) where state = 'current';
create unique index team_library_results_one_transcript_idx
  on public.team_library_results (team_id, source_material_id, source_version)
  where state = 'current' and kind = 'transcription' and variant = 'original';

create table private.team_material_group_intents (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  source_material_id uuid not null,
  operation_id uuid references public.team_operations(id) on delete set null,
  action text not null,
  destination_parent_id text,
  member_snapshot jsonb not null,
  applied_member_ids uuid[] not null default '{}'::uuid[],
  compensation_state text,
  state text not null default 'pending',
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint team_material_group_intents_source_fk
    foreign key (source_material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_material_group_intents_action_check check (action in ('move','trash','restore')),
  constraint team_material_group_intents_members_check check (jsonb_typeof(member_snapshot) = 'array'),
  constraint team_material_group_intents_compensation_check check (
    compensation_state is null or compensation_state in ('pending','running','succeeded','failed')
  ),
  constraint team_material_group_intents_state_check check (
    state in ('pending','running','reconciling','succeeded','failed')
  ),
  unique (operation_id)
);

create index team_material_group_intents_recovery_idx
  on private.team_material_group_intents (team_id, state, updated_at, id)
  where state in ('pending','running','reconciling');

create unique index team_material_group_intents_one_active_source_idx
  on private.team_material_group_intents (team_id, source_material_id)
  where state in ('pending','running','reconciling');

create table public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null,
  note text,
  assignee_id uuid references auth.users(id) on delete set null,
  assignee_label_snapshot text,
  status text not null default 'todo',
  progress_max integer not null default 100,
  progress_value integer not null default 0,
  progress_manually_set boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint team_tasks_title_check check (char_length(btrim(title)) between 1 and 160),
  constraint team_tasks_note_check check (note is null or char_length(note) <= 2000),
  constraint team_tasks_assignee_label_check check (
    assignee_label_snapshot is null or char_length(assignee_label_snapshot) between 1 and 320
  ),
  constraint team_tasks_status_check check (status in ('todo','in_progress','done')),
  constraint team_tasks_progress_max_check check (progress_max between 1 and 10000),
  constraint team_tasks_progress_value_bounds_check check (progress_value between 0 and 10000),
  constraint team_tasks_progress_value_check check (progress_value between 0 and progress_max),
  constraint team_tasks_completed_check check (
    (status = 'done' and completed_at is not null) or (status <> 'done' and completed_at is null)
  ),
  unique (id, team_id)
);

create index team_tasks_list_idx on public.team_tasks (team_id, created_at desc, id);
create index team_tasks_assignee_idx
  on public.team_tasks (team_id, assignee_id, status) where assignee_id is not null;

create table public.team_task_attachments (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  task_id uuid not null,
  material_id uuid not null,
  position bigint not null,
  attached_by uuid not null references auth.users(id) on delete restrict,
  attached_at timestamptz not null default now(),
  constraint team_task_attachments_task_fk
    foreign key (task_id, team_id)
    references public.team_tasks(id, team_id) on delete cascade,
  constraint team_task_attachments_material_fk
    foreign key (material_id, team_id)
    references public.team_materials(id, team_id) on delete restrict,
  constraint team_task_attachments_position_check check (position >= 0),
  unique (task_id, material_id),
  unique (task_id, position)
);

create index team_task_attachments_material_idx
  on public.team_task_attachments (team_id, material_id, task_id);

create table public.team_share_preferences (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  allow_link_on_copy boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.team_contribution_records (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  category text not null,
  agent_instance_id uuid,
  action_kind text not null,
  outcome text not null,
  occurred_at timestamptz not null default now(),
  constraint team_contribution_records_category_check check (
    category in ('local_processing','human_activity')
  ),
  constraint team_contribution_records_action_check check (
    action_kind in (
      'transcription','translation','landing_optimization',
      'find_selected','task_created','task_completed','batch_completed'
    )
  ),
  constraint team_contribution_records_outcome_check check (
    outcome in ('success','failure','canceled','skipped')
  ),
  constraint team_contribution_records_shape_check check (
    (category = 'local_processing'
      and action_kind in ('transcription','translation','landing_optimization'))
    or (category = 'human_activity'
      and agent_instance_id is null
      and action_kind in ('find_selected','task_created','task_completed','batch_completed'))
  )
);

create index team_contribution_records_aggregate_idx
  on public.team_contribution_records (team_id, category, occurred_at, action_kind, outcome);

alter table public.team_upload_batches enable row level security;
alter table public.team_upload_batches force row level security;
alter table public.team_upload_batch_items enable row level security;
alter table public.team_upload_batch_items force row level security;
alter table private.team_library_folders enable row level security;
alter table private.team_library_folders force row level security;
alter table private.team_material_enrichments enable row level security;
alter table private.team_material_enrichments force row level security;
alter table public.team_library_requirements enable row level security;
alter table public.team_library_requirements force row level security;
alter table private.team_library_attempts enable row level security;
alter table private.team_library_attempts force row level security;
alter table public.team_library_results enable row level security;
alter table public.team_library_results force row level security;
alter table private.team_material_group_intents enable row level security;
alter table private.team_material_group_intents force row level security;
alter table public.team_tasks enable row level security;
alter table public.team_tasks force row level security;
alter table public.team_task_attachments enable row level security;
alter table public.team_task_attachments force row level security;
alter table public.team_share_preferences enable row level security;
alter table public.team_share_preferences force row level security;
alter table public.team_contribution_records enable row level security;
alter table public.team_contribution_records force row level security;

revoke all on table public.team_upload_batches from public, anon, authenticated;
revoke all on table public.team_upload_batch_items from public, anon, authenticated;
revoke all on table private.team_library_folders from public, anon, authenticated;
revoke all on table private.team_material_enrichments from public, anon, authenticated;
revoke all on table public.team_library_requirements from public, anon, authenticated;
revoke all on table private.team_library_attempts from public, anon, authenticated;
revoke all on table public.team_library_results from public, anon, authenticated;
revoke all on table private.team_material_group_intents from public, anon, authenticated;
revoke all on table public.team_tasks from public, anon, authenticated;
revoke all on table public.team_task_attachments from public, anon, authenticated;
revoke all on table public.team_share_preferences from public, anon, authenticated;
revoke all on table public.team_contribution_records from public, anon, authenticated;

comment on table public.team_task_attachments is
  'Stable reference attachments only; adding/removing a row never mutates Drive or catalog location.';
comment on table public.team_contribution_records is
  'Closed, content-free contribution facts; intentionally has no JSON/content/provider columns.';
comment on table private.team_material_group_intents is
  'Private resumable saga authority for source plus current sidecar move/trash/restore.';
