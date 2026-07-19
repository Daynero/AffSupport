-- Developer-side read-only analytics access.
--
-- This migration adds a dedicated, least-privilege PostgreSQL role and a small
-- read surface used exclusively by the local analytics CLI (scripts/analytics).
-- It never touches product data or the existing admin RPCs. The role can only
-- SELECT the analytics event stream and a privacy-scoped user directory, and it
-- is forced into read-only transactions so writes are impossible even by mistake.

-- 1. Privacy-scoped user directory ------------------------------------------------
--    A SECURITY DEFINER view (runs as the owner, which bypasses profiles RLS and
--    can read auth.users) so the read-only role never gets direct access to the
--    profiles table or the auth schema. Exposes only the columns the CLI needs.
create or replace view public.analytics_users
with (security_invoker = off) as
select
  profiles.id,
  profiles.email,
  lower(profiles.email) as email_normalized,
  profiles.display_name,
  profiles.language,
  profiles.plan,
  profiles.account_status,
  profiles.marketing_consent,
  profiles.created_at as registered_at,
  profiles.last_seen_at,
  users.last_sign_in_at as last_login_at
from public.profiles as profiles
left join auth.users as users on users.id = profiles.id;

comment on view public.analytics_users is
  'Privacy-scoped user directory for the read-only analytics CLI; no auth secrets or raw metadata.';

-- 2. Dedicated least-privilege role ----------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    -- Created without a password: it cannot authenticate until an operator sets
    -- one out-of-band (see docs/ANALYTICS_CLI.md). No secret ever lives in git.
    create role wishly_analytics_ro with
      login
      nosuperuser
      nocreatedb
      nocreaterole
      noreplication
      nobypassrls
      connection limit 4;
  end if;
end
$$;

-- Belt-and-suspenders: every transaction this role opens is read-only, so even a
-- future accidental write grant cannot mutate data.
alter role wishly_analytics_ro set default_transaction_read_only = on;
-- Keep ad-hoc analytics queries from ever pinning the database.
alter role wishly_analytics_ro set statement_timeout = '30s';
alter role wishly_analytics_ro set idle_in_transaction_session_timeout = '60s';

-- 3. Minimal read grants ----------------------------------------------------------
-- analytics_users is SECURITY DEFINER (runs as owner, bypassing RLS on profiles
-- and reading auth.users), so it must NEVER be reachable through PostgREST/anon.
-- Supabase's default privileges grant anon/authenticated SELECT on new public
-- objects, so revoke that first, then grant only to the read-only CLI role.
revoke all on public.analytics_users from public, anon, authenticated;

grant usage on schema public to wishly_analytics_ro;
grant select on public.analytics_events to wishly_analytics_ro;
grant select on public.analytics_users to wishly_analytics_ro;

-- analytics_events has RLS enabled and its only SELECT policy targets admins.
-- Add an explicit, read-only policy so this role can read the full event stream.
-- (The role holds no INSERT/UPDATE/DELETE grant, so this stays read-only.)
drop policy if exists analytics_readonly_select on public.analytics_events;
create policy analytics_readonly_select
on public.analytics_events
for select
to wishly_analytics_ro
using (true);

comment on role wishly_analytics_ro is
  'Least-privilege read-only role for the local analytics CLI. SELECT-only, forced read-only transactions.';
