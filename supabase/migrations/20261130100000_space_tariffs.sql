-- Feature 034 — space tariffs (specs/034-space-tariffs, plan R1–R5, R10–R15).
--
-- A space opens when its owner is a Soty admin (internal space), when a tariff bound to it is
-- in term or in its three extra days, or — while the legacy rule is on — when an active admin
-- is a member (the rule every existing space opens by today). The legacy rule ships ON, so this
-- migration changes nothing for anybody until an admin starts granting tariffs and turns it off.
--
-- One gate, `private.team_workspace_allowed`, is consulted by `private.can`, `private.team_role`,
-- the lobby, invitations and every background claim (the claims are in
-- 20261130110000_space_tariffs_background.sql, the letters in 20261130120000_space_tariff_notices.sql).
-- Existing RPC signatures and return types are unchanged; everything new is additive.
-- Forward-only; reverse steps in ROLLBACK.md.

-- ---------------------------------------------------------------------------------------------
-- Tables.

create table public.tariff_plans (
  code text primary key,
  name_uk text not null,
  name_en text not null,
  summary_uk text not null default '',
  summary_en text not null default '',
  base_seats integer not null,
  invites_allowed boolean not null default false,
  extra_seats_allowed boolean not null default true,
  max_extra_seats integer,
  billing_period text,
  highlight boolean not null default false,
  features text[] not null default '{}',
  showcase boolean not null default true,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tariff_plans_code_check check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint tariff_plans_names_check check (
    char_length(name_uk) between 1 and 60 and char_length(name_en) between 1 and 60
  ),
  constraint tariff_plans_base_seats_check check (base_seats between 1 and 1000),
  constraint tariff_plans_max_extra_check check (max_extra_seats is null or max_extra_seats >= 0)
);

insert into public.tariff_plans (
  code, name_uk, name_en, summary_uk, summary_en, base_seats, invites_allowed,
  extra_seats_allowed, max_extra_seats, billing_period, highlight, features, showcase, sort_order
) values
  ('solo', 'Соло', 'Solo', 'для одного баєра', 'for a single media buyer', 1, false,
   true, null, 'month', false,
   array['explorer', 'tasks', 'finance', 'catalog_updater', 'team'], true, 10),
  ('lead', 'Лід', 'Lead', 'тімлід + команда: ви + 2 людини, місця можна додати',
   'a team lead and a team: you + 2 people, more seats on request', 3, true,
   true, null, 'month', true,
   array['explorer', 'tasks', 'finance', 'catalog_updater', 'team'], true, 20);

create table public.space_tariffs (
  id uuid primary key default gen_random_uuid(),
  owner_email extensions.citext not null,
  owner_id uuid references public.profiles(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  plan_code text not null references public.tariff_plans(code) on delete restrict,
  extra_seats integer not null default 0,
  starts_at timestamptz not null default now(),
  ends_on date not null,
  revoked_at timestamptz,
  source text not null default 'manual',
  external_ref text,
  note text,
  granted_by uuid references auth.users(id) on delete set null,
  claimed_at timestamptz,
  bound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint space_tariffs_email_check check (char_length(owner_email::text) between 3 and 320),
  constraint space_tariffs_extra_check check (extra_seats between 0 and 1000),
  constraint space_tariffs_source_check check (source in ('manual', 'trial')),
  constraint space_tariffs_ref_check check (external_ref is null or char_length(external_ref) <= 500),
  constraint space_tariffs_note_check check (note is null or char_length(note) <= 2000)
);

-- R4: one live tariff per space, one live unbound tariff per address.
create unique index space_tariffs_team_live_idx
  on public.space_tariffs (team_id) where revoked_at is null and team_id is not null;
create unique index space_tariffs_unbound_email_idx
  on public.space_tariffs (lower(owner_email::text)) where revoked_at is null and team_id is null;
create index space_tariffs_owner_idx on public.space_tariffs (owner_id);
create index space_tariffs_email_idx on public.space_tariffs (lower(owner_email::text));
create index space_tariffs_team_idx on public.space_tariffs (team_id);

create table public.space_tariff_events (
  id uuid primary key default gen_random_uuid(),
  tariff_id uuid references public.space_tariffs(id) on delete cascade,
  team_id uuid references public.teams(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  kind text not null,
  before jsonb,
  after jsonb,
  undone_at timestamptz,
  toast_acked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint space_tariff_events_kind_check check (kind in (
    'granted', 'updated', 'extended', 'ended_today', 'ended_now', 'undone', 'member_removed',
    'invitation_revoked', 'bound', 'claimed', 'owner_deleted'
  ))
);
create index space_tariff_events_tariff_idx on public.space_tariff_events (tariff_id, created_at desc);

create table public.tariff_settings (
  id boolean primary key default true,
  admin_telegram text,
  admin_email text,
  legacy_rule_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint tariff_settings_singleton check (id),
  constraint tariff_settings_telegram_check check (
    admin_telegram is null or admin_telegram ~ '^[A-Za-z0-9_]{5,32}$'
  ),
  constraint tariff_settings_email_check check (
    admin_email is null
    or (admin_email ~ '^[^[:space:]@<>"'']+@[^[:space:]@<>"'']+\.[^[:space:]@<>"'']+$'
        and char_length(admin_email) <= 320)
  )
);
insert into public.tariff_settings (id, legacy_rule_enabled) values (true, true);

create table public.tariff_settings_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create table public.space_tariff_notices (
  id uuid primary key default gen_random_uuid(),
  tariff_id uuid not null references public.space_tariffs(id) on delete cascade,
  kind text not null,
  period_end date not null,
  state text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  lease_until timestamptz,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint space_tariff_notices_kind_check check (kind in (
    'warn_3d', 'warn_1d', 'grace', 'blocked', 'granted', 'renewed', 'member_nudge'
  )),
  constraint space_tariff_notices_state_check check (
    state in ('pending', 'sent', 'failed', 'superseded', 'skipped')
  ),
  constraint space_tariff_notices_attempts_check check (attempts between 0 and 100),
  constraint space_tariff_notices_error_check check (last_error is null or char_length(last_error) <= 500),
  unique (tariff_id, kind, period_end)
);
create index space_tariff_notices_pending_idx
  on public.space_tariff_notices (created_at) where state = 'pending';

-- R11: the waitlist becomes the request list.
alter table public.team_workspace_waitlist
  add column if not exists plan_interest text,
  add column if not exists channel text,
  add column if not exists last_contact_at timestamptz,
  add column if not exists handled_at timestamptz,
  add column if not exists admin_note text;
alter table public.team_workspace_waitlist
  add constraint team_workspace_waitlist_channel_check
    check (channel is null or channel in ('telegram', 'email', 'copy')),
  add constraint team_workspace_waitlist_note_check
    check (admin_note is null or char_length(admin_note) <= 2000);

-- R7: a catalog remembers its interval while its space is suspended.
alter table public.team_catalog_updater_items add column if not exists paused_interval text;
alter table public.team_catalog_updater_items
  add constraint team_catalog_updater_items_paused_check
    check (paused_interval is null or private.catalog_updater_interval(paused_interval) is not null);
alter table public.team_catalog_updaters add column if not exists paused_by_tariff_at timestamptz;

-- Nothing here is readable directly; every read and write is a security-definer function.
alter table public.tariff_plans enable row level security;
alter table public.tariff_plans force row level security;
alter table public.space_tariffs enable row level security;
alter table public.space_tariffs force row level security;
alter table public.space_tariff_events enable row level security;
alter table public.space_tariff_events force row level security;
alter table public.tariff_settings enable row level security;
alter table public.tariff_settings force row level security;
alter table public.tariff_settings_events enable row level security;
alter table public.tariff_settings_events force row level security;
alter table public.space_tariff_notices enable row level security;
alter table public.space_tariff_notices force row level security;
revoke all on public.tariff_plans from public, anon, authenticated;
revoke all on public.space_tariffs from public, anon, authenticated;
revoke all on public.space_tariff_events from public, anon, authenticated;
revoke all on public.tariff_settings from public, anon, authenticated;
revoke all on public.tariff_settings_events from public, anon, authenticated;
revoke all on public.space_tariff_notices from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Time. A tariff runs to the end of its last day in Kyiv; the extra days end with ends_on + 3.

create function private.kyiv_today(p_at timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $$
  select (p_at at time zone 'Europe/Kyiv')::date;
$$;

-- The first instant after the given Kyiv day (exclusive end).
create function private.kyiv_day_end(p_day date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_day + 1)::timestamp at time zone 'Europe/Kyiv');
$$;

create function private.tariff_legacy_rule_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select settings.legacy_rule_enabled from public.tariff_settings as settings
                   where settings.id), true);
$$;

-- The legacy rule's own condition: an active Soty admin is a member.
create function private.team_legacy_open(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members as admin_member
    join public.admin_users as workspace_admin on workspace_admin.user_id = admin_member.user_id
    where admin_member.team_id = p_team and admin_member.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- R2 — the gate. Index lookups only; nothing here names a plan.

create or replace function private.team_workspace_allowed(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.teams as team
    where team.id = p_team
      and team.status = 'active'
      and (
        exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = team.owner_id)
        or exists (
          select 1 from public.space_tariffs as tariff
          where tariff.team_id = team.id
            and (tariff.revoked_at is null or tariff.revoked_at > now())
            and now() < private.kyiv_day_end(tariff.ends_on + 3)
        )
        or (private.tariff_legacy_rule_enabled() and private.team_legacy_open(team.id))
      )
  );
