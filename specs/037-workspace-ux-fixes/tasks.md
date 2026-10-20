# Tasks: Виправлення робочого простору

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/workspace-operations.md](contracts/workspace-operations.md), [quickstart.md](quickstart.md)

**Tests**: Added for changed state, data integrity, cross-platform behavior and user-reported regressions. Each regression task should first demonstrate the current failure; avoid tests that merely repeat implementation details.

**Organization**: One independently verifiable phase per user story. IDs describe execution order within a phase; the dependency section governs cross-phase order.

## Scope update — 2026-10-17

US5–US8 / T003, T028–T038, T044–T048 moved to [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md). Transfer is not completion; no checkboxes were marked done. Shared diagnostic tasks and final gates below cover only the remaining 037 stories.

## Evidence reconciliation — 2026-10-20

The initial audit distinguished already-present layout/menu/chip/glossary behavior from missing stateful implementation. The implementation and focused regressions below are now complete; final gates and live acceptance remain separately tracked in T052–T053. SQL migrations use the current sequence rather than the illustrative dates from the original task draft.

## Phase 1: Setup and evidence audit

**Goal**: Verify the existing ownership and data paths before designing writes or deletes.

- [x] T001 Map every live `team_materials` reference and upload provenance, including tasks, launch sources, catalogs, companions and Drive ownership; record an exhaustive safe-cleanup inventory in `specs/037-workspace-ux-fixes/research.md` and identify authoritative checks in `supabase/migrations/` and `supabase/functions/drive-ops/`.
- [x] T002 [P] Trace task copy/selection, timezone calculation, explorer trash journal and diagnostics from UI to receipt; update `specs/037-workspace-ux-fixes/research.md` with exact seams in `apps/web/src/team/tasks/`, `apps/web/src/team/explorer/` and `scripts/analytics/`.
- T003 — перенесено: аудит зв’язків запусків/фінансів тепер у 038; не задача виконання 037.

**Checkpoint**: File cleanup has an exhaustive reference set. If coverage cannot be proven, retain rather than guess.

---

## Phase 2: Foundational contracts

**Goal**: Establish shared outcome semantics needed by the state-changing stories.

- [x] T004 Define bounded operation stages, stable error codes and privacy-safe correlation fields for copy, detach/cleanup, bulk trash and image choice in `packages/shared/src/team/analytics.ts`, `packages/shared/src/types.ts` and `scripts/analytics/code-map.ts`; avoid duplicating an existing type.
- [x] T005 Register coverage expectations and missing/delayed-signal behavior for the remaining four journeys in `scripts/analytics/coverage-registry.ts` and `scripts/analytics/investigate.ts`, keeping unsupported stages explicit.
- [x] T006 Add focused contract coverage for parsing, error-code mapping and absence of private payloads in `tests/analytics-code-map.test.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: Each later story can report a request, accepted work, proven result and unknown outcome through the same diagnostic vocabulary.

---

## Phase 3: US1 — Дошка завдань і копіювання (P1, MVP)

**Goal**: Quick dates beside the calendar, statuses on the right, and a copy that never traps selection or carries board filters.

**Independent Test**: With an active filter, copy/paste one task and immediately select another; test after success, failure and reload, plus yesterday/today around a timezone boundary.

- [x] T007 [US1] Add a failing user-flow regression for filter isolation, first-click selection and duplicate-paste recovery in `tests/creative-library-tasks.test.tsx` and a midnight/DST/month boundary case in `tests/task-dates-one-calendar.test.tsx`.
- [x] T008 [US1] Move status controls right and the yesterday/today actions beside the calendar in `apps/web/src/team/tasks/TaskFilterBar.tsx` and `apps/web/src/team/tasks/TaskDateFilter.tsx`; use the established browser civil-day contract and preserve keyboard/compact access.
- [x] T009 [US1] Correct paste completion and selection cleanup in `apps/web/src/team/tasks/useTaskClipboard.ts` and `apps/web/src/team/tasks/TaskSpace.tsx`; ensure an active filter cannot capture or hide interaction with the next card.
- [x] T010 [US1] Add idempotent copy attempt/receipt handling while preserving existing copy semantics in `supabase/migrations/20261205120000_task_copy_idempotency.sql`, `apps/web/src/api/team.ts` and `packages/shared/src/team/tasks.ts`.
- [x] T011 [US1] Prove server copy replay and cross-team rejection in `tests/workspace-ux-sql.test.ts`, and link the confirmed/unknown outcome to agent-readable diagnosis in `scripts/analytics/workspace.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-001–004 and SC-001 pass without changing the copied task's existing fresh date/status rule.

