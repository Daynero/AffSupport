# Validation

Use existing beta without reset. Run focused Vitest catalog suites with one worker, then npm run verify. Open beta manager at 127.0.0.1:5175 in Chrome.

Inspect two actual catalogs, 1280x800/1440x900 and 390x844, dark/light, uk/en, keyboard and zoom. Confirm readable names/facts, filters closed initially, no defaults footer, single Save panel, dirty close guard, realtime draft preservation, context return. Select multiple rows: compact toolbar first, explicit bulk editor, partial results and hidden-selection scope.

Check history failure→success disables obsolete retry. Verify defaults in space settings do not mutate existing profiles. Regression tests cover save failures/conflicts, reconciliation and permissions. Performance fixtures 2/50/500; report actual timing limitations. Ten participant usability sessions remain a separate acceptance requirement and cannot be fabricated.

## Outcome evidence migration and rollback

`20261204100000_catalog_profile_latest_result.sql` adds read-only latest outcome and verified full-success timestamps to the guarded profile RPC. Apply only through the environment's migration workflow. It does not rewrite attempts, schedules or catalog content. Verify empty history, partial/cancelled/unknown after success, and missing verification with `tests/team-product-catalog-sql.test.ts`.

For rollback, deploy the preceding web build first. In a reviewed follow-up migration, drop `public.list_team_catalog_update_profiles(uuid)`, restore its exact definition from `20261203110000_catalog_manager_profiles.sql` (the original return columns), then restore the same revoke/grant statements: revoke all from public/anon/authenticated, grant execute to authenticated. Perform replacement in one transaction. Do not delete history or run a database reset. The web parser supports the older response by treating missing evidence as unknown.

## Inline controls addendum

Current UI and review evidence: [icon-controls/acceptance.md](icon-controls/acceptance.md). Individual fields now save immediately; bulk and defaults retain explicit application. The owner scoped verification to desktop.

When applying the migration chain to an isolated test environment, include `20261204110000_catalog_dispatch_preserve_launch_recovery.sql` after the profile/outcome migrations: it preserves shared Launch wake-ups alongside catalog reconciliation. Do not reset configured beta data. The existing local beta received only this function update, with unchanged profile/schedule hashes.
