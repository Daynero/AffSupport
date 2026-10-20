# Tasks: Простий менеджер каталогів

## Setup

- [x] T001 Read spec/audit/design and inspect current contracts in specs/040-simplify-catalog-manager/research.md
- [x] T002 Record plan, state and UI contracts in specs/040-simplify-catalog-manager/plan.md

## Foundation

- [x] T003 Preserve immediate initial load and profiles in apps/web/src/team/catalog-updater/useCatalogUpdater.ts
- [x] T004 Add typed bounded journey evidence in apps/web/src/team/catalog-updater/analytics.ts

## US1 — readable list

Independent test: identify name, current/last/next and changes without opening settings.

- [x] T005 [US1] Simplify toolbar, labelled filters, row facts and overflow in apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx
- [x] T006 [US1] Build responsive token-based proportions and one list scroll in apps/web/src/styles.css

## US2 — one editor

Independent test: two independent profiles; immediate field persistence, unknown readback, safe undo and conflict protection. Approved replacement: icon-controls/plan.md.

- [x] T007 [US2] Replace the individual draft model with the shared versioned controller in apps/web/src/team/catalog-updater/useCatalogInlineChanges.ts
- [x] T008 [US2] Move editor into separate guarded detail surface in apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx

## US3 — launch and result

Independent test: manual run preserves schedule; history failure then success has no stale recovery.

- [x] T009 [US3] Simplify history and current recovery in apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx
- [x] T010 [US3] Reconcile accurate ID/content copy in apps/web/src/i18n.ts

## US4 — bulk

Independent test: selection shows toolbar; explicit edit preserves unspecified fields and partial outcomes.

- [x] T011 [US4] Separate bulk toolbar and editor in apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx
- [x] T012 [US4] Guard draft and show labelled tri-state fields in apps/web/src/team/catalog-updater/CatalogBulkEditor.tsx

## US5 — defaults

Independent test: future defaults save without changing existing profiles.

- [x] T013 [US5] Add explicit defaults editor and settings integration in apps/web/src/team/catalog-updater/CatalogDefaultsEditor.tsx
- [x] T014 [US5] Link manager overflow to existing product catalog settings in apps/web/src/team/catalog-updater/CatalogUpdaterDialog.tsx

## Verification

- [x] T015 Add focused regression scenarios in tests/catalog-updater-dialog.test.tsx and related catalog test files
- [x] T016 Validate diagnostics and registry in scripts/analytics/coverage-registry.ts
- [x] T017 Run required gates and document measured/pending acceptance in specs/040-simplify-catalog-manager/acceptance.md

## Dependencies and execution

T001–004 foundation; US1 precedes main integration of US2–4. US2 editor/history and US5 settings can proceed in separate files; translations/styles integrated sequentially. US1 test uses list; US2 tests editor; US3 history tests; US4 bulk tests; US5 defaults tests can run independently after their components. Deliver all stories, then verify. External participant sessions remain acceptance evidence to collect, not an implementation claim.

Verification scope and remaining evidence are recorded in [icon-controls/acceptance.md](icon-controls/acceptance.md).

## Closure

Closed 2026-10-20 at the owner’s request. Final desktop scope, delivered refinements and retained acceptance limits: [closeout](../040-simplify-catalog-manager/acceptance.md). Production promotion remains separate.