$$;

revoke all on function private.team_workspace_allowed(uuid) from public, anon, authenticated, service_role;

-- One gate for every function built on the role: a suspended space has no roles.
create or replace function private.team_role(p_team uuid, p_user uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.team_profile_active(p_user) then null
    when not private.team_workspace_allowed(team.id) then null
    when team.owner_id = p_user then 'owner'
    else member.base_role
  end
  from public.teams as team
  join public.team_members as member
    on member.team_id = team.id
   and member.user_id = p_user
   and member.status = 'active'
  where team.id = p_team
    and team.status = 'active';
$$;

revoke all on function private.team_role(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Seats (R5).

-- The space's current tariff: the live one, else the latest that ended or was revoked.
create function private.team_current_tariff(p_team uuid, p_at timestamptz default now())
returns setof public.space_tariffs
language sql
stable
security definer
set search_path = ''
as $$
  select tariff.*
  from public.space_tariffs as tariff
  where tariff.team_id = p_team
  order by (tariff.revoked_at is null or tariff.revoked_at > p_at) desc,
           tariff.ends_on desc, tariff.created_at desc
  limit 1;
$$;

-- Seats a live tariff grants, or null when the space is not held by one (internal, legacy, none):
-- such spaces keep the old fifty-member rule.
create function private.team_seat_limit(p_team uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.teams as team
      join public.admin_users as owner_admin on owner_admin.user_id = team.owner_id
      where team.id = p_team
    ) then null
    else (
      select plan.base_seats + tariff.extra_seats
      from public.space_tariffs as tariff
      join public.tariff_plans as plan on plan.code = tariff.plan_code
      where tariff.team_id = p_team
        and (tariff.revoked_at is null or tariff.revoked_at > now())
        and now() < private.kyiv_day_end(tariff.ends_on + 3)
      limit 1
    )
  end;
$$;

create function private.team_pending_invites(p_team uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.team_invitations as invitation
  where invitation.team_id = p_team
    and invitation.state = 'pending'
    and invitation.expires_at > now();
$$;

create function private.team_seat_members(p_team uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.team_members as member
  where member.team_id = p_team
    and member.status = 'active'
    and not exists (select 1 from public.admin_users as admin where admin.user_id = member.user_id);
$$;

-- FR-004: active members (Soty admins excluded) and live invitations.
create function private.team_seats_used(p_team uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select private.team_seat_members(p_team) + private.team_pending_invites(p_team);
$$;

-- Raises SEATS_FULL when one more seat would exceed what the live tariff grants.
create function private.assert_team_seat_free(
  p_team uuid,
  p_count_invitations boolean default true,
  p_exclude_invitation uuid default null,
  p_exclude_email text default null
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  seat_limit integer := private.team_seat_limit(p_team);
  used integer;
begin
  if seat_limit is null then
    return;
  end if;
  used := private.team_seat_members(p_team);
  if p_count_invitations then
    used := used + (
      select count(*)::integer
      from public.team_invitations as invitation
      where invitation.team_id = p_team
        and invitation.state = 'pending'
        and invitation.expires_at > now()
        and invitation.id is distinct from p_exclude_invitation
        and (p_exclude_email is null or lower(invitation.target_email::text) <> lower(p_exclude_email))
    );
  end if;
  if used >= seat_limit then
    raise exception 'SEATS_FULL' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- R1 — the state people see. Server-computed; the interface never derives it.

create function private.space_tariff_state(p_team uuid, p_at timestamptz default now())
returns table (
  state text,
  tariff_id uuid,
  plan_code text,
  seats_total integer,
  seats_used integer,
  ends_on date,
  ends_at timestamptz,
  grace_until timestamptz,
  days_left integer,
  legacy_also boolean,
  pending_invites integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner uuid;
  tariff public.space_tariffs%rowtype;
  plan_seats integer;
  legacy boolean;
  live boolean := false;
  resolved text;
  remaining integer;
begin
  select team.owner_id into owner
  from public.teams as team where team.id = p_team and team.status = 'active';
  if owner is null then
    return query select 'none'::text, null::uuid, null::text, 0, 0, null::date, null::timestamptz,
                        null::timestamptz, null::integer, false, 0;
    return;
  end if;

  legacy := private.tariff_legacy_rule_enabled() and private.team_legacy_open(p_team);
  select current_tariff.* into tariff from private.team_current_tariff(p_team, p_at) as current_tariff;
  if tariff.id is not null then
    select plan.base_seats + tariff.extra_seats into plan_seats
    from public.tariff_plans as plan where plan.code = tariff.plan_code;
    remaining := tariff.ends_on - private.kyiv_today(p_at);
    live := (tariff.revoked_at is null or tariff.revoked_at > p_at)
      and p_at < private.kyiv_day_end(tariff.ends_on + 3);
  end if;

  if exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = owner) then
    resolved := 'internal';
  elsif live then
    resolved := case when remaining > 3 then 'active' when remaining >= 0 then 'expiring' else 'grace' end;
    -- US2.2: while the legacy rule holds the space, it has no warnings.
    if resolved in ('expiring', 'grace') and legacy then
      resolved := 'legacy';
    end if;
  elsif legacy then
    resolved := 'legacy';
  elsif tariff.id is not null then
    resolved := 'blocked';
  else
    resolved := 'none';
  end if;

  return query select
    resolved,
    tariff.id,
    tariff.plan_code,
    case
      when resolved = 'internal' then 50
      when tariff.id is not null and (live or resolved = 'blocked') then plan_seats
      else 50
    end,
    private.team_seats_used(p_team),
    tariff.ends_on,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on) end,
    case when tariff.id is not null then private.kyiv_day_end(tariff.ends_on + 3) end,
    remaining,
    legacy,
    private.team_pending_invites(p_team);
end;
$$;

revoke all on function private.kyiv_today(timestamptz) from public, anon, authenticated;
revoke all on function private.kyiv_day_end(date) from public, anon, authenticated;
revoke all on function private.tariff_legacy_rule_enabled() from public, anon, authenticated;
revoke all on function private.team_legacy_open(uuid) from public, anon, authenticated;
revoke all on function private.team_current_tariff(uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.team_seat_limit(uuid) from public, anon, authenticated;
revoke all on function private.team_pending_invites(uuid) from public, anon, authenticated;
revoke all on function private.team_seat_members(uuid) from public, anon, authenticated;
revoke all on function private.team_seats_used(uuid) from public, anon, authenticated;
revoke all on function private.assert_team_seat_free(uuid, boolean, uuid, text) from public, anon, authenticated;
revoke all on function private.space_tariff_state(uuid, timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- R3 — ownership by address, then by account.

create function private.claim_space_tariffs(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmed text := private.team_confirmed_email(p_user)::text;
  claimed integer;
begin
  if confirmed is null then
    return 0;
  end if;
  with claimed_rows as (
    update public.space_tariffs as tariff
       set owner_id = p_user, claimed_at = clock_timestamp(), updated_at = clock_timestamp()
     where tariff.owner_id is null
       and tariff.claimed_at is null
       and tariff.revoked_at is null
       and lower(tariff.owner_email::text) = lower(confirmed)
    returning tariff.id, tariff.team_id
  )
  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind)
  select claimed_rows.id, claimed_rows.team_id, p_user, 'claimed' from claimed_rows;
  get diagnostics claimed = row_count;
  return claimed;
end;
$$;

revoke all on function private.claim_space_tariffs(uuid) from public, anon, authenticated, service_role;

-- A deleted owner revokes the tariff (FR-006). A deleted draft space frees its tariff for a new
-- space, unless the owner already holds another unbound one (R4 allows only one).
create function private.space_tariff_reference_lost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.owner_id is not null and new.owner_id is null and new.revoked_at is null then
    new.revoked_at := now();
    new.updated_at := clock_timestamp();
    insert into public.space_tariff_events (tariff_id, team_id, kind, before, after)
    values (new.id, new.team_id, 'owner_deleted',
            jsonb_build_object('revokedAt', null), jsonb_build_object('revokedAt', new.revoked_at));
  end if;
  if old.team_id is not null and new.team_id is null and new.revoked_at is null
     and exists (
       select 1 from public.space_tariffs as other
       where other.id <> new.id and other.team_id is null and other.revoked_at is null
         and lower(other.owner_email::text) = lower(new.owner_email::text)
     ) then
    new.revoked_at := clock_timestamp();
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger space_tariffs_reference_lost
  before update of owner_id, team_id on public.space_tariffs
  for each row execute function private.space_tariff_reference_lost();

revoke all on function private.space_tariff_reference_lost() from public, anon, authenticated;

-- R12 — a space on a tariff keeps its owner until an admin moves the tariff.
create function private.teams_tariff_bound_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id and exists (
    select 1 from public.space_tariffs as tariff
    where tariff.team_id = new.id and tariff.revoked_at is null
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger teams_tariff_bound_owner
  before update of owner_id on public.teams
  for each row execute function private.teams_tariff_bound_owner();

revoke all on function private.teams_tariff_bound_owner() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Lobby: the old web build keeps its RPCs; they now follow the gate.

create or replace function public.can_access_team_workspace()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    return false;
  end if;
  perform private.claim_space_tariffs(actor);
  return public.is_admin()
    or exists (
      select 1
      from public.team_members as member
      join public.teams as team on team.id = member.team_id
      where member.user_id = actor
        and member.status = 'active'
        and team.status = 'active'
        and private.team_workspace_allowed(team.id)
    )
    or exists (
      select 1 from public.space_tariffs as tariff
      where tariff.owner_id = actor
        and tariff.team_id is null
        and tariff.revoked_at is null
        and tariff.ends_on >= private.kyiv_today()
    );
end;
$$;

revoke all on function public.can_access_team_workspace() from public, anon;
grant execute on function public.can_access_team_workspace() to authenticated;

create or replace function public.list_my_teams()
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language sql
stable
security definer
set search_path = ''
as $$
  select team.id,
         team.name,
         case when team.owner_id = auth.uid() then 'owner' else member.base_role end,
         private.effective_permissions(team.id, auth.uid()),
         coalesce(connection.state, 'none')
  from public.team_members member
  join public.teams team
    on team.id = member.team_id
   and team.status = 'active'
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = team.id
      and drive.state <> 'detached'
    order by drive.created_at desc
    limit 1
  ) connection on true
  where auth.uid() is not null
    and private.team_profile_active(auth.uid())
    and member.user_id = auth.uid()
    and member.status = 'active'
    and private.team_workspace_allowed(team.id)
  order by team.created_at, team.id;
$$;

-- An admin creates internal spaces; an owner with an unbound tariff in term creates the one space
-- that tariff is for, and the tariff is bound to it here (R3).
create or replace function public.create_team(p_name text)
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  normalized_name text := btrim(p_name);
  created_id uuid;
  bind_id uuid;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.claim_space_tariffs(actor);

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select tariff.id into bind_id
  from public.space_tariffs as tariff
  where tariff.owner_id = actor
    and tariff.team_id is null
    and tariff.revoked_at is null
    and tariff.ends_on >= private.kyiv_today()
  order by tariff.ends_on, tariff.created_at
  limit 1
  for update;

  if not public.is_admin() and bind_id is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if normalized_name is null or char_length(normalized_name) not between 1 and 120 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.team_members member
    join public.teams team on team.id = member.team_id
    where member.user_id = actor
      and member.status = 'active'
      and team.status = 'active'
      and lower(btrim(team.name)) = lower(normalized_name)
  ) then
    raise exception 'NAME_CONFLICT' using errcode = '23505';
  end if;

  insert into public.teams (name, owner_id)
  values (normalized_name, actor)
  returning teams.id into created_id;

  insert into public.team_members (team_id, user_id, base_role)
  values (created_id, actor, 'admin');

  if bind_id is not null then
    update public.space_tariffs as tariff
       set team_id = created_id, bound_at = clock_timestamp(), updated_at = clock_timestamp()
     where tariff.id = bind_id;
    insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, after)
    values (bind_id, created_id, actor, 'bound', jsonb_build_object('teamId', created_id));
  end if;

  perform private.record_team_audit(
    created_id, actor, 'team.created', '{}'::jsonb, 'succeeded', null
  );

  return query
  select created_id,
         normalized_name,
         'owner'::text,
         private.effective_permissions(created_id, actor),
         'none'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Invitations and membership within the seats.

create or replace function public.accept_invitation(
  p_invitation uuid,
  p_plain_token text default null
)
returns table (
  id uuid,
  name text,
  role text,
  permissions jsonb,
  connection_state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_row public.team_invitations%rowtype;
  resolved_name text;
  resolved_connection_state text;
begin
  select invitation.* into invitation_row
  from public.team_invitations invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_invitation_identity_matches(invitation_row, actor, p_plain_token) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' or invitation_row.expires_at <= clock_timestamp() then
    if invitation_row.state = 'pending' then
      update public.team_invitations set state = 'expired', responded_at = clock_timestamp()
      where team_invitations.id = invitation_row.id;
    end if;
    raise exception 'EXPIRED' using errcode = '22023';
  end if;

  perform 1 from public.teams team
  where team.id = invitation_row.team_id and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.team_workspace_allowed(invitation_row.team_id) then
    raise exception 'SPACE_BLOCKED' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.team_members member
    where member.team_id = invitation_row.team_id
      and member.user_id = actor
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  if (
    select count(*) from public.team_members member
    where member.team_id = invitation_row.team_id and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;
  -- The accepted invitation already held its seat; only members are counted. Admins take none.
  if not exists (select 1 from public.admin_users as admin where admin.user_id = actor) then
    perform private.assert_team_seat_free(invitation_row.team_id, false);
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (invitation_row.team_id, actor, invitation_row.initial_role);
  update public.team_invitations
  set state = 'accepted', responded_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  perform private.record_team_audit(
    invitation_row.team_id,
    actor,
    'invitation.accepted',
    jsonb_build_object('invitation_id', invitation_row.id, 'role', invitation_row.initial_role),
    'succeeded',
    null
  );

  select team.name into resolved_name
  from public.teams team where team.id = invitation_row.team_id;
  select coalesce(connection.state, 'none') into resolved_connection_state
  from (select 1) singleton
  left join lateral (
    select drive.state
    from public.team_drive_connections drive
    where drive.team_id = invitation_row.team_id and drive.state <> 'detached'
    order by drive.created_at desc limit 1
  ) connection on true;
  return query
  select invitation_row.team_id,
         resolved_name,
         invitation_row.initial_role,
         private.effective_permissions(invitation_row.team_id, actor),
         resolved_connection_state;
end;
$$;

create or replace function public.create_invitation(
  p_team uuid,
  p_email text,
  p_initial_role text,
  p_token_hash bytea
)
returns table (
  id uuid,
  team_name text,
  inviter_name text,
  target_email text,
  target_user_id uuid,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  canonical_email extensions.citext := lower(btrim(p_email))::extensions.citext;
  target_id uuid;
  invitation_id uuid;
  expiry timestamptz := clock_timestamp() + interval '14 days';
  resolved_team_name text;
  resolved_inviter_name text;
begin
  if not private.can(p_team, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if canonical_email is null
     or canonical_email::text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(canonical_email::text) > 320
     or p_initial_role not in ('admin', 'editor', 'viewer')
     or octet_length(p_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1 from public.teams as team
  where team.id = p_team and team.status = 'active'
  for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform private.team_expire_invitations(p_team);

  select users.id into target_id
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = canonical_email::text
  limit 1;

  if target_id is not null and exists (
    select 1 from public.team_members as member
    where member.team_id = p_team
      and member.user_id = target_id
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.team_invitations as invitation
    where invitation.team_id = p_team
      and invitation.target_email = canonical_email
      and invitation.state = 'pending'
  ) then
    raise exception 'ALREADY_INVITED' using errcode = '23505';
  end if;
  if (
    select count(*) from public.team_members as member
    where member.team_id = p_team and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;
  perform private.assert_team_seat_free(p_team, true);

  insert into public.team_invitations (
    team_id, target_email, target_user_id, initial_role, inviter_id,
    accept_token_hash, expires_at
  ) values (
    p_team, canonical_email, target_id, p_initial_role, actor,
    p_token_hash, expiry
  ) returning team_invitations.id into invitation_id;

  select team.name into resolved_team_name
  from public.teams as team where team.id = p_team;
  select coalesce(profile.display_name, 'Wishly member') into resolved_inviter_name
  from public.profiles as profile where profile.id = actor;

  perform private.record_team_audit(
    p_team,
    actor,
    'invitation.created',
    jsonb_build_object('invitation_id', invitation_id, 'role', p_initial_role),
    'succeeded',
    null
  );

  return query
  select invitation_id,
         resolved_team_name,
         resolved_inviter_name,
         canonical_email::text,
         target_id,
         p_initial_role,
         'pending'::text,
         'pending'::text,
         null::text,
         expiry;
end;
$$;

-- An invitation past its expiry no longer holds a seat; sending it again takes one.
create or replace function public.resend_invitation(
  p_invitation uuid,
  p_token_hash bytea
)
returns table (
  id uuid,
  team_name text,
  inviter_name text,
  target_email text,
  initial_role text,
  state text,
  delivery_state text,
  delivery_error_code text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  invitation_row public.team_invitations%rowtype;
  resolved_team_name text;
  resolved_inviter_name text;
  expiry timestamptz := clock_timestamp() + interval '14 days';
begin
  if octet_length(p_token_hash) <> 32 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select invitation.* into invitation_row
  from public.team_invitations as invitation
  where invitation.id = p_invitation
  for update;
  if invitation_row.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not private.can(invitation_row.team_id, 'manage_members', actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if invitation_row.state <> 'pending' then
    raise exception 'WRONG_STATE' using errcode = '22023';
  end if;
  if invitation_row.expires_at <= now() then
    perform private.assert_team_seat_free(invitation_row.team_id, true, invitation_row.id);
  end if;

  update public.team_invitations
  set accept_token_hash = p_token_hash,
      expires_at = expiry,
      delivery_state = 'pending',
      delivery_error_code = null,
      last_sent_at = clock_timestamp()
  where team_invitations.id = invitation_row.id;
  select team.name into resolved_team_name
  from public.teams as team where team.id = invitation_row.team_id;
  select coalesce(profile.display_name, 'Wishly member') into resolved_inviter_name
  from public.profiles as profile where profile.id = actor;
  perform private.record_team_audit(
    invitation_row.team_id, actor, 'invitation.resent',
    jsonb_build_object('invitation_id', invitation_row.id), 'succeeded', null
  );
  return query
  select invitation_row.id,
         resolved_team_name,
         resolved_inviter_name,
         invitation_row.target_email::text,
         invitation_row.initial_role,
         'pending'::text,
         'pending'::text,
         null::text,
         expiry;
end;
$$;

create or replace function public.service_direct_add_registered_member(
  p_actor uuid,
  p_team uuid,
  p_email text,
  p_base_role text
)
returns table (
  membership_id uuid,
  user_id uuid,
  display_name text,
  email text,
  role text,
  base_role text,
  permission_overrides jsonb,
  effective_permissions jsonb,
  joined_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical_email extensions.citext := lower(btrim(p_email))::extensions.citext;
  target_user uuid;
begin
  if p_actor is null
     or p_team is null
     or canonical_email is null
     or char_length(canonical_email::text) not between 3 and 320
     or position('@' in canonical_email::text) <= 1
     or p_base_role not in ('admin', 'editor', 'viewer') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  perform 1
  from public.teams as team
  where team.id = p_team
    and team.status = 'active'
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if not private.can(p_team, 'manage_members', p_actor) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;

  select users.id
    into target_user
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = canonical_email::text
  limit 1;
  if target_user is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.team_members as member
    where member.team_id = p_team
      and member.user_id = target_user
      and member.status = 'active'
  ) then
    raise exception 'ALREADY_MEMBER' using errcode = '23505';
  end if;

  if (
    select count(*)
    from public.team_members as member
    where member.team_id = p_team
      and member.status = 'active'
  ) >= 50 then
    raise exception 'TEAM_MEMBER_LIMIT' using errcode = '22023';
  end if;
  -- The target's own pending invitations are revoked below, so their seat moves to the member.
  if not exists (select 1 from public.admin_users as admin where admin.user_id = target_user) then
    perform private.assert_team_seat_free(p_team, true, null, canonical_email::text);
  end if;

  insert into public.team_members (team_id, user_id, base_role)
  values (p_team, target_user, p_base_role);

  update public.team_invitations as invitation
  set state = 'revoked',
      responded_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where invitation.team_id = p_team
    and invitation.state = 'pending'
    and (
      invitation.target_user_id = target_user
      or invitation.target_email = canonical_email
    );

  perform private.record_team_audit(
    p_team,
    p_actor,
    'membership.direct_added',
    jsonb_build_object('member_id', target_user, 'role', p_base_role),
    'succeeded',
    null
  );

  return query
  select member.id,
         member.user_id,
         profile.display_name,
         lower(btrim(users.email)),
         member.base_role,
         member.base_role,
         member.permission_overrides,
         private.effective_permissions(p_team, target_user),
         member.joined_at
  from public.team_members as member
  join public.profiles as profile on profile.id = member.user_id
  join auth.users as users on users.id = member.user_id
  where member.team_id = p_team
    and member.user_id = target_user
    and member.status = 'active';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- R10 — what the web shows.

create function private.tariff_plan_json(p_plan public.tariff_plans)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'code', p_plan.code,
    'nameUk', p_plan.name_uk,
    'nameEn', p_plan.name_en,
    'summaryUk', p_plan.summary_uk,
    'summaryEn', p_plan.summary_en,
    'baseSeats', p_plan.base_seats,
    'invitesAllowed', p_plan.invites_allowed,
    'extraSeatsAllowed', p_plan.extra_seats_allowed,
    'maxExtraSeats', p_plan.max_extra_seats,
    'billingPeriod', p_plan.billing_period,
    'highlight', p_plan.highlight,
    'features', to_jsonb(p_plan.features),
    'showcase', p_plan.showcase,
    'sortOrder', p_plan.sort_order
  );
$$;

create function private.tariff_contact_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('telegram', settings.admin_telegram, 'email', settings.admin_email)
  from (select 1) as anchor
  left join public.tariff_settings as settings on settings.id;
$$;

create function private.team_updater_running(p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_catalog_updater_items as item
    where item.team_id = p_team and item.update_interval is not null
  );
$$;

-- TeamTariff (contracts.md). Dates are the owner's business; members see the plan and seats.
create function private.team_tariff_json(p_team uuid, p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  st record;
  plan public.tariff_plans%rowtype;
  is_owner boolean;
  seat_limit integer;
begin
  select * into st from private.space_tariff_state(p_team, now());
  select tariff_plan.* into plan from public.tariff_plans as tariff_plan where tariff_plan.code = st.plan_code;
  select team.owner_id = p_user into is_owner from public.teams as team where team.id = p_team;
  is_owner := coalesce(is_owner, false);
  seat_limit := private.team_seat_limit(p_team);
  return jsonb_build_object(
    'state', st.state,
    'planCode', st.plan_code,
    'planNameUk', plan.name_uk,
    'planNameEn', plan.name_en,
    'seatsTotal', st.seats_total,
    'seatsUsed', st.seats_used,
    'pendingInvites', st.pending_invites,
    'canInvite', seat_limit is null or coalesce(plan.invites_allowed, false) or seat_limit > 1,
    'endsOn', case when is_owner then st.ends_on::text end,
    'endsAt', case when is_owner then to_jsonb(st.ends_at) end,
    'graceUntil', case when is_owner then (st.ends_on + 3)::text end,
    'daysLeft', case when is_owner then st.days_left end,
    'isOwner', is_owner,
    'updaterPausedByTariff', exists (
      select 1 from public.team_catalog_updaters as updater
      where updater.team_id = p_team and updater.paused_by_tariff_at is not null
    )
  );
end;
$$;

revoke all on function private.tariff_plan_json(public.tariff_plans) from public, anon, authenticated;
revoke all on function private.tariff_contact_json() from public, anon, authenticated;
revoke all on function private.team_updater_running(uuid) from public, anon, authenticated;
revoke all on function private.team_tariff_json(uuid, uuid) from public, anon, authenticated;

create function public.get_my_space_access()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_email text;
  admin boolean;
  teams_json jsonb;
  any_allowed boolean;
  any_blocked boolean;
  invitations_json jsonb;
  pending public.space_tariffs%rowtype;
  pending_json jsonb;
  can_create boolean;
  banner_json jsonb;
  toast_json jsonb;
  request_json jsonb;
  mode text;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  perform private.claim_space_tariffs(actor);
  admin := public.is_admin();
  actor_email := coalesce(
    private.team_confirmed_email(actor)::text,
    (select lower(btrim(profile.email)) from public.profiles as profile where profile.id = actor)
  );

  with mine as (
    select team.id, team.name, team.owner_id, team.created_at, member.base_role,
           private.team_workspace_allowed(team.id) as allowed
    from public.team_members as member
    join public.teams as team on team.id = member.team_id and team.status = 'active'
    where member.user_id = actor and member.status = 'active'
  ), described as (
    select mine.*, private.team_tariff_json(mine.id, actor) as tariff
    from mine
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'teamId', described.id,
           'name', described.name,
           'role', case when described.owner_id = actor then 'owner' else described.base_role end,
           'accessState', case when described.allowed then 'allowed' else 'blocked' end,
           'ownerName', (select profile.display_name from public.profiles as profile
                         where profile.id = described.owner_id),
           'tariff', described.tariff
         ) order by described.created_at, described.id), '[]'::jsonb),
         coalesce(bool_or(described.allowed), false),
         coalesce(bool_or(not described.allowed and described.tariff ->> 'state' = 'blocked'), false)
    into teams_json, any_allowed, any_blocked
  from described;

  select coalesce(jsonb_agg(jsonb_build_object(
           'invitationId', invitation.id,
           'teamId', invitation.team_id,
           'teamName', team.name,
           'inviterName', inviter.display_name,
           'role', invitation.initial_role,
           'blocked', not private.team_workspace_allowed(invitation.team_id)
         ) order by invitation.created_at desc, invitation.id), '[]'::jsonb)
    into invitations_json
  from public.team_invitations as invitation
  join public.teams as team on team.id = invitation.team_id and team.status = 'active'
  left join public.profiles as inviter on inviter.id = invitation.inviter_id
  where invitation.state = 'pending'
    and invitation.expires_at > now()
    and (
      invitation.target_user_id = actor
      or (actor_email is not null and lower(invitation.target_email::text) = actor_email)
    )
    and not exists (
      select 1 from public.team_members as member
      where member.team_id = invitation.team_id and member.user_id = actor and member.status = 'active'
    );

  select tariff.* into pending
  from public.space_tariffs as tariff
  where tariff.owner_id = actor
    and tariff.team_id is null
    and tariff.revoked_at is null
    and tariff.ends_on >= private.kyiv_today()
  order by tariff.ends_on, tariff.created_at
  limit 1;
  if pending.id is not null then
    select jsonb_build_object('planCode', plan.code, 'planNameUk', plan.name_uk,
                              'planNameEn', plan.name_en, 'endsOn', pending.ends_on::text)
      into pending_json
    from public.tariff_plans as plan where plan.code = pending.plan_code;
  end if;
  can_create := admin or pending.id is not null;

  -- The owner's nearest warning, never under the legacy rule (the state already says so).
  select jsonb_build_object(
           'teamId', team.id,
           'teamName', team.name,
           'kind', case when st.state = 'grace' then 'grace'
                        when st.days_left <= 1 then 'warn_1d' else 'warn_3d' end,
           'endsOn', st.ends_on::text,
           'graceUntil', (st.ends_on + 3)::text,
           'daysLeft', st.days_left,
           'updaterRunning', private.team_updater_running(team.id),
           'planCode', st.plan_code
         )
    into banner_json
  from public.teams as team
  cross join lateral private.space_tariff_state(team.id, now()) as st
  where team.owner_id = actor and team.status = 'active'
    and st.state in ('expiring', 'grace')
  order by st.ends_on, team.created_at
  limit 1;

  -- A grant or extension the admin chose to announce, once, for a week.
  select jsonb_build_object(
           'teamId', tariff.team_id,
           'kind', case when event.kind = 'extended' then 'renewed' else 'granted' end,
           'endsOn', event.after ->> 'endsOn',
           'eventId', event.id
         )
    into toast_json
  from public.space_tariff_events as event
  join public.space_tariffs as tariff on tariff.id = event.tariff_id
  where tariff.owner_id = actor
    and tariff.revoked_at is null
    and event.kind in ('granted', 'extended')
    and event.created_at > now() - interval '7 days'
    and event.toast_acked_at is null
    and event.undone_at is null
    and coalesce((event.after ->> 'notify')::boolean, false)
    and (tariff.team_id is null
         or (select st.state from private.space_tariff_state(tariff.team_id, now()) as st)
            not in ('legacy', 'internal'))
  order by event.created_at desc
  limit 1;

  select jsonb_build_object('planInterest', entry.plan_interest, 'channel', entry.channel,
                            'lastContactAt', entry.last_contact_at)
    into request_json
  from public.team_workspace_waitlist as entry where entry.user_id = actor;

  mode := case
    when any_allowed or can_create then 'workspace'
    when any_blocked then 'blocked'
    else 'showcase'
  end;

  return jsonb_build_object(
    'mode', mode,
    'canCreate', can_create,
    'pendingTariff', pending_json,
    'teams', teams_json,
    'invitations', invitations_json,
    'banner', banner_json,
    'toast', toast_json,
    'showcase', jsonb_build_object(
      'plans', coalesce((
        select jsonb_agg(private.tariff_plan_json(plan) order by plan.sort_order, plan.code)
        from public.tariff_plans as plan where plan.active and plan.showcase
      ), '[]'::jsonb),
      'contact', private.tariff_contact_json(),
      'email', actor_email,
      'request', request_json
    )
  );
end;
$$;

create function public.get_team_tariff(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if not private.team_profile_active(actor) or not exists (
    select 1
    from public.team_members as member
    join public.teams as team on team.id = member.team_id and team.status = 'active'
    where member.team_id = p_team and member.user_id = actor and member.status = 'active'
  ) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return private.team_tariff_json(p_team, actor);
end;
$$;

create function public.ack_space_tariff_toast(p_event uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  update public.space_tariff_events as event
     set toast_acked_at = clock_timestamp()
   where event.id = p_event
     and event.toast_acked_at is null
     and exists (
       select 1 from public.space_tariffs as tariff
       where tariff.id = event.tariff_id and tariff.owner_id = auth.uid()
     );
  return found;
end;
$$;

-- R11. The zero-argument form the released web calls is replaced by one whose arguments all
-- have defaults, so `join_team_workspace_waitlist()` and `rpc('join_team_workspace_waitlist')`
-- keep resolving — two overloads would make the zero-argument call ambiguous.
drop function public.join_team_workspace_waitlist();

create function public.join_team_workspace_waitlist(
  p_plan text default null,
  p_channel text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  contacted boolean := p_plan is not null or p_channel is not null;
begin
  if caller is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if (p_plan is not null and not exists (
        select 1 from public.tariff_plans as plan where plan.code = p_plan and plan.active
      ))
     or (p_channel is not null and p_channel not in ('telegram', 'email', 'copy')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.team_workspace_waitlist (user_id, email, plan_interest, channel, last_contact_at)
  select profile.id, profile.email, p_plan, p_channel,
         case when contacted then clock_timestamp() end
  from public.profiles profile
  where profile.id = caller and profile.email is not null
  on conflict (user_id) do update
    set plan_interest = coalesce(excluded.plan_interest, public.team_workspace_waitlist.plan_interest),
        channel = coalesce(excluded.channel, public.team_workspace_waitlist.channel),
        last_contact_at = coalesce(excluded.last_contact_at, public.team_workspace_waitlist.last_contact_at),
        handled_at = case when contacted then null else public.team_workspace_waitlist.handled_at end;

  if not exists (select 1 from public.team_workspace_waitlist entry where entry.user_id = caller) then
    raise exception 'Profile email is required' using errcode = '23502';
  end if;

  return true;
end;
$$;

-- A member of a suspended space asks its owner, at most once per Kyiv day per space.
create function public.request_space_owner_nudge(p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  owner uuid;
  st record;
  today date := private.kyiv_today();
  inserted uuid;
begin
  if not private.team_profile_active(actor) then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  select team.owner_id into owner
  from public.teams as team
  join public.team_members as member
    on member.team_id = team.id and member.user_id = actor and member.status = 'active'
  where team.id = p_team and team.status = 'active';
  if owner is null then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  if owner = actor or private.team_workspace_allowed(p_team) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into st from private.space_tariff_state(p_team, now());
  if st.tariff_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  insert into public.space_tariff_notices (tariff_id, kind, period_end, requested_by)
  values (st.tariff_id, 'member_nudge', today, actor)
  on conflict (tariff_id, kind, period_end) do nothing
  returning id into inserted;

  return jsonb_build_object(
    'sent', inserted is not null,
    'nextAllowedAt', to_jsonb(private.kyiv_day_end(today))
  );
end;
$$;

revoke all on function public.get_my_space_access() from public, anon;
revoke all on function public.get_team_tariff(uuid) from public, anon;
revoke all on function public.ack_space_tariff_toast(uuid) from public, anon;
revoke all on function public.join_team_workspace_waitlist(text, text) from public, anon;
revoke all on function public.request_space_owner_nudge(uuid) from public, anon;
grant execute on function public.get_my_space_access() to authenticated;
grant execute on function public.get_team_tariff(uuid) to authenticated;
grant execute on function public.ack_space_tariff_toast(uuid) to authenticated;
grant execute on function public.join_team_workspace_waitlist(text, text) to authenticated;
grant execute on function public.request_space_owner_nudge(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Admin (FR-005). Every change lands in the tariff's history.

create function private.require_tariff_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

create function private.space_tariff_snapshot(p_tariff public.space_tariffs)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'planCode', p_tariff.plan_code,
    'endsOn', p_tariff.ends_on::text,
    'extraSeats', p_tariff.extra_seats,
    'note', p_tariff.note,
    'externalRef', p_tariff.external_ref,
    'revokedAt', p_tariff.revoked_at,
    'teamId', p_tariff.team_id
  );
$$;

-- An account that may own a tariff: confirmed address, active profile.
create function private.tariff_account_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select users.id
  from auth.users as users
  join public.profiles as profile on profile.id = users.id
  where users.email_confirmed_at is not null
    and profile.account_status = 'active'
    and lower(btrim(users.email)) = lower(btrim(p_email))
  order by users.id
  limit 1;
$$;

create function private.space_tariff_row_state(p_tariff public.space_tariffs, p_at timestamptz default now())
returns table (state text, legacy_also boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  st record;
  current_id uuid;
begin
  if p_tariff.team_id is null then
    if p_tariff.revoked_at is not null and p_tariff.revoked_at <= p_at then
      return query select 'blocked'::text, false;
    elsif p_tariff.ends_on >= private.kyiv_today(p_at) then
      return query select 'pending'::text, false;
    else
      return query select 'pending_expired'::text, false;
    end if;
    return;
  end if;
  select * into st from private.space_tariff_state(p_tariff.team_id, p_at);
  if st.tariff_id is distinct from p_tariff.id and st.state <> 'internal' then
    return query select case when st.legacy_also then 'legacy' else 'blocked' end, st.legacy_also;
    return;
  end if;
  return query select st.state, st.legacy_also;
end;
$$;

create function private.admin_tariff_row(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tariff public.space_tariffs%rowtype;
  plan public.tariff_plans%rowtype;
  row_state record;
  owner_label text;
  team_label text;
  used integer := 0;
  invites integer := 0;
begin
  select * into tariff from public.space_tariffs where id = p_id;
  if tariff.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into plan from public.tariff_plans where code = tariff.plan_code;
  select * into row_state from private.space_tariff_row_state(tariff, now());
  select profile.display_name into owner_label from public.profiles as profile where profile.id = tariff.owner_id;
  if tariff.team_id is not null then
    select team.name into team_label from public.teams as team where team.id = tariff.team_id;
    used := private.team_seats_used(tariff.team_id);
    invites := private.team_pending_invites(tariff.team_id);
  end if;
  return jsonb_build_object(
    'id', tariff.id,
    'ownerEmail', tariff.owner_email::text,
    'ownerId', tariff.owner_id,
    'ownerName', owner_label,
    'teamId', tariff.team_id,
    'teamName', team_label,
    'planCode', tariff.plan_code,
    'planNameUk', plan.name_uk,
    'baseSeats', plan.base_seats,
    'extraSeats', tariff.extra_seats,
    'seatsTotal', plan.base_seats + tariff.extra_seats,
    'seatsUsed', used,
    'pendingInvites', invites,
    'startsAt', to_jsonb(tariff.starts_at),
    'endsOn', tariff.ends_on::text,
    'daysLeft', tariff.ends_on - private.kyiv_today(),
    'graceUntil', (tariff.ends_on + 3)::text,
    'revokedAt', to_jsonb(tariff.revoked_at),
    'state', row_state.state,
    'legacyAlso', coalesce(row_state.legacy_also, false),
    'source', tariff.source,
    'externalRef', tariff.external_ref,
    'note', tariff.note,
    'grantedBy', tariff.granted_by,
    'createdAt', to_jsonb(tariff.created_at),
    'updatedAt', to_jsonb(tariff.updated_at)
  );
end;
$$;

-- After an admin change: a space that closed stops its background work now; a space that
-- reopened gets one Drive reconciliation (R8). Both live in the background migration.
create function private.after_space_tariff_change(p_team uuid, p_was_allowed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  now_allowed boolean;
begin
  if p_team is null then
    return;
  end if;
  now_allowed := private.team_workspace_allowed(p_team);
  if p_was_allowed and not now_allowed then
    perform private.apply_tariff_pauses(p_team);
  elsif not p_was_allowed and now_allowed then
    perform private.resume_space_sync(p_team);
  end if;
end;
$$;

-- A grant or renewal letter, unless the space is internal or held by the legacy rule (US2.1).
create function private.queue_space_tariff_letter(p_tariff uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  tariff public.space_tariffs%rowtype;
  st text;
begin
  select * into tariff from public.space_tariffs where id = p_tariff;
  if tariff.id is null or tariff.revoked_at is not null then
    return;
  end if;
  if tariff.team_id is not null then
    select state.state into st from private.space_tariff_state(tariff.team_id, now()) as state;
    if st in ('legacy', 'internal') then
      return;
    end if;
  end if;
  insert into public.space_tariff_notices (tariff_id, kind, period_end)
  values (tariff.id, p_kind, tariff.ends_on)
  on conflict (tariff_id, kind, period_end) do nothing;
end;
$$;

revoke all on function private.require_tariff_admin() from public, anon, authenticated;
revoke all on function private.space_tariff_snapshot(public.space_tariffs) from public, anon, authenticated;
revoke all on function private.tariff_account_for_email(text) from public, anon, authenticated;
revoke all on function private.space_tariff_row_state(public.space_tariffs, timestamptz) from public, anon, authenticated;
revoke all on function private.admin_tariff_row(uuid) from public, anon, authenticated;
revoke all on function private.after_space_tariff_change(uuid, boolean) from public, anon, authenticated;
revoke all on function private.queue_space_tariff_letter(uuid, text) from public, anon, authenticated;

create function public.admin_list_tariff_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  return coalesce((
    select jsonb_agg(private.tariff_plan_json(plan) order by plan.sort_order, plan.code)
    from public.tariff_plans as plan where plan.active
  ), '[]'::jsonb);
end;
$$;

create function public.admin_list_space_tariffs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  return coalesce((
    select jsonb_agg(row_json order by
      case row_json ->> 'state'
        when 'grace' then 0 when 'expiring' then 1 when 'active' then 2 when 'legacy' then 3
        when 'internal' then 4 when 'pending' then 5 when 'pending_expired' then 6 else 7 end,
      row_json ->> 'endsOn', row_json ->> 'createdAt')
    from (
      select private.admin_tariff_row(tariff.id) as row_json
      from public.space_tariffs as tariff
      where tariff.revoked_at is null or tariff.revoked_at > now() - interval '30 days'
    ) as rows
  ), '[]'::jsonb);
end;
$$;

create function public.admin_list_owner_spaces(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account uuid;
begin
  perform private.require_tariff_admin();
  account := private.tariff_account_for_email(p_email);
  if account is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'teamId', team.id,
             'name', team.name,
             'membersUsed', private.team_seats_used(team.id),
             'boundTariffId', (
               select tariff.id from public.space_tariffs as tariff
               where tariff.team_id = team.id and tariff.revoked_at is null
             )
           ) order by team.created_at, team.id)
    from public.teams as team
    where team.owner_id = account and team.status = 'active'
  ), '[]'::jsonb);
end;
$$;

create function private.tariff_occupants(p_team uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(occupant order by occupant ->> 'kind' desc, occupant ->> 'email'), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'userId', member.user_id,
             'invitationId', null,
             'name', profile.display_name,
             'email', lower(btrim(users.email)),
             'role', case when team.owner_id = member.user_id then 'owner' else member.base_role end,
             'kind', 'member',
             'isOwner', team.owner_id = member.user_id,
             'isAdmin', exists (select 1 from public.admin_users as admin where admin.user_id = member.user_id)
           ) as occupant
    from public.team_members as member
    join public.teams as team on team.id = member.team_id
    left join public.profiles as profile on profile.id = member.user_id
    left join auth.users as users on users.id = member.user_id
    where member.team_id = p_team and member.status = 'active'
    union all
    select jsonb_build_object(
             'userId', invitation.target_user_id,
             'invitationId', invitation.id,
             'name', target.display_name,
             'email', invitation.target_email::text,
             'role', invitation.initial_role,
             'kind', 'invitation',
             'isOwner', false,
             'isAdmin', false
           )
    from public.team_invitations as invitation
    left join public.profiles as target on target.id = invitation.target_user_id
    where invitation.team_id = p_team and invitation.state = 'pending' and invitation.expires_at > now()
  ) as occupants;
$$;

revoke all on function private.tariff_occupants(uuid) from public, anon, authenticated;

create function public.admin_preview_space_tariff(p_email text, p_team uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  account uuid;
  used integer := 0;
  lead_seats integer;
begin
  perform private.require_tariff_admin();
  account := private.tariff_account_for_email(p_email);
  if p_team is not null and not exists (
    select 1 from public.teams as team
    where team.id = p_team and team.status = 'active' and team.owner_id = account
  ) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_team is not null then
    used := private.team_seats_used(p_team);
  end if;
  select plan.base_seats into lead_seats from public.tariff_plans as plan where plan.code = 'lead';
  return jsonb_build_object(
    'accountExists', account is not null,
    'ownerName', (select profile.display_name from public.profiles as profile where profile.id = account),
    'seatsUsed', used,
    'pendingInvites', case when p_team is null then 0 else private.team_pending_invites(p_team) end,
    'suggestedExtraSeats', greatest(0, used - coalesce(lead_seats, used)),
    'occupants', case when p_team is null then '[]'::jsonb
                      else (select jsonb_agg(occupant - 'isOwner' - 'isAdmin')
                            from jsonb_array_elements(private.tariff_occupants(p_team)) as occupant) end
  );
end;
$$;

create function private.checked_tariff_terms(p_plan text, p_extra_seats integer)
returns public.tariff_plans
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  plan public.tariff_plans%rowtype;
begin
  select * into plan from public.tariff_plans where code = p_plan and active;
  if plan.code is null
     or p_extra_seats is null or p_extra_seats < 0 or p_extra_seats > 1000
     or (p_extra_seats > 0 and not plan.extra_seats_allowed)
     or (plan.max_extra_seats is not null and p_extra_seats > plan.max_extra_seats) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  return plan;
end;
$$;

revoke all on function private.checked_tariff_terms(text, integer) from public, anon, authenticated;

create function public.admin_grant_space_tariff(
  p_email text,
  p_plan text,
  p_ends_on date,
  p_extra_seats integer,
  p_team uuid default null,
  p_note text default null,
  p_external_ref text default null,
  p_notify boolean default false,
  p_source text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  canonical_email text := lower(btrim(p_email));
  plan public.tariff_plans%rowtype;
  account uuid;
  was_allowed boolean := false;
  created public.space_tariffs%rowtype;
begin
  if canonical_email is null
     or canonical_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(canonical_email) > 320
     or coalesce(p_source, 'manual') not in ('manual', 'trial') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  plan := private.checked_tariff_terms(p_plan, coalesce(p_extra_seats, 0));
  if p_ends_on is null or p_ends_on < private.kyiv_today() then
    raise exception 'TARIFF_DATE_INVALID' using errcode = '22023';
  end if;
  account := private.tariff_account_for_email(canonical_email);

  if p_team is not null then
    perform 1 from public.teams as team
    where team.id = p_team and team.status = 'active' and team.owner_id = account
    for update;
    if not found or account is null then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
    if exists (select 1 from public.space_tariffs as tariff
               where tariff.team_id = p_team and tariff.revoked_at is null) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
    if plan.base_seats + coalesce(p_extra_seats, 0) < private.team_seats_used(p_team) then
      raise exception 'SEATS_IN_USE' using errcode = '22023';
    end if;
    was_allowed := private.team_workspace_allowed(p_team);
  elsif exists (
    select 1 from public.space_tariffs as tariff
    where tariff.team_id is null and tariff.revoked_at is null
      and lower(tariff.owner_email::text) = canonical_email
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;

  insert into public.space_tariffs (
    owner_email, owner_id, team_id, plan_code, extra_seats, ends_on, source, external_ref, note,
    granted_by, claimed_at, bound_at
  ) values (
    canonical_email, account, p_team, plan.code, coalesce(p_extra_seats, 0), p_ends_on,
    coalesce(p_source, 'manual'), nullif(btrim(p_external_ref), ''), nullif(btrim(p_note), ''),
    actor, case when account is not null then clock_timestamp() end,
    case when p_team is not null then clock_timestamp() end
  ) returning * into created;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, after)
  values (created.id, created.team_id, actor, 'granted',
          private.space_tariff_snapshot(created) || jsonb_build_object('notify', coalesce(p_notify, false)));

  if coalesce(p_notify, false) then
    perform private.queue_space_tariff_letter(created.id, 'granted');
  end if;
  perform private.after_space_tariff_change(p_team, was_allowed);
  return private.admin_tariff_row(created.id);
end;
$$;

create function public.admin_update_space_tariff(
  p_id uuid,
  p_plan text,
  p_ends_on date,
  p_extra_seats integer,
  p_note text,
  p_external_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  plan public.tariff_plans%rowtype;
  was_allowed boolean;
  new_ends date;
  new_extra integer;
begin
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous.revoked_at is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  new_ends := coalesce(p_ends_on, previous.ends_on);
  new_extra := coalesce(p_extra_seats, previous.extra_seats);
  plan := private.checked_tariff_terms(coalesce(p_plan, previous.plan_code), new_extra);
  if new_ends <> previous.ends_on and new_ends < private.kyiv_today() then
    raise exception 'TARIFF_DATE_INVALID' using errcode = '22023';
  end if;
  if previous.team_id is not null
     and plan.base_seats + new_extra < private.team_seats_used(previous.team_id) then
    raise exception 'SEATS_IN_USE' using errcode = '22023';
  end if;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set plan_code = plan.code,
         ends_on = new_ends,
         extra_seats = new_extra,
         note = nullif(btrim(p_note), ''),
         external_ref = nullif(btrim(p_external_ref), ''),
         updated_at = clock_timestamp()
   where tariff.id = p_id
  returning * into updated;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor, 'updated',
          private.space_tariff_snapshot(previous), private.space_tariff_snapshot(updated));
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id);
end;
$$;

-- +N months from the end date while the tariff still holds the space; from today once it has
-- stopped (suspended, revoked, or a pending grant whose date has passed).
create function public.admin_extend_space_tariff(
  p_id uuid,
  p_months integer,
  p_notify boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  row_state text;
  base_day date;
  was_allowed boolean;
  event_id uuid;
begin
  if p_months is null or p_months not between 1 and 36 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select state.state into row_state from private.space_tariff_row_state(previous, now()) as state;
  if previous.revoked_at is not null then
    -- Bringing a revoked tariff back must not create a second live one.
    if exists (
      select 1 from public.space_tariffs as other
      where other.id <> previous.id and other.revoked_at is null
        and ((previous.team_id is not null and other.team_id = previous.team_id)
             or (previous.team_id is null and other.team_id is null
                 and lower(other.owner_email::text) = lower(previous.owner_email::text)))
    ) then
      raise exception 'TARIFF_BOUND' using errcode = 'P0001';
    end if;
  end if;
  base_day := case
    when previous.revoked_at is not null or row_state in ('blocked', 'pending_expired')
         or (row_state = 'legacy' and previous.ends_on + 3 < private.kyiv_today())
      then private.kyiv_today()
    else previous.ends_on
  end;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set ends_on = (base_day + make_interval(months => p_months))::date,
         revoked_at = null,
         updated_at = clock_timestamp()
   where tariff.id = p_id
  returning * into updated;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor, 'extended', private.space_tariff_snapshot(previous),
          private.space_tariff_snapshot(updated) || jsonb_build_object('notify', coalesce(p_notify, false)))
  returning id into event_id;

  if coalesce(p_notify, false) then
    perform private.queue_space_tariff_letter(p_id, 'renewed');
  end if;
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id) || jsonb_build_object('eventId', event_id);
end;
$$;

-- p_now = false: the term ends today and the three extra days follow. p_now = true: closed now.
-- A grant still waiting (no space or no account yet) is cancelled either way.
create function public.admin_end_space_tariff(p_id uuid, p_now boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  previous public.space_tariffs%rowtype;
  updated public.space_tariffs%rowtype;
  was_allowed boolean;
  waiting boolean;
begin
  select * into previous from public.space_tariffs where id = p_id for update;
  if previous.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if previous.revoked_at is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  waiting := previous.team_id is null;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  if coalesce(p_now, false) or waiting then
    -- Transaction time, which the gate compares against: the space closes within this call.
    update public.space_tariffs as tariff
       set revoked_at = now(), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  else
    update public.space_tariffs as tariff
       set ends_on = least(tariff.ends_on, private.kyiv_today()), updated_at = clock_timestamp()
     where tariff.id = p_id
    returning * into updated;
  end if;

  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (p_id, updated.team_id, actor,
          case when coalesce(p_now, false) or waiting then 'ended_now' else 'ended_today' end,
          private.space_tariff_snapshot(previous), private.space_tariff_snapshot(updated));
  perform private.after_space_tariff_change(updated.team_id, was_allowed);
  return private.admin_tariff_row(p_id);
end;
$$;

-- Only the tariff's latest change of these kinds, within ten minutes.
create function private.space_tariff_event_undoable(p_event public.space_tariff_events)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_event.kind in ('extended', 'updated', 'ended_today', 'ended_now')
    and p_event.undone_at is null
    and p_event.tariff_id is not null
    and p_event.created_at > now() - interval '10 minutes'
    and not exists (
      select 1 from public.space_tariff_events as later
      where later.tariff_id = p_event.tariff_id
        and (later.created_at > p_event.created_at
             or (later.created_at = p_event.created_at and later.id > p_event.id))
        and later.kind not in ('claimed', 'member_removed', 'invitation_revoked')
    );
$$;

revoke all on function private.space_tariff_event_undoable(public.space_tariff_events) from public, anon, authenticated;

create function public.admin_undo_space_tariff_event(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  event public.space_tariff_events%rowtype;
  previous public.space_tariffs%rowtype;
  restored public.space_tariffs%rowtype;
  was_allowed boolean;
begin
  select * into event from public.space_tariff_events where id = p_event for update;
  if event.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into previous from public.space_tariffs where id = event.tariff_id for update;
  if previous.id is null or not private.space_tariff_event_undoable(event) or event.before is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if previous.revoked_at is not null and (event.before ->> 'revokedAt') is null and exists (
    select 1 from public.space_tariffs as other
    where other.id <> previous.id and other.revoked_at is null
      and ((previous.team_id is not null and other.team_id = previous.team_id)
           or (previous.team_id is null and other.team_id is null
               and lower(other.owner_email::text) = lower(previous.owner_email::text)))
  ) then
    raise exception 'TARIFF_BOUND' using errcode = 'P0001';
  end if;
  was_allowed := private.team_workspace_allowed(previous.team_id);

  update public.space_tariffs as tariff
     set plan_code = event.before ->> 'planCode',
         ends_on = (event.before ->> 'endsOn')::date,
         extra_seats = (event.before ->> 'extraSeats')::integer,
         note = event.before ->> 'note',
         external_ref = event.before ->> 'externalRef',
         revoked_at = (event.before ->> 'revokedAt')::timestamptz,
         updated_at = clock_timestamp()
   where tariff.id = previous.id
  returning * into restored;

  update public.space_tariff_events set undone_at = clock_timestamp() where id = event.id;
  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, before, after)
  values (previous.id, restored.team_id, actor, 'undone',
          private.space_tariff_snapshot(previous),
          private.space_tariff_snapshot(restored) || jsonb_build_object('undoneEventId', event.id,
                                                                         'undoneKind', event.kind));
  perform private.after_space_tariff_change(restored.team_id, was_allowed);
  return private.admin_tariff_row(previous.id);
end;
$$;

create function public.admin_list_space_tariff_events(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  if p_id is null then
    -- The settings history has no tariff.
    return coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', event.id, 'tariffId', null, 'actorId', event.actor_id,
               'actorName', profile.display_name, 'kind', 'settings',
               'before', event.before, 'after', event.after,
               'createdAt', to_jsonb(event.created_at), 'undoable', false
             ) order by event.created_at desc, event.id desc)
      from public.tariff_settings_events as event
      left join public.profiles as profile on profile.id = event.actor_id
    ), '[]'::jsonb);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', event.id, 'tariffId', event.tariff_id, 'actorId', event.actor_id,
             'actorName', profile.display_name, 'kind', event.kind,
             'before', event.before, 'after', event.after,
             'createdAt', to_jsonb(event.created_at),
             'undoable', private.space_tariff_event_undoable(event)
           ) order by event.created_at desc, event.id desc)
    from public.space_tariff_events as event
    left join public.profiles as profile on profile.id = event.actor_id
    where event.tariff_id = p_id
  ), '[]'::jsonb);
end;
$$;

create function public.admin_list_tariff_seats(p_team uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  if not exists (select 1 from public.teams as team where team.id = p_team) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  return private.tariff_occupants(p_team);
end;
$$;

create function public.admin_remove_tariff_member(p_team uuid, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  canonical_owner uuid;
begin
  select team.owner_id into canonical_owner
  from public.teams as team where team.id = p_team and team.status = 'active' for update;
  if canonical_owner is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_user = canonical_owner then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_members as member
     set status = 'removed', removed_at = clock_timestamp(), updated_at = clock_timestamp()
   where member.team_id = p_team and member.user_id = p_user and member.status = 'active';
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform private.revoke_team_transfer_grants(p_team, p_user);
  perform private.record_team_audit(
    p_team, actor, 'membership.removed',
    jsonb_build_object('member_id', p_user, 'warning_code', 'EXTERNAL_DRIVE_ACCESS_REMAINS'),
    'succeeded', null
  );
  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, after)
  values ((select current_tariff.id from private.team_current_tariff(p_team) as current_tariff),
          p_team, actor, 'member_removed', jsonb_build_object('userId', p_user));
  return true;
end;
$$;

create function public.admin_revoke_tariff_invitation(p_invitation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  invitation_team uuid;
begin
  update public.team_invitations as invitation
     set state = 'revoked',
         responded_at = clock_timestamp(),
         accept_token_hash = decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex')
   where invitation.id = p_invitation and invitation.state = 'pending'
  returning invitation.team_id into invitation_team;
  if invitation_team is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform private.record_team_audit(
    invitation_team, actor, 'invitation.revoked',
    jsonb_build_object('invitation_id', p_invitation), 'succeeded', null
  );
  insert into public.space_tariff_events (tariff_id, team_id, actor_id, kind, after)
  values ((select current_tariff.id from private.team_current_tariff(invitation_team) as current_tariff),
          invitation_team, actor, 'invitation_revoked', jsonb_build_object('invitationId', p_invitation));
  return true;
end;
$$;

-- Spaces that only the legacy rule opens: an admin is a member, the owner is not an admin, and no
-- tariff holds them. Counted whether or not the rule is on.
create function private.legacy_only_spaces()
returns table (team_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select team.id
  from public.teams as team
  where team.status = 'active'
    and private.team_legacy_open(team.id)
    and not exists (select 1 from public.admin_users as owner_admin where owner_admin.user_id = team.owner_id)
    and not exists (
      select 1 from public.space_tariffs as tariff
      where tariff.team_id = team.id
        and (tariff.revoked_at is null or tariff.revoked_at > now())
        and now() < private.kyiv_day_end(tariff.ends_on + 3)
    );
$$;

revoke all on function private.legacy_only_spaces() from public, anon, authenticated;

create function public.admin_list_legacy_spaces()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'teamId', team.id,
             'name', team.name,
             'ownerEmail', lower(btrim(users.email)),
             'ownerName', profile.display_name,
             'membersUsed', private.team_seats_used(team.id)
           ) order by team.created_at, team.id)
    from private.legacy_only_spaces() as legacy
    join public.teams as team on team.id = legacy.team_id
    left join auth.users as users on users.id = team.owner_id
    left join public.profiles as profile on profile.id = team.owner_id
  ), '[]'::jsonb);
end;
$$;

create function public.admin_list_space_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'userId', entry.user_id,
             'email', entry.email,
             'name', profile.display_name,
             'planInterest', entry.plan_interest,
             'channel', entry.channel,
             'createdAt', to_jsonb(entry.created_at),
             'lastContactAt', to_jsonb(entry.last_contact_at),
             'handledAt', to_jsonb(entry.handled_at),
             'adminNote', entry.admin_note,
             'hasTariff', exists (
               select 1 from public.space_tariffs as tariff
               where tariff.revoked_at is null
                 and (tariff.owner_id = entry.user_id
                      or lower(tariff.owner_email::text) = lower(btrim(entry.email)))
             )
           ) order by entry.handled_at is not null, coalesce(entry.last_contact_at, entry.created_at) desc)
    from public.team_workspace_waitlist as entry
    left join public.profiles as profile on profile.id = entry.user_id
  ), '[]'::jsonb);
end;
$$;

create function public.admin_mark_space_request(p_user uuid, p_handled boolean, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  if p_note is not null and char_length(p_note) > 2000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  update public.team_workspace_waitlist as entry
     set handled_at = case when coalesce(p_handled, false) then clock_timestamp() end,
         admin_note = coalesce(nullif(btrim(p_note), ''), entry.admin_note)
   where entry.user_id = p_user;
  return found;
end;
$$;

create function private.tariff_settings_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'telegram', settings.admin_telegram,
    'email', settings.admin_email,
    'legacyRuleEnabled', coalesce(settings.legacy_rule_enabled, true),
    'legacySpacesRemaining', (select count(*)::integer from private.legacy_only_spaces())
  )
  from (select 1) as anchor
  left join public.tariff_settings as settings on settings.id;
$$;

revoke all on function private.tariff_settings_json() from public, anon, authenticated;

create function public.admin_get_tariff_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_tariff_admin();
  return private.tariff_settings_json();
end;
$$;

create function public.admin_set_tariff_settings(
  p_telegram text,
  p_email text,
  p_legacy_rule_enabled boolean,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := private.require_tariff_admin();
  telegram text := nullif(regexp_replace(btrim(coalesce(p_telegram, '')), '^@', ''), '');
  contact_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  before_json jsonb := private.tariff_settings_json();
  was_enabled boolean := private.tariff_legacy_rule_enabled();
  enabled boolean := coalesce(p_legacy_rule_enabled, was_enabled);
  after_json jsonb;
begin
  if (telegram is not null and telegram !~ '^[A-Za-z0-9_]{5,32}$')
     or (contact_email is not null and (
           contact_email !~ '^[^[:space:]@<>"'']+@[^[:space:]@<>"'']+\.[^[:space:]@<>"'']+$'
           or char_length(contact_email) > 320)) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if was_enabled and not enabled and not coalesce(p_confirm, false)
     and exists (select 1 from private.legacy_only_spaces()) then
    raise exception 'LEGACY_SPACES_REMAIN' using errcode = 'P0001';
  end if;

  insert into public.tariff_settings (id, admin_telegram, admin_email, legacy_rule_enabled, updated_at, updated_by)
  values (true, telegram, contact_email, enabled, clock_timestamp(), actor)
  on conflict (id) do update
    set admin_telegram = excluded.admin_telegram,
        admin_email = excluded.admin_email,
        legacy_rule_enabled = excluded.legacy_rule_enabled,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;

  after_json := private.tariff_settings_json();
  insert into public.tariff_settings_events (actor_id, before, after)
  values (actor, before_json, after_json);

  if was_enabled and not enabled then
    -- The spaces the rule held are suspended now, background work included.
    perform private.apply_tariff_pauses(null);
  end if;
  return after_json;
end;
$$;

revoke all on function public.admin_list_tariff_plans() from public, anon;
revoke all on function public.admin_list_space_tariffs() from public, anon;
revoke all on function public.admin_list_owner_spaces(text) from public, anon;
revoke all on function public.admin_preview_space_tariff(text, uuid) from public, anon;
revoke all on function public.admin_grant_space_tariff(text, text, date, integer, uuid, text, text, boolean, text) from public, anon;
revoke all on function public.admin_update_space_tariff(uuid, text, date, integer, text, text) from public, anon;
revoke all on function public.admin_extend_space_tariff(uuid, integer, boolean) from public, anon;
revoke all on function public.admin_end_space_tariff(uuid, boolean) from public, anon;
revoke all on function public.admin_undo_space_tariff_event(uuid) from public, anon;
revoke all on function public.admin_list_space_tariff_events(uuid) from public, anon;
revoke all on function public.admin_list_tariff_seats(uuid) from public, anon;
revoke all on function public.admin_remove_tariff_member(uuid, uuid) from public, anon;
revoke all on function public.admin_revoke_tariff_invitation(uuid) from public, anon;
revoke all on function public.admin_list_legacy_spaces() from public, anon;
revoke all on function public.admin_list_space_requests() from public, anon;
revoke all on function public.admin_mark_space_request(uuid, boolean, text) from public, anon;
revoke all on function public.admin_get_tariff_settings() from public, anon;
revoke all on function public.admin_set_tariff_settings(text, text, boolean, boolean) from public, anon;

grant execute on function public.admin_list_tariff_plans() to authenticated;
grant execute on function public.admin_list_space_tariffs() to authenticated;
grant execute on function public.admin_list_owner_spaces(text) to authenticated;
grant execute on function public.admin_preview_space_tariff(text, uuid) to authenticated;
grant execute on function public.admin_grant_space_tariff(text, text, date, integer, uuid, text, text, boolean, text) to authenticated;
grant execute on function public.admin_update_space_tariff(uuid, text, date, integer, text, text) to authenticated;
grant execute on function public.admin_extend_space_tariff(uuid, integer, boolean) to authenticated;
grant execute on function public.admin_end_space_tariff(uuid, boolean) to authenticated;
grant execute on function public.admin_undo_space_tariff_event(uuid) to authenticated;
grant execute on function public.admin_list_space_tariff_events(uuid) to authenticated;
grant execute on function public.admin_list_tariff_seats(uuid) to authenticated;
grant execute on function public.admin_remove_tariff_member(uuid, uuid) to authenticated;
grant execute on function public.admin_revoke_tariff_invitation(uuid) to authenticated;
grant execute on function public.admin_list_legacy_spaces() to authenticated;
grant execute on function public.admin_list_space_requests() to authenticated;
grant execute on function public.admin_mark_space_request(uuid, boolean, text) to authenticated;
grant execute on function public.admin_get_tariff_settings() to authenticated;
grant execute on function public.admin_set_tariff_settings(text, text, boolean, boolean) to authenticated;
