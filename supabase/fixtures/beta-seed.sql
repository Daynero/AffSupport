-- Beta staging fixtures.
--
-- The minimum needed to begin an end-to-end journey immediately after a reset:
-- one account you can sign in as and one workspace it owns. Drive media is
-- intentionally absent until a test Google account is connected in beta.
-- Nothing here is copied from production; every identifier is fixed so a reset
-- is reproducible and assertions can name what they expect.
--
-- Applied explicitly by scripts/beta-reset.mjs, deliberately NOT wired in as
-- config.toml's shared seed: ordinary local development must keep its own
-- behaviour rather than inheriting beta's fixtures.
--
-- Credentials: beta@soty.local / beta-password

begin;

-- Idempotent: a reset re-applies this file over a freshly migrated database,
-- but re-running it against an already-seeded one must not fail.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated',
  'authenticated',
  'beta@soty.local',
  extensions.crypt('beta-password', extensions.gen_salt('bf')),
  now(),
  '',
  '',
  '',
  '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Beta Tester"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '11111111-1111-4111-8111-111111111112',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-111111111111',
  '{"sub":"11111111-1111-4111-8111-111111111111","email":"beta@soty.local","email_verified":true}'::jsonb,
  'email',
  now(),
  now(),
  now()
)
on conflict (id) do nothing;

-- account_status must be 'active' or the entitlement path refuses to issue a
-- token, which would make pairing untestable.
insert into public.profiles (id, email, display_name, language, plan, account_status)
values (
  '11111111-1111-4111-8111-111111111111',
  'beta@soty.local',
  'Beta Tester',
  'en',
  'team',
  'active'
)
on conflict (id) do update
  set account_status = 'active',
      plan = excluded.plan,
      display_name = excluded.display_name;

insert into public.teams (id, name, owner_id, status)
values (
  '22222222-2222-4222-8222-222222222222',
  'Beta Workspace',
  '11111111-1111-4111-8111-111111111111',
  'active'
)
on conflict (id) do nothing;

insert into public.team_members (id, team_id, user_id, base_role, status)
values (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'admin',
  'active'
)
on conflict (id) do nothing;

-- The pilot gate (private.team_workspace_allowed) unlocks a space only when one
-- of its active members is also in public.admin_users. Without this row the
-- fixture workspace exists but list_my_teams returns nothing and
-- can_access_team_workspace is false, so beta cannot exercise any team flow --
-- which is precisely what beta is for. This is the product's own allowlist,
-- applied to a local-only account, and never reaches production.
insert into public.admin_users (user_id)
values ('11111111-1111-4111-8111-111111111111')
on conflict (user_id) do nothing;

-- Launch form sources that do not depend on a Google connection. The creative
-- library remains empty until beta Drive is explicitly connected and indexed.
insert into public.team_accounts (id, team_id, created_by, name)
values (
  '44444444-4444-4444-8444-444444444441',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'g1'
)
on conflict (id) do nothing;

insert into public.team_account_agents (id, team_id, account_id, created_by, agent_id)
values (
  '44444444-4444-4444-8444-444444444442',
  '22222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444441',
  '11111111-1111-4111-8111-111111111111',
  '1234567892'
)
on conflict (id) do nothing;

insert into public.team_launch_offers (id, team_id, name, normalized_key, created_by)
values (
  '44444444-4444-4444-8444-444444444443',
  '22222222-2222-4222-8222-222222222222',
  'ProCaps TR',
  'procaps tr',
  '11111111-1111-4111-8111-111111111111'
)
on conflict (id) do nothing;

insert into public.team_launch_buyers (id, team_id, value, normalized_key, created_by)
values (
  '44444444-4444-4444-8444-444444444444',
  '22222222-2222-4222-8222-222222222222',
  'patrik',
  'patrik',
  '11111111-1111-4111-8111-111111111111'
)
on conflict (id) do nothing;

-- Non-admin fixture for real access testing through the beta login screen.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  '55555555-5555-4555-8555-555555555551',
  'authenticated',
  'authenticated',
  'member@soty.local',
  extensions.crypt('beta-member-password', extensions.gen_salt('bf')),
  now(),
  '',
  '',
  '',
  '',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Beta Member"}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  '55555555-5555-4555-8555-555555555552',
  '55555555-5555-4555-8555-555555555551',
  '55555555-5555-4555-8555-555555555551',
  '{"sub":"55555555-5555-4555-8555-555555555551","email":"member@soty.local","email_verified":true}'::jsonb,
  'email',
  now(),
  now(),
  now()
)
on conflict (id) do nothing;

-- account_status must be 'active' or the entitlement path refuses to issue a
-- token, which would make pairing untestable.
insert into public.profiles (id, email, display_name, language, plan, account_status)
values (
  '55555555-5555-4555-8555-555555555551',
  'member@soty.local',
  'Beta Member',
  'en',
  'team',
  'active'
)
on conflict (id) do update
  set account_status = 'active',
      plan = excluded.plan,
      display_name = excluded.display_name;


insert into public.team_members(id, team_id, user_id, base_role, status)
values ('55555555-5555-4555-8555-555555555553', '22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555551', 'viewer', 'active')
on conflict do nothing;

commit;
