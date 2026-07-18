# Rollback notes

These migrations create the complete Wishly account and analytics foundation. Prefer a database backup and a forward-fix after production data exists.

For an empty development project, roll back in reverse order:

1. Drop the seven `admin_*` functions from `20260718212000_admin_functions.sql`.
2. Drop `public.analytics_events`, then `public.analytics_properties_are_safe(jsonb)`.
3. Drop the `on_auth_user_created` trigger on `auth.users`.
4. Drop `public.admin_users` and `public.profiles`.
5. Drop `public.touch_last_seen()`, `public.is_admin()`, `public.handle_new_user()`, `public.set_marketing_consent_time()` and `public.set_updated_at()`.

Dropping `profiles` permanently removes user preferences and consent history. Dropping `analytics_events` permanently removes product analytics. Do not run a destructive rollback against production without exporting the required records and confirming the retention policy first.
