# Rollback notes

These migrations create the complete Wishly account and analytics foundation. Prefer a database backup and a forward-fix after production data exists.

For an empty development project, roll back in reverse order:

0. From `20260731120000_support_goals.sql`: remove `public.support_goals` from the `supabase_realtime` publication, drop `public.admin_update_support_goal_amount(uuid, bigint)` and `public.admin_active_support_goal()`, then drop `public.support_goals`. This removes only the published aggregate goal progress; no donor records exist.
1. From `20260719130000_analytics_readonly.sql`: drop policy `analytics_readonly_select` on `public.analytics_events`, `revoke` the grants and `drop role wishly_analytics_ro` (reassign/drop owned objects first if any), then `drop view public.analytics_users`. This role/view are read-only and safe to recreate by re-running the migration.
2. Drop the seven `admin_*` functions from `20260718212000_admin_functions.sql`.
3. Drop `public.analytics_events`, then `public.analytics_properties_are_safe(jsonb)`.
4. Drop the `on_auth_user_created` trigger on `auth.users`.
5. Drop `public.admin_users` and `public.profiles`.
6. Drop `public.touch_last_seen()`, `public.is_admin()`, `public.handle_new_user()`, `public.set_marketing_consent_time()` and `public.set_updated_at()`.

Dropping `profiles` permanently removes user preferences and consent history. Dropping `analytics_events` permanently removes product analytics. Do not run a destructive rollback against production without exporting the required records and confirming the retention policy first.