---

## Phase 4: US2 — Відкріплення та осиротілий файл (P1)

**Goal**: A quick × removes a task link while cleanup never destroys a shared or external file and Undo stays truthful.

**Independent Test**: Detach and Undo a unique upload during the 30-second server window; detach it without Undo and confirm trash within five minutes after the deadline with a healthy worker. Verify late response, worker interruption, shared/external files and a new reference racing cleanup.

- [x] T012 [US2] Add a failing regression for Undo, concurrent reattachment, external origin and unknown provenance in `tests/creative-library-tasks.test.tsx` and `tests/workspace-ux-sql.test.ts`; use the inventory from T001.
- [x] T013 [US2] Define a task-owned upload marker, detach receipt, server `cleanup_not_before = detached_at + 30 seconds` and idempotent cleanup-intent state in `supabase/migrations/20261205122000_task_attachment_cleanup.sql`; validate team ownership and idempotency at the database boundary.
- [x] T014 [US2] Implement cleanup claiming after the 30-second server deadline with an atomic recheck of all authoritative material references and a confirmed move to the space trash in `supabase/functions/drive-ops/` and `supabase/migrations/20261205122000_task_attachment_cleanup.sql`; retain with `cleanup_unverified` when any reference type or provenance is uncertain, and never report reclaimed storage quota.
- [x] T015 [US2] Wire due task-orphan claims into the existing minute-scheduled `supabase/functions/catalog-updater/index.ts` worker and recovery lease in `supabase/migrations/20261205123000_task_cleanup_dispatch.sql`; test worker-off/restart, bounded retry and confirmation within five minutes after deadline in `tests/workspace-ux-sql.test.ts` and `tests/task-cleanup-worker.test.ts`.
- [x] T016 [US2] Add a visible, accessible quick detach control and pending/error feedback in `apps/web/src/team/tasks/TaskAttachmentTile.tsx` and `apps/web/src/team/tasks/TaskEditor.tsx`; show the existing 14-second Undo action only if at least 20 seconds remain before the server deadline; after a late response, show status without a false Undo promise.
- [x] T017 [US2] Update typed detach/cleanup results in `apps/web/src/api/team.ts` and `packages/shared/src/team/tasks.ts` so the UI receives the server Undo deadline and distinguishes detached, waiting, retained, confirmed-in-trash and failed without claiming reclaimed storage quota.
- [x] T018 [US2] Prove the postcondition and reason codes through read-only diagnosis in `scripts/analytics/workspace.ts`, `scripts/analytics/code-map.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-005–006, SC-002 and SC-007 pass; confirmed owned orphans reach trash, while unverified files and worker outages remain explicit.

---

## Phase 5: US3 — Масове видалення файлів (P1)

**Goal**: Per-file progress, partial results, safe retry and responsive navigation for a group of 50 files.

**Independent Test**: Delete 50 files including a selected folder and child with one timeout; verify hosted receipts from a second session after reload/reconnect, retry only failed/reconciled unknown items, and time every visible state update from receipt/Realtime delivery.

- [x] T019 [US3] Add a failing 50-item regression with controlled receipt/Realtime delivery timestamps in `tests/team-explorer-operations.test.tsx` (create if absent); assert every connected item updates visibly within one second, folder-child deduplication, second-session reload and no duplicate trash.
- [x] T020 [US3] Add permission-checked hosted bulk-trash group/item intents linked to `team_operations` receipts, with a content-free `bulk_trash_changed` event kind/constraint and invalidation, in `supabase/migrations/20261205121000_bulk_trash_receipts.sql`; prove team isolation, replay, partial result and no private payload on Realtime in `tests/workspace-ux-sql.test.ts`.
- [x] T021 [US3] Keep the upload-specific `apps/web/src/team/explorer/workspaceOperationJournal.ts` unchanged and put bulk-trash intent/keys in the hosted group; make `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx` and `apps/web/src/api/team.ts` read hosted group/item receipts as authoritative via the existing `apps/web/src/team/useTeamRealtime.ts` owner on invalidation, reconnect and foreground; give `bulk_trash_changed` a bounded urgent reread so the current one-second debounce does not consume SC-003, with no second subscription or recurring polling.
- [x] T022 [US3] Replace the stop-on-first-error loop in `apps/web/src/team/explorer/ExplorerShell.tsx` with bounded background item execution, server group/item updates and confirmed/failed/unknown receipts, retry only for reconciled unresolved items; retain `trashMaterialWithTail` behavior from `apps/web/src/team/materials/tail.ts`.
- [x] T023 [US3] Render per-file queued/active/confirmed/error states without blocking other controls in `apps/web/src/team/explorer/BulkTrashPanel.tsx` using `apps/web/src/team/explorer/ProcessPanel.tsx`; keep grid/list catalog removal driven by confirmed receipts.
- [x] T024 [US3] Add bounded group counts, stable failure codes and delivery confirmation to `scripts/analytics/workspace.ts`, `scripts/analytics/coverage-registry.ts` and `tests/analytics-investigate-command.test.ts`; confirm names and paths never enter analytics.

**Checkpoint**: FR-007 and SC-003 pass, including two-session authoritative recovery and the measured one-second connected UI bound.

---

## Phase 6: US4 — Меню матеріалу та локальні операції (P2)

**Goal**: All menu commands are reachable, and finished history does not animate forever.

**Independent Test**: Open menus near viewport edges at 200% zoom; complete/fail an operation and verify the chip stops moving but still opens history.

- [x] T025 [P] [US4] Fix viewport-aware menu positioning, max height and keyboard focus using shared UI primitives in `apps/web/src/team/explorer/RowActions.tsx`, `apps/web/src/team/explorer/PaneActions.tsx` and the shared menu export referenced by `apps/web/src/components/ui/index.ts`.
- [x] T026 [P] [US4] Derive busy animation only from active operations, keeping quiet history and warning details available, in `apps/web/src/team/workspace/BackgroundWorkChip.tsx` and `apps/web/src/team/workspace/WorkspaceChip.tsx`.
- [x] T027 [US4] Verify edge placement, keyboard navigation and settled chip behavior in `tests/transcription-menus.test.tsx`, `tests/team-ux-background.test.tsx` and `tests/team-workspace-background-summary.test.tsx`; perform the visual check in `specs/037-workspace-ux-fixes/quickstart.md`.

**Checkpoint**: FR-008–009 pass without hiding history.

---

## Phase 7: Перенесено до 038

Цей account/finance slice належить [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md); задачі збережено як історичний матеріал у [handoff](../038-unified-accounts/handoff.md), не виконувати в 037.

## Phase 8: Перенесено до 038

Цей account/finance slice належить [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md); задачі збережено як історичний матеріал у [handoff](../038-unified-accounts/handoff.md), не виконувати в 037.

## Phase 9: Перенесено до 038

Цей account/finance slice належить [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md); задачі збережено як історичний матеріал у [handoff](../038-unified-accounts/handoff.md), не виконувати в 037.

## Phase 10: US9 — Одне зображення для початку/кінця відео (P2)

**Goal**: Explicit choice per slot, frozen for each queued job, with old random mode preserved.

**Independent Test**: Choose one of several start and end images, enqueue videos, remove a selected image, and verify a clear failure rather than silent substitution.

- [x] T039 [US9] Add queue/settings regressions for explicit selection, removed/disabled asset, frozen queued jobs and old settings in `tests/image-embedding-selection.test.ts` (create if absent).
- [x] T040 [US9] Extend validated settings and migration defaults with nullable selected start/end IDs in `packages/shared/src/types.ts` and `apps/agent/src/queue/store.ts`; null retains current random behavior.
- [x] T041 [US9] Validate selected asset at enqueue/start and freeze it into `JobImageEmbedding` in `apps/agent/src/queue/queue.ts`, without changing the cross-platform managed spawn path.
- [x] T042 [US9] Add explicit single-choice controls and clear selection/error state in `apps/web/src/components/ImageEmbeddingSection.tsx` and relevant labels in `apps/web/src/i18n.ts`; distinguish explicit from random mode.
- [x] T043 [US9] Add privacy-safe selected-image outcome and missing-signal diagnosis in `apps/agent/src/queue/queue.ts`, `scripts/analytics/coverage-registry.ts` and `tests/analytics-investigate-command.test.ts`; run macOS/Windows contract verification.

**Checkpoint**: FR-016 passes without changing previously queued jobs.

---

## Phase 11: Перенесено до 038

Цей account/finance slice належить [038 — Єдина таблиця «Аккаунтів»](../038-unified-accounts/spec.md); задачі збережено як історичний матеріал у [handoff](../038-unified-accounts/handoff.md), не виконувати в 037.

## Phase 12: US10 — Назва менеджера каталогів (P3)

**Goal**: Use “Менеджер каталогів” consistently for the existing catalog screen.

**Independent Test**: Open it from navigation and check title and accessible names in Ukrainian and English.

- [x] T049 [US10] Rename the catalog manager entry and dialog title through their shared labels in `apps/web/src/i18n.ts` (consumed by `WorkspaceShell.tsx` and `CatalogUpdaterDialog.tsx`); keep the separate file-search `TeamCatalog.tsx` and product-catalog actions distinct.
- [x] T050 [US10] Check the navigation label and dialog heading/accessible name through their shared translation keys in `tests/team-i18n-glossary.test.ts` (21 tests passing); `CatalogUpdaterDialog` uses its heading as the modal's `labelledBy` target.

**Checkpoint**: FR-017 passes without changing catalog behavior.

---

## Phase 13: Polish and integration gate

**Goal**: Verify all stories together and close diagnostic coverage gaps.

- [x] T051 Reconcile capability inventory, closed failure codes and end-to-end read-only CLI diagnosis for all changed journeys in `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts`, `scripts/analytics/workspace.ts` and `tests/analytics-code-map.test.ts`; mark genuinely unobservable stages as blind spots.
- [x] T052 Run focused tests for touched modules and `npm run verify`; record the current result in `specs/037-workspace-ux-fixes/quickstart.md`. The owner deferred all release-form gates to the consolidated pre-release run.
- T053 — DEFERRED by the owner to consolidated pre-release acceptance: packaged beta, isolated live Drive/scheduler/two-session timing and packaged macOS image selection. This does not block implementation closure. Live Windows testing is excluded; automated platform contracts, source regressions and recorded keyboard/200% checks remain in scope.
- [x] T054 Check changed UI against `docs/DESIGN.md` and `docs/DESIGN-PRINCIPLES.md`, including token and Tailwind gates, and finish any required adjustments in `apps/web/src/team/` and `apps/web/src/components/`.

---

## Dependencies & execution order

- Phase 1 precedes state-changing design; T001 is a hard prerequisite for US2 cleanup.
- Phase 2 precedes US1, US2, US3 and US9 diagnostic completion. UI-only US4 and US10 can proceed after Phase 1.
- US1, US2, US3, US4, US9 and US10 can be implemented independently after their stated prerequisites. Accounts/finance stories US5–US8 belong to 038.
- Within US2: T012 → T013 → T014 → T015 → T017 → T016 → T018. Cleanup must not ship before reference coverage, scheduled recovery, Undo, and receipt reconciliation work together.
- Within US3: T019 → T020 → T021 → T022 → T023 → T024. Do not show a file as deleted before confirmed postcondition; hosted state and existing Realtime owner are mandatory.
- Within US9: T039 → T040 → T041/T042 → T043.
- Phase 13 follows all delivered stories. A story is independently complete at its checkpoint; no production release is implied by completing these tasks.

### Parallel opportunities

- T001 and T002 inspect separate domains and can proceed concurrently; T004–T006 then settle shared diagnostic contracts.
- T025 and T026 touch separate components and are marked [P]. US10 is also an independent UI slice once baseline audit is done.
- After foundational work, US1 task-board work, US3 explorer work and US9 local image work touch mostly separate files. Coordinate analytics edits rather than merging conflicting changes blindly.
- 038 owns account/finance changes; coordinate shared analytics files across features.

## Implementation strategy

1. **MVP:** Complete Phases 1–3 and validate US1 independently. It addresses the copy/selection bug and visible task-board controls.
2. **Data safety:** Complete US2 and US3 with their database/operation receipts, then verify destructive edge cases before release.
3. **UI improvements:** Complete US4 and US10 as small reviewable slices.
4. **Accounts handoff:** US5–US8 and T003/T028–T038/T044–T048 are owned by 038 and are excluded from the 037 completion gate.
5. **Local image choice:** Complete US9 independently, including agent settings migration and queue tests.
6. **Final gate:** Execute Phase 13; deployment follows the repository release runbook only when separately requested.

## Notes

- `[P]` means the specific task is safe to perform concurrently with adjacent independent work; unmarked tasks can still belong to separate story streams according to dependencies.
- The repository currently has unrelated uncommitted work. Preserve it and avoid broad cleanup while implementing these tasks.
- New SQL migration filenames must sort after the latest migration already present at implementation time; never edit historical applied migrations.

## Implementation evidence — 2026-10-20

- T001–T002: research R9 records current seams, the material-consumer inventory and ownership limits.
- T004–T006/T018/T024/T043/T051: shared receipt validators, closed UI-flow vocabulary, coverage registry, existing IMAGE_UNAVAILABLE code map, restricted diagnostic view and actual CLI-query regression in `tests/workspace-ux-sql.test.ts`. Missing view/delivery remains unknown.
- T007–T011: `tests/team-task-clipboard.test.tsx`, board first-click/search regression in `tests/creative-library-tasks.test.tsx`, civil-day regression in `tests/task-dates-one-calendar.test.tsx`, real SQL copy replay in `tests/workspace-ux-sql.test.ts` and preserved existing copy SQL tests. These paths supersede the illustrative pgTAP file placement in the original tasks.
- T012–T018: task upload provenance, 30-second receipts, atomic Undo, reference fence, worker recovery and provider readback are exercised by `tests/workspace-ux-sql.test.ts`, `tests/task-cleanup-worker.test.ts` and the delayed-response editor regression. T015 uses that executable Postgres suite rather than creating a duplicate pgTAP test. An additional held-lock test ran against two actual PostgreSQL connections.
- T019–T024: hosted permission-checked group/items and retry functions; three-request worker; unchanged material tails; urgent existing Realtime invalidation; 50-item continuation/reload/partial retry and stale-space-read tests in `tests/team-explorer-operations.test.tsx`. The hosted intent replaces a duplicate local trash journal. Grid/list files use the shared process panel's per-item statuses; successful material removal remains driven by catalog receipts/invalidation.
- T025–T026/T049–T050: existing shared menu placement, settled chips and translation keys were retained. Existing menu/chip/glossary regressions are the executable evidence; real-browser and platform acceptance is tracked separately below.
- T039–T043: `tests/image-embedding-selection.test.ts`, explicit multi-job frozen selection in `tests/image-embedding.test.ts`, old image/queue/store regressions and shared settings validation. Nullable IDs preserve random mode for existing settings. The optional imageSelection agent capability gates the new chooser; older agents retain their existing controls. Live Windows execution is not claimed by a platform-independent unit suite.

The prior bundle and local-database failures were remediated without relaxing budgets: compact exact geometry, inventory-scoped HeroUI structures, and an isolated real PostgreSQL test runner. T052 now covers the normal verification only. T053 and `verify:release` are explicitly deferred by the owner until the combined pre-release pass; live Windows acceptance is excluded. No production mutation, version bump, tag, release or deploy was performed.

## Current completion verdict

Normal `npm run verify`: PASS, 14/14 gates, 6240 passed tests, 17 explicitly explained skips, zero failures. Result retained in `evidence/verification-fast.json`. All 36 tasks in the current implementation scope are complete. T053 and release-form checks are deferred by the owner to the consolidated pre-release pass; live Windows testing is excluded. 037 is closed in the agreed implementation scope; production actions remain outside this change.

Final commit preparation: the isolated 037-only staged snapshot passed 6 focused suites / 45 tests with one worker at `nice -n 15`; see `evidence/verification-staged.json`. Parallel 034 work remains outside this commit.
