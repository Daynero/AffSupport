-- Beta staging fixtures.
--
-- The minimum needed to begin an end-to-end journey immediately after a reset:
-- one account you can sign in as, one workspace it owns, and one media item.
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

commit;
