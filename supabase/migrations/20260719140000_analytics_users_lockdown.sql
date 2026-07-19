-- Corrective, non-destructive lockdown for public.analytics_users.
--
-- The view was created SECURITY DEFINER (runs as owner, bypassing RLS on
-- profiles and reading auth.users). Supabase's default privileges grant
-- anon/authenticated SELECT on new public objects, which made the view — and
-- therefore every user's email and last-login — readable through PostgREST with
-- the public anon key. This migration removes that access. Only the read-only
-- CLI role (wishly_analytics_ro) may read the view, over a direct connection.
--
-- Safe to run repeatedly; touches privileges only, never data.

revoke all on public.analytics_users from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'wishly_analytics_ro') then
    grant select on public.analytics_users to wishly_analytics_ro;
  end if;
end
$$;
