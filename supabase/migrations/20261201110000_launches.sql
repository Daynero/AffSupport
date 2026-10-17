-- Launches have their own lifecycle; they are not a Tasks subtype.
create table public.team_launch_offers (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 name text not null check (char_length(name) between 1 and 160 and name !~ '[[:cntrl:]]'),
 normalized_key text not null, archived_at timestamptz, created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(team_id,normalized_key), unique(id,team_id)
);
create table public.team_launch_buyers (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 value text not null check (char_length(value) between 1 and 80 and value ~ '^[A-Za-z0-9_-]+$'),
 normalized_key text not null, archived_at timestamptz, created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(team_id,normalized_key), unique(id,team_id)
);
create table public.team_launch_defaults (
 team_id uuid primary key references public.teams(id) on delete cascade,
 config jsonb not null default '{}', sub_config jsonb not null default '{"schemaVersion":1,"sub1":[],"sub2":[],"sub3":[]}',
 schema_version integer not null default 1 check(schema_version=1), version bigint not null default 1,
 updated_by uuid not null references auth.users(id), updated_at timestamptz not null default now()
);
create table public.team_launch_member_preferences (
 team_id uuid not null references public.teams(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade,
 suppress_catalog_retention_warning boolean not null default false, updated_at timestamptz not null default now(), primary key(team_id,user_id)
);
create table public.team_launches (
 id uuid primary key default gen_random_uuid(), team_id uuid not null references public.teams(id) on delete cascade,
 created_by uuid not null references auth.users(id), assignee_id uuid references auth.users(id) on delete set null,
 assignee_label_snapshot text, work_status text not null default 'todo' check(work_status in ('todo','in_progress','done')),
 draft_config jsonb not null default '{}' check(jsonb_typeof(draft_config)='object'), expected_source_snapshot jsonb,
 draft_version bigint not null default 1, aggregate_version bigint not null default 1,
 active_revision_id uuid, effective_launch_date date,
 copied_from_launch_id uuid, copied_from_revision_id uuid, archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(id,team_id)
);
create table public.team_launch_revisions (
 id uuid primary key default gen_random_uuid(), team_id uuid not null, launch_id uuid not null,
 revision_no integer not null check(revision_no>0), result_kind text not null check(result_kind in ('generated','manual')),
 base_revision_id uuid, baseline_revision_id uuid, config jsonb not null, sources jsonb not null,
 original_url text not null check(char_length(original_url) between 1 and 8192), generated_url text not null check(char_length(generated_url) between 1 and 8192),
 sub_values jsonb not null, generator_versions jsonb not null default '{"url":1,"names":1}', result_overrides jsonb not null default '{}',
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade,
 unique(launch_id,revision_no), unique(id,team_id), unique(id,launch_id,team_id)
);
alter table public.team_launches add foreign key(active_revision_id,id,team_id) references public.team_launch_revisions(id,launch_id,team_id) deferrable initially deferred;
alter table public.team_launch_revisions add foreign key(base_revision_id,launch_id,team_id) references public.team_launch_revisions(id,launch_id,team_id);
alter table public.team_launch_revisions add foreign key(baseline_revision_id,launch_id,team_id) references public.team_launch_revisions(id,launch_id,team_id);
create table public.team_launch_campaigns (
 team_id uuid not null, revision_id uuid not null, ordinal integer not null check(ordinal between 1 and 100),
 budget_usd integer not null check(budget_usd between 1 and 999999), ad_start integer not null check(ad_start>0), ad_end integer not null check(ad_end>=ad_start),
 name text not null check(char_length(name) between 1 and 2000), primary key(revision_id,ordinal),
 foreign key(revision_id,team_id) references public.team_launch_revisions(id,team_id) on delete cascade
);
create table public.team_launch_generations (
 id uuid primary key default gen_random_uuid(), team_id uuid not null, launch_id uuid not null, revision_id uuid not null,
 actor_id uuid not null references auth.users(id), request_key text not null check(char_length(request_key) between 8 and 200), request_digest text not null, input_version text not null,
 state text not null default 'accepted' check(state in ('accepted','running','waiting_dependency','partial','failed','interrupted','succeeded','cancel_requested','canceled_with_cleanup_pending','canceled')),
 stage text not null default 'accepted', state_version bigint not null default 1, attempt_no integer not null default 1,
 lease_owner text, lease_expires_at timestamptz, fence bigint not null default 1, next_attempt_at timestamptz,
 progress jsonb, safe_error_code text, retryable boolean not null default false, cancel_requested_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade,
 foreign key(revision_id,launch_id,team_id) references public.team_launch_revisions(id,launch_id,team_id),
 unique(team_id,request_key), unique(id,team_id)
);
-- Failed/partial/interrupted remain resumable intents; they must be settled before another generation.
create unique index team_launch_generation_unsettled on public.team_launch_generations(launch_id) where state not in ('succeeded','canceled');
create table public.team_launch_generation_steps (
 id uuid primary key default gen_random_uuid(), team_id uuid not null, generation_id uuid not null,
 stage text not null, attempt_no integer not null default 1, stable_step_key text not null,
 team_operation_id uuid references public.team_operations(id), state text not null default 'pending' check(state in ('pending','running','succeeded','failed','canceled')),
 input_signature text, result_material_id uuid, reserved_variant integer, provider_intent_key text, provider_file_id text,
 fence bigint not null default 1, safe_error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(generation_id,team_id) references public.team_launch_generations(id,team_id) on delete cascade, unique(generation_id,stable_step_key)
);
create table public.team_launch_revision_catalogs (
 team_id uuid not null, revision_id uuid primary key, catalog_id uuid not null,
 material_id uuid not null, variant integer not null, name_snapshot text not null, sheet_url text not null,
 restitch_operation_id uuid, restitch_material_id uuid, settings_snapshot jsonb not null,
 foreign key(revision_id,team_id) references public.team_launch_revisions(id,team_id) on delete cascade
);
-- Request payloads are digests only, never config/URL; replies with IDs only.
create table public.team_launch_requests (
 team_id uuid not null references public.teams(id) on delete cascade, actor_id uuid not null references auth.users(id),
 request_key text not null, action text not null, digest text not null, result jsonb not null, created_at timestamptz not null default now(), primary key(team_id,actor_id,request_key)
);
-- The sole browser-readable channel: content-free invalidation, not secret rows.
create table public.team_launch_signals (
 launch_id uuid primary key, team_id uuid not null, version bigint not null, updated_at timestamptz not null default now(),
 foreign key(launch_id,team_id) references public.team_launches(id,team_id) on delete cascade
);
create index team_launch_list_idx on public.team_launches(team_id,archived_at,effective_launch_date desc,id desc);
create index team_launch_assignee_idx on public.team_launches(team_id,assignee_id,work_status) where archived_at is null;
create index team_launch_recovery_idx on public.team_launch_generations(next_attempt_at,lease_expires_at) where state not in ('succeeded','canceled');
-- Protect every row from direct client access. All content reads/writes use narrow RPCs.
do $$ declare t text; begin
 foreach t in array array['team_launch_offers','team_launch_buyers','team_launch_defaults','team_launch_member_preferences','team_launches','team_launch_revisions','team_launch_campaigns','team_launch_generations','team_launch_generation_steps','team_launch_revision_catalogs','team_launch_requests','team_launch_signals'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant select, insert, update, delete on public.%I to service_role',t);
 end loop;
end $$;
create policy team_launch_signal_view on public.team_launch_signals for select to authenticated using(private.can(team_id,'view',auth.uid()));
grant select(launch_id,team_id,version,updated_at) on public.team_launch_signals to authenticated;
alter publication supabase_realtime add table public.team_launch_signals;
create function private.launch_immutable() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'WRONG_STATE' using errcode='55000';end $$;
create trigger launch_revision_immutable before update on public.team_launch_revisions for each row execute function private.launch_immutable();
create trigger launch_campaign_immutable before update on public.team_launch_campaigns for each row execute function private.launch_immutable();
