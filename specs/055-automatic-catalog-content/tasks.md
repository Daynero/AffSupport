# Tasks: Automatic catalog content

Input: [spec.md](spec.md), [plan.md](plan.md), research/data model/contracts/quickstart. Tests are required by the spec's acceptance criteria and the owner's failure/recovery request.

## Phase1 — Setup

- [x] T001 Isolate 055 from the ongoing integration verifier and record source/policy decisions in specs/055-automatic-catalog-content/research.md.

## Phase2 — Foundation

- [x] T002 Fix shared API, legacy discriminator, UI compatibility and diagnostic boundaries in specs/055-automatic-catalog-content/contracts/content.md.
- [x] T003 Write shared-pool/category/unknown/exhaustion regressions in tests/catalog-automatic-content.test.ts, then implement packages/shared/src/team/catalog-content.ts and export through packages/shared/src/team/index.ts.

## Phase3 — US1: create without setup

Goal: new standalone/Launch catalogs work with no configured pool/prices. Independent test: full-chain creation returns complete matching rows in an empty-settings space.

- [x] T004 [P] [US1] Add automatic creation and legacy intent/source preservation regressions in tests/catalog-automatic-content-storage.test.ts and tests/catalog-automatic-creation.test.ts.
- [x] T005 [US1] Add server-owned intent policy marker, legacy/new source hashes and atomic resource freezing in supabase/migrations/20261208120000_automatic_catalog_content.sql.
- [x] T006 [US1] Add image-first automatic row planning, neutral unsupported material/size/pattern fields and strict metadata parsing in supabase/functions/_shared/product-catalog.ts and supabase/functions/_shared/catalog-image-rows.ts, retaining legacy rendering.
- [x] T007 [US1] Remove saved-settings prerequisite for automatic intents and preserve frozen row/sheet recipes in supabase/functions/drive-ops/catalog-durable.ts, supabase/functions/drive-ops/product-catalog.ts and supabase/functions/drive-ops/index.ts.

## Phase4 — US2: stable refresh/recovery

Goal: intentional new content uses the policy; retries and retained rows do not reroll. Independent test: unchanged/unknown write recovery retains final text/price/image choices.

- [x] T008 [P] [US2] Add growth, refresh-mode, retained/manual-row, stale lease and same-attempt retry tests in tests/catalog-automatic-updater.test.ts and tests/catalog-automatic-content-storage.test.ts.
- [x] T009 [US2] Add bounded latest-per-catalog immutable attempt recipe and scalar historical receipt in supabase/migrations/20261208120000_automatic_catalog_content.sql; preserve unknown-write reconciliation.
- [x] T010 [US2] Generate after final image selection and integrate recipe freeze/restore in supabase/functions/catalog-updater/worker.ts and supabase/functions/catalog-updater/index.ts; keep existing video publication authority.
- [x] T011 [US2] Stop per-space text schedule generation in supabase/functions/catalog-updater/index.ts; retain historical schedule data and API compatibility.

## Phase5 — US3: remove setup UI

Goal: no Catalog section or hidden creation prerequisite remains. Independent test: owner/viewer creation and legacy bookmarks work without settings reads/writes.

- [x] T012 [P] [US3] Update no-setup creation/settings/bookmark/preparation regressions in tests/product-catalog-dialog.test.tsx, tests/space-settings.test.tsx, tests/team-routes.test.ts, tests/catalog-manager-settings-navigation.test.tsx and tests/launch-catalog-preparation.test.ts.
- [x] T013 [US3] Remove Catalog tab/mounts/dirty guards and normalize legacy bookmarks to manager in apps/web/src/team/workspace/SpaceSettings.tsx and apps/web/src/team/routes.ts.
- [x] T014 [US3] Remove settings read blockers, implicit default-price writes and heavy constant import in apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx.
- [x] T015 [US3] Preserve image readiness with no price/text prerequisites in apps/web/src/team/launches/preparation.ts and apps/web/src/team/launches/LaunchSession.tsx.
- [x] T016 [US3] Remove dead manager/default/legend setup links and update explanation strings in apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx, apps/web/src/team/catalog-updater/CatalogIconControls.tsx and apps/web/src/locales/en.ts and uk.ts.

## Phase6 — Diagnostics and integration

- [x] T017 [P] Add restricted scalar policy/count projections for generation/update attempts in supabase/migrations/20261208121000_automatic_catalog_content_diagnostics.sql without exposing row content or using current snapshot as historical proof.
- [x] T018 Extend optional-column evidence parsing and standalone inspect join in scripts/analytics/catalog-generations.ts, scripts/analytics/queries.ts and scripts/analytics/types.ts; retain all existing batch/rename/native wrappers.
- [x] T019 Add missing global image/pairing closed-code mappings and retirement/automatic capability notes in scripts/analytics/code-map.ts, scripts/analytics/coverage-registry.ts and packages/shared/src/team/launches/lifecycle.ts.
- [x] T020 Verify actual SQL→CLI creation/updater diagnosis, unknown/missing visibility and privacy in tests/catalog-generation-diagnostic-producer.test.ts, tests/analytics-catalog-generations.test.ts, tests/catalog-diagnostics-ingestion.test.ts and tests/analytics-code-map.test.ts.

## Phase7 — Polish and validation

- [x] T021 Record100-sample200-row performance results and two analysis/fix passes in specs/055-automatic-catalog-content/reviews/validation.md.
- [x] T022 Update docs/DESIGN.md, docs/CATALOG_IMAGES.md and supabase/migrations/ROLLBACK.md; generate affected DB types and preserve additive/rollback compatibility.
- [x] T023 Capture desktop settings and representative automatic catalog rows in specs/055-automatic-catalog-content/reviews/ using the existing browser fixture harness.
- [ ] T024 Run focused tests and canonical static/suite/build/disposable DB checks serially; record exact-source results and actual skips/failures in specs/055-automatic-catalog-content/reviews/validation.md.
- [ ] T025 Integrate055and completed independent fixes into integration/next-release-2026-11-13, update docs/releases/next-2026-11-13.md, verify the final diff and push the isolated branch without publication.

## Dependencies and execution order

T001→T002→T003 establishes the typed foundation. Backend laneT004–T011 is sequential around shared SQL/Edge files; UI laneT012–T016 is independent after foundation. Diagnostic laneT017–T020 can prepare adapters in parallel but final SQL projections depend onT005/T009receipt shapes. T021–T025 follow integration. Root owns shared policy, verification and branch integration; delegated backend, UI and diagnostic work stays in disjoint files. All heavy tests/builds run through one root-controlled slot.

Parallel examples: backend SQL/Edge changes can proceed alongside UI control removal; diagnostic adapters can proceed alongside both with an agreed receipt contract. Tests may be authored concurrently but executed serially. No two workers edit the same migration, query owner or locale file.

## Implementation strategy and requirement coverage

US1is the functional baseline; US2is required before release, and US3completes the requested user experience. No partial release is planned.

FR001–004/012→T003/T006/T010; FR005→T005/T007/T014/T015; FR006–007→T004/T005/T007–T010; FR008→T012–T016; FR009→T011/T019; FR010→T004/T008/T020; FR011→T001/T025. SC001–004→T003/T004/T008/T012; SC005→T021; SC006→T022–T024; SC007→T017–T020.
