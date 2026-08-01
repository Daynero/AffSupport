-- Team, membership, and invitation authority.

create extension if not exists citext with schema extensions;

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teams_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint teams_status_check check (status in ('active', 'archived')),
  unique (id, owner_id)
);

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  base_role text not null references public.team_roles(role) on delete restrict,
  permission_overrides jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_members_base_role_check check (base_role in ('admin', 'editor', 'viewer')),
  constraint team_members_overrides_object check (jsonb_typeof(permission_overrides) = 'object'),
  constraint team_members_status_check check (status in ('active', 'removed')),
  constraint team_members_removed_at_check check (
    (status = 'active' and removed_at is null)
    or (status = 'removed' and removed_at is not null)
  )
);

create unique index team_members_active_identity_idx
  on public.team_members (team_id, user_id)
  where status = 'active';
create index team_members_user_team_idx
  on public.team_members (user_id, team_id)
  where status = 'active';
create index team_members_team_status_idx
  on public.team_members (team_id, status, joined_at);

create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  target_email extensions.citext not null,
  target_user_id uuid references auth.users(id) on delete set null,
  initial_role text not null references public.team_roles(role) on delete restrict,
  inviter_id uuid not null,
  accept_token_hash bytea not null,
  state text not null default 'pending',
  delivery_state text not null default 'pending',
  delivery_error_code text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_sent_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint team_invitations_email_length check (
    char_length(btrim(target_email::text)) between 3 and 320
  ),
  constraint team_invitations_initial_role_check check (
    initial_role in ('admin', 'editor', 'viewer')
  ),
  constraint team_invitations_state_check check (
    state in ('pending', 'accepted', 'declined', 'revoked', 'expired')
  ),
  constraint team_invitations_delivery_state_check check (
    delivery_state in ('pending', 'sent', 'failed')
  ),
  constraint team_invitations_token_hash_length check (octet_length(accept_token_hash) = 32),
  constraint team_invitations_expiry_check check (expires_at > created_at)
);

create unique index team_invitations_pending_email_idx
  on public.team_invitations (team_id, target_email)
  where state = 'pending';
create index team_invitations_target_user_idx
  on public.team_invitations (target_user_id, state, expires_at);
create index team_invitations_target_email_idx
  on public.team_invitations (target_email, state, expires_at);
create index team_invitations_expiry_idx
  on public.team_invitations (expires_at)
  where state = 'pending';

alter table public.teams enable row level security;
alter table public.teams force row level security;
alter table public.team_members enable row level security;
alter table public.team_members force row level security;
alter table public.team_invitations enable row level security;
alter table public.team_invitations force row level security;

revoke all on table public.teams from public, anon, authenticated;
revoke all on table public.team_members from public, anon, authenticated;
revoke all on table public.team_invitations from public, anon, authenticated;

comment on table public.teams is 'Wishly team authority with one canonical non-null owner.';
comment on table public.team_members is
  'History-aware Wishly team memberships; owner is derived from teams.owner_id.';
comment on table public.team_invitations is
  'Hashed, identity-bound team invitations with independent delivery state.';
