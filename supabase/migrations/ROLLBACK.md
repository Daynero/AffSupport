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

## Team media workspace migrations (development recovery only)

These are forward-only production migrations. Prefer a backup plus a forward fix after any
team has connected storage. For an empty isolated development database, reverse the
feature group in this exact order:

0. `20260810090000_team_landing_renders.sql` (feature 004 — newest, reverse first): revoke and
   drop `public.list_landing_renders(uuid, uuid[], text)`,
   `public.service_start_landing_render(uuid, uuid, uuid, text, text, text)`,
   `public.service_commit_landing_render(uuid, text, integer, text)`,
   `public.service_fail_landing_render(uuid, text)`, and
   `public.service_mark_landing_renders_stale(uuid, uuid)`; then drop
   `public.team_landing_renders`. The table is intentionally not in `supabase_realtime`, so no
   publication change is needed. If a test connection produced render artifacts, delete the
   hidden `.soty/landing-previews/` subtree through the service path first; this rollback never
   deletes source landing files.
1. `20260802100000_team_direct_member_testing.sql`: revoke and drop
   `public.service_direct_add_registered_member(uuid,uuid,text,text)`. Disable
   `TEAM_DIRECT_ADD_MODE` in Edge and web before rollback. Existing memberships are normal
   team memberships and must not be deleted; matching invitations intentionally remain in
   their recorded terminal state.
2. `20260801103000_team_analytics.sql`: revoke/drop
   `public.analytics_team_workspace`, then drop `private.team_pilot_enrollments`. Restore the
   prior `public.analytics_properties_are_safe_v2(jsonb)` body from
   `20260720130000_analytics_v2.sql`; do not drop it because analytics ingestion depends on
   that function. Export pilot interval evidence first if it must be retained.
3. `20260801102000_team_transfer_operations.sql`: revoke/drop `get_operation`,
   `get_material_provenance`, `cancel_team_operation`, and every `service_*` operation,
   source-binding, folder-resolution, transition/finalize/edit/mutation function introduced
   there. Then drop `private.team_operation_intents`. Reconcile any Drive-succeeded operation
   before removal; this rollback never deletes or rewrites its provider file.
4. `20260801101500_team_preview.sql`: revoke/drop `get_material_preview`,
   `service_get_material_transfer_context`, and
   `service_commit_landing_preview_validation`. Revoke outstanding preview grants through the
   existing service path first; cached agent preview directories are cleaned by agent shutdown,
   not by database rollback.
5. `20260801101000_team_catalog_search.sql`: unschedule only the named
   `wishly-team-catalog-sync` Cron job, revoke/drop all search/vocabulary/metadata and catalog
   worker `service_*` functions plus `private.invoke_catalog_sync_worker`; drop
   `team_materials_refresh_search`, its trigger, the search/facet/missing-value indexes, and
   the three landing/transcript identity constraints. Preserve or export transcript/catalog
   rows before removing search support.
6. `20260801100000_team_membership_actions.sql`: revoke/drop `list_team_members`,
   `update_membership`, `remove_member`, `transfer_ownership`, `list_team_audit_events`,
   `owned_team_count`, and `service_revoke_user_team_grants`. Transfer ownership or archive
   affected test teams first so account recovery never creates an ownerless team.
7. `20260801095000_team_invitation_drive_actions.sql`: drop the caller RPCs
   `create_team`, `list_my_teams`, `lookup_invitable_account`, every invitation action,
   `get_drive_connection_status`, and `list_team_materials`; then drop all public
   `service_*` Drive/OAuth functions and the private helpers
   `team_confirmed_email`, `team_expire_invitations`,
   `team_invitation_identity_matches`, and `upsert_google_drive_credential`. Revoke
   service/client grants before dropping. Detach/revoke any test credential through the
   service path first; this rollback never deletes Google Drive files.
8. `20260801094000_team_security_foundation.sql`: remove `team_operations` and
   `team_catalog_events` from `supabase_realtime`; drop the team RLS policies and triggers;
   revoke/drop every function in `private` created by the migration. Do this before dropping
   their backing tables so no definer or policy is left with a broken dependency.
9. `20260801093000_team_operations_audit.sql`: drop `public.team_catalog_events`,
   `public.team_audit_events`, `private.catalog_sync_jobs`,
   `private.team_transfer_grants`, then `public.team_operations`. This permanently removes
   operation recovery, leases, grants, and audit history.
10. `20260801092000_drive_vault_catalog.sql`: detach test connections first; delete their
    Vault secrets through the service accessor; then drop `public.team_material_links`,
    `public.team_materials`, `public.team_drive_connections`,
    `private.drive_oauth_transactions`, and `private.google_drive_credentials`. Drop the
    `private` schema only if no other migration uses it. No Google Drive file is deleted by
    these database steps.
11. `20260801091000_teams_members_invitations.sql`: drop
    `public.team_invitations`, `public.team_members`, and `public.teams`. Keep the `citext`
    extension if another feature uses it.
12. `20260801090000_team_contract_seed.sql`: drop `public.language_options`,
    `public.geo_options`, `public.team_error_codes`, `public.role_permissions`,
    `public.team_permissions`, `public.team_roles`, and finally
    `public.team_contract_settings`.

Never automate this recovery sequence against production. Export audit/provenance/catalog
records and confirm Vault/Google credential revocation before any destructive rollback.
