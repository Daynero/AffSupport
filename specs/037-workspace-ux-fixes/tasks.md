# Tasks: Виправлення робочого простору

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/workspace-operations.md](contracts/workspace-operations.md), [quickstart.md](quickstart.md)

**Tests**: Added for changed state, data integrity, cross-platform behavior and user-reported regressions. Each regression task should first demonstrate the current failure; avoid tests that merely repeat implementation details.

**Organization**: One independently verifiable phase per user story. IDs describe execution order within a phase; the dependency section governs cross-phase order.

## Phase 1: Setup and evidence audit

**Goal**: Verify the existing ownership and data paths before designing writes or deletes.

- [x] T001 Map every live `team_materials` reference and upload provenance, including tasks, launch sources, catalogs, companions and Drive ownership; record an exhaustive safe-cleanup inventory in `specs/037-workspace-ux-fixes/research.md` and identify authoritative checks in `supabase/migrations/` and `supabase/functions/drive-ops/`. Launches references remain explicitly unverified and force retention until integrated.
- [x] T002 [P] Trace task copy/selection, timezone calculation, explorer trash journal and diagnostics from UI to receipt; update `specs/037-workspace-ux-fixes/research.md` with exact seams in `apps/web/src/team/tasks/`, `apps/web/src/team/explorer/` and `scripts/analytics/`.
- [x] T003 [P] Trace stable РК identity through launches and finance placements, including moved/deleted РК and archived history; update `specs/037-workspace-ux-fixes/research.md` using `apps/web/src/team/launches/`, `apps/web/src/team/accounts/finance/` and `supabase/migrations/`.

**Checkpoint**: File cleanup has an exhaustive reference set, and combined-view joins use stable IDs. If either cannot be proven, retain/unmatch rather than guess.

---

## Phase 2: Foundational contracts

**Goal**: Establish shared outcome semantics needed by the state-changing stories.

- [ ] T004 Define bounded operation stages, stable error codes and privacy-safe correlation fields for copy, detach/cleanup, bulk trash, ordering, archive and image choice in `packages/shared/src/team/analytics.ts`, `packages/shared/src/types.ts` and `scripts/analytics/code-map.ts`; avoid duplicating an existing type.
- [ ] T005 Register coverage expectations and missing/delayed-signal behavior for the six journeys in `scripts/analytics/coverage-registry.ts` and `scripts/analytics/investigate.ts`, keeping unsupported stages explicit.
- [ ] T006 Add focused contract coverage for parsing, error-code mapping and absence of private payloads in `tests/analytics-code-map.test.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: Each later story can report a request, accepted work, proven result and unknown outcome through the same diagnostic vocabulary.

---

## Phase 3: US1 — Дошка завдань і копіювання (P1, MVP)

**Goal**: Quick dates beside the calendar, statuses on the right, and a copy that never traps selection or carries board filters.

**Independent Test**: With an active filter, copy/paste one task and immediately select another; test after success, failure and reload, plus yesterday/today around a timezone boundary.

- [x] T007 [US1] Add a failing user-flow regression for filter isolation, first-click selection and duplicate-paste recovery in `tests/creative-library-tasks.test.tsx` and a timezone boundary case in `tests/task-dates-one-calendar.test.tsx`.
- [x] T008 [US1] Move status controls right and the yesterday/today actions beside the calendar in `apps/web/src/team/tasks/TaskFilterBar.tsx` and `apps/web/src/team/tasks/TaskDateFilter.tsx`; use the space timezone and preserve keyboard/compact access.
- [x] T009 [US1] Correct paste completion and selection cleanup in `apps/web/src/team/tasks/useTaskClipboard.ts` and `apps/web/src/team/tasks/TaskSpace.tsx`; reset filters that hide the copy and clear selection after success or failure. The focused success, failure and duplicate-paste regressions pass.
- [x] T010 [US1] Add idempotent copy attempt/receipt handling while preserving existing copy semantics and the legacy RPC overload in `supabase/migrations/20261203100000_task_copy_idempotency.sql`, `apps/web/src/api/team.ts` and `packages/shared/src/team/tasks.ts`; retry the same request after an unconfirmed response, including after a tab reload.
- [x] T011 [US1] Prove server copy replay and cross-team rejection in `supabase/tests/database/`, and link the confirmed/unknown outcome to agent-readable diagnosis in `scripts/analytics/queries.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-001–004 and SC-001 pass without changing the copied task's existing fresh date/status rule.

---

## Phase 4: US2 — Відкріплення та осиротілий файл (P1)

**Goal**: A quick × removes a task link while cleanup never destroys a shared or external file and Undo stays truthful.

**Independent Test**: Detach and Undo a unique upload during the 30-second server window; detach it without Undo and confirm trash within five minutes after the deadline with a healthy worker. Verify late response, worker interruption, shared/external files and a new reference racing cleanup.

- [ ] T012 [US2] Add a failing regression for Undo, concurrent reattachment, external origin and unknown provenance in `tests/creative-library-tasks.test.tsx` and `supabase/tests/database/`; use the inventory from T001.
- [ ] T013 [US2] Define a task-owned upload marker, detach receipt, server `cleanup_not_before = detached_at + 30 seconds` and idempotent cleanup-intent state in `supabase/migrations/20261203101000_task_attachment_orphan_cleanup.sql`; validate team ownership and idempotency at the database boundary.
- [ ] T014 [US2] Implement cleanup claiming after the 30-second server deadline with an atomic recheck of all authoritative material references and a confirmed move to the space trash in `supabase/functions/drive-ops/` and `supabase/migrations/20261203101000_task_attachment_orphan_cleanup.sql`; retain with `cleanup_unverified` when any reference type or provenance is uncertain, and never report reclaimed storage quota.
- [ ] T015 [US2] Wire due task-orphan claims into the existing minute-scheduled `supabase/functions/catalog-updater/index.ts` worker and recovery lease in `supabase/migrations/20261203101200_task_orphan_dispatch.sql`; test worker-off/restart, bounded retry and confirmation within five minutes after deadline in `supabase/tests/database/team-task-orphan-cleanup.test.sql` (create if absent).
- [ ] T016 [US2] Add a visible, accessible quick detach control and pending/error feedback in `apps/web/src/team/tasks/TaskAttachmentTile.tsx` and `apps/web/src/team/tasks/TaskEditor.tsx`; show the existing 14-second Undo action only if at least 20 seconds remain before the server deadline; after a late response, show status without a false Undo promise.
- [ ] T017 [US2] Update typed detach/cleanup results in `apps/web/src/api/team.ts` and `packages/shared/src/team/tasks.ts` so the UI receives the server Undo deadline and distinguishes detached, waiting, retained, confirmed-in-trash and failed without claiming reclaimed storage quota.
- [ ] T018 [US2] Prove the postcondition and reason codes through read-only diagnosis in `scripts/analytics/queries.ts`, `scripts/analytics/code-map.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-005–006, SC-002 and SC-007 pass; confirmed owned orphans reach trash, while unverified files and worker outages remain explicit.

---

## Phase 5: US3 — Масове видалення файлів (P1)

**Goal**: Per-file progress, partial results, safe retry and responsive navigation for a group of 50 files.

**Independent Test**: Delete 50 files including a selected folder and child with one timeout; verify hosted receipts from a second session after reload/reconnect, retry only failed/reconciled unknown items, and time every visible state update from receipt/Realtime delivery.

- [ ] T019 [US3] Add a failing 50-item regression with controlled receipt/Realtime delivery timestamps in `tests/team-explorer-operations.test.tsx` (create if absent); assert every connected item updates visibly within one second, folder-child deduplication, second-session reload and no duplicate trash.
- [x] T020 [US3] Add permission-checked hosted bulk-trash group/item intents linked to `team_operations` receipts, with a content-free `bulk_trash_changed` event kind/constraint and invalidation, in `supabase/migrations/20261203101500_bulk_trash_receipts.sql`; prove team isolation, replay, partial result and no private payload on Realtime in `supabase/tests/database/team-bulk-trash.test.sql` (create if absent).
- [x] T021 [US3] Restrict `apps/web/src/team/explorer/workspaceOperationJournal.ts` to initiator intent and stable retry keys; make `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx` and `apps/web/src/api/team.ts` read hosted group/item receipts as authoritative via the existing `apps/web/src/team/useTeamRealtime.ts` owner on invalidation, reconnect and foreground; give `bulk_trash_changed` a bounded urgent reread so the current one-second debounce does not consume SC-003, with no second subscription or recurring polling.
- [x] T022 [US3] Replace the stop-on-first-error loop in `apps/web/src/team/explorer/ExplorerShell.tsx` with bounded background item execution, server group/item updates and confirmed/failed/unknown receipts, retry only for reconciled unresolved items; retain `trashMaterialWithTail` behavior from `apps/web/src/team/materials/tail.ts`.
- [x] T023 [US3] Render per-file queued/active/confirmed/error states without blocking other controls in `apps/web/src/team/explorer/ContentGrid.tsx`, `apps/web/src/team/explorer/ContentList.tsx` and `apps/web/src/team/explorer/ProcessPanel.tsx`.
- [ ] T024 [US3] Add bounded group counts, stable failure codes and delivery confirmation to `scripts/analytics/queries.ts`, `scripts/analytics/coverage-registry.ts` and `tests/analytics-investigate-command.test.ts`; confirm names and paths never enter analytics.

**Checkpoint**: FR-007 and SC-003 pass, including two-session authoritative recovery and the measured one-second connected UI bound.

---

## Phase 6: US4 — Меню матеріалу та локальні операції (P2)

**Goal**: All menu commands are reachable, and finished history does not animate forever.

**Independent Test**: Open menus near viewport edges at 200% zoom; complete/fail an operation and verify the chip stops moving but still opens history.

- [x] T025 [P] [US4] Cap the shared `DropdownMenu` surface to the visible viewport in `apps/web/src/styles/components.css`; `RowActions.tsx` and `PaneActions.tsx` already use the shared React Aria menu with flip placement, portal, scrolling and keyboard focus.
- [x] T026 [P] [US4] Derive busy animation only from active operations, keeping quiet history and warning details available, in `apps/web/src/team/workspace/BackgroundWorkChip.tsx` and `apps/web/src/team/workspace/WorkspaceChip.tsx`.
- [ ] T027 [US4] Verify edge placement, keyboard navigation and settled chip behavior in `tests/team-explorer-actions.test.tsx` and `tests/team-background-work-chip.test.tsx` (create if absent); perform the visual check in `specs/037-workspace-ux-fixes/quickstart.md`.

**Checkpoint**: FR-008–009 pass without hiding history.

---

## Phase 7: US5 — Шапка фінансів (P2)

**Goal**: Date, periods, timezone, currency and export stay visible as the table scrolls.

**Independent Test**: Scroll a long finance table on desktop and narrow screens at 200% zoom without overlap or clipped controls.

- [x] T028 [US5] Make the existing wrapped `FinanceToolbar` sticky beneath the measured workspace header in `FinanceWorkspace.tsx` and token-based styles in `components.css`; measure its responsive height so the daily table header stays below it.
- [ ] T029 [US5] Add a meaningful scroll/visibility regression in `tests/team-finance-workspace.test.tsx` (create if absent) and complete the narrow/zoom visual scenario from `specs/037-workspace-ux-fixes/quickstart.md`.

**Checkpoint**: FR-010 and SC-004 pass.

---

## Phase 8: US6 — Ручний порядок соцiв і РК (P2)

**Goal**: Shared, durable order with exact drop target and conflict recovery.

**Independent Test**: Reorder socials and РК, refresh two editor sessions, cause a conflicting reorder, then move a РК to another social.

- [x] T030 [US6] Add database regressions for initial rank backfill, same-parent membership, concurrent version conflict, permissions and destination rank on РК move in `supabase/tests/database/team-accounts-order.test.sql` (create if absent).
- [x] T031 [US6] Add rank/version fields and deterministic natural-order backfill for `team_accounts` and `team_account_agents`, plus atomic permission-checked reorder functions, in `supabase/migrations/20261203102000_account_order.sql`.
- [x] T032 [US6] Extend typed account readers/parsers and reorder client calls in `packages/shared/src/team/accounts.ts`, `apps/web/src/api/team.ts` and `apps/web/src/team/accounts/useAccounts.ts`; replace all natural re-sorting that would override persisted ranks.
- [x] T033 [US6] Add pointer and keyboard reordering, insertion indicator, cancellation and conflict feedback in `apps/web/src/team/accounts/AccountSpace.tsx`, `apps/web/src/team/accounts/AccountGroup.tsx` and `apps/web/src/team/accounts/AgentRow.tsx` using existing design tokens.
- [x] T034 [US6] Validate two-client realtime order and conflict/permission behavior in `tests/team-accounts-order.test.tsx` (create if absent); add correlated result/unknown diagnosis in `scripts/analytics/queries.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-011–012 and SC-005 pass for both order levels.

---

## Phase 9: US7 — Спільна таблиця РК, запусків і фінансів (P2)

**Goal**: Account-first read-only overview with period-aware figures and explicit unmatched data.

**Independent Test**: Open a social with several РК, multiple launches, a known zero, no finance row, a moved РК and an unmatched launch snapshot.

- [ ] T035 [US7] Define the stable launch-to-РК and finance-placement read projection with null-versus-zero and unmatched reasons in `packages/shared/src/team/account-overview.ts` and `apps/web/src/api/team.ts`; do not join on labels or suffixes.
- [ ] T036 [US7] Implement the read endpoint/query for ordered socials and РК, launch rows, finance period and unmatched records in `supabase/migrations/20261203103000_account_launch_finance_view.sql` and `apps/web/src/api/team.ts`; preserve stable identity so a later archive remains resolvable.
- [ ] T037 [US7] Build the combined table, explicit period and unmatched section in `apps/web/src/team/accounts/AccountSpace.tsx` and a new `apps/web/src/team/accounts/AccountLaunchFinanceTable.tsx`; keep editing in existing source screens.
- [ ] T038 [US7] Test multiple launches, moved РК, zero versus no data, permissions and page consistency for active socials in `tests/team-account-launch-finance.test.tsx` and `supabase/tests/database/`.

**Checkpoint**: FR-013–014 pass; ambiguous rows remain visible but unassigned.

---

## Phase 10: US9 — Одне зображення для початку/кінця відео (P2)

**Goal**: Explicit choice per slot, frozen for each queued job, with old random mode preserved.

**Independent Test**: Choose one of several start and end images, enqueue videos, remove a selected image, and verify a clear failure rather than silent substitution.

- [x] T039 [US9] Add queue/settings regressions for explicit selection, removed/disabled asset, frozen queued jobs and old settings in the existing `tests/image-embedding.test.ts`, `tests/settings-validation.test.ts` and `tests/image-embedding-ui.test.tsx`.
- [x] T040 [US9] Extend validated settings and migration defaults with nullable selected start/end IDs in `packages/shared/src/types.ts` and `apps/agent/src/queue/store.ts`; null retains current random behavior.
- [x] T041 [US9] Validate selected asset at queue start and freeze it into `JobImageEmbedding` in `apps/agent/src/queue/queue.ts`, without changing the cross-platform managed spawn path.
- [x] T042 [US9] Add explicit single-choice controls and clear selection/error state in `apps/web/src/components/ImageEmbeddingSection.tsx` and relevant labels in `apps/web/src/i18n.ts`; distinguish explicit from random mode.
- [x] T043 [US9] Add privacy-safe selected-image outcome and missing-signal diagnosis in `apps/agent/src/queue/queue.ts`, `scripts/analytics/coverage-registry.ts` and `tests/analytics-investigate-command.test.ts`; run macOS/Windows contract verification.

**Checkpoint**: FR-016 passes without changing previously queued jobs.

---

## Phase 11: US8 — Забуті акаунти (P3)

**Goal**: Archive and restore a social without deleting history or allowing ambiguous active launches.

**Independent Test**: Archive a social with historical records, find it in archived view, restore it, and try archive while an active launch depends on it.

- [ ] T044 [US8] Add database regressions for archive/restore, active-launch refusal, history preservation and permissions in `supabase/tests/database/team-accounts-archive.test.sql` (create if absent).
- [ ] T045 [US8] Add reversible `archived_at` state, versioned mutation and active-launch guard in `supabase/migrations/20261203104000_account_archive.sql`; extend the combined read projection for archived history in `supabase/migrations/20261203105000_account_overview_archive.sql` without editing the earlier migration.
- [ ] T046 [US8] Extend active/archived/all readers and typed archive calls in `packages/shared/src/team/accounts.ts`, `apps/web/src/api/team.ts` and `apps/web/src/team/accounts/useAccounts.ts`; remove archived socials from active pickers without hiding history.
- [ ] T047 [US8] Add archive action, archived view/search and restore feedback in `apps/web/src/team/accounts/AccountSpace.tsx` and `apps/web/src/team/accounts/AccountGroup.tsx`; explain active-launch refusal and preserve manual order.
- [ ] T048 [US8] Add UI and diagnostic regression for restore, history in the combined table, and refusal in `tests/team-accounts-archive.test.tsx`, `scripts/analytics/queries.ts` and `tests/analytics-investigate-command.test.ts`.

**Checkpoint**: FR-015 passes and no historical link is lost.

---

## Phase 12: US10 — Назва менеджера каталогів (P3)

**Goal**: Use “Менеджер каталогів” consistently for the existing catalog screen.

**Independent Test**: Open it from navigation and check title and accessible names in Ukrainian and English.

- [x] T049 [US10] Rename the catalog manager entry and dialog title through their shared labels in `apps/web/src/i18n.ts` (consumed by `WorkspaceShell.tsx` and `CatalogUpdaterDialog.tsx`); keep the separate file-search `TeamCatalog.tsx` and product-catalog actions distinct.
- [x] T050 [US10] Check the navigation label and dialog heading/accessible name through their shared translation keys in `tests/team-i18n-glossary.test.ts` (21 tests passing); `CatalogUpdaterDialog` uses its heading as the modal's `labelledBy` target.

**Checkpoint**: FR-017 passes without changing catalog behavior.

---

## Phase 13: Polish and integration gate

**Goal**: Verify all stories together and close diagnostic coverage gaps.

- [ ] T051 Reconcile capability inventory, closed failure codes and end-to-end read-only CLI diagnosis for all changed journeys in `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts`, `scripts/analytics/queries.ts` and `tests/analytics-code-map.test.ts`; mark genuinely unobservable stages as blind spots.
- [ ] T052 Run focused tests for touched modules, `npm run verify`, and migration/agent release gates via `npm run verify:release`; record results and any unresolved limitation in `specs/037-workspace-ux-fixes/quickstart.md`.
- [ ] T053 Execute the independent scenarios in `specs/037-workspace-ux-fixes/quickstart.md`, including two-user conflicts, timed 50-file partial trash with authoritative reconnect, 30-second Undo/worker recovery/concurrent references, keyboard/200% zoom and macOS/Windows image selection; record observed outcomes in that file.
- [ ] T054 Check changed UI against `docs/DESIGN.md` and `docs/DESIGN-PRINCIPLES.md`, including token and Tailwind gates, and finish any required adjustments in `apps/web/src/team/` and `apps/web/src/components/`.

---

## Dependencies & execution order

- Phase 1 precedes state-changing design; T001 is a hard prerequisite for US2 cleanup. T003 is a hard prerequisite for US7 joins.
- Phase 2 precedes US1, US2, US3, US6, US8 and US9 diagnostic completion. UI-only US4, US5 and US10 can proceed after Phase 1.
- US1, US2, US3, US4, US5, US6, US9 and US10 can be implemented independently after their stated prerequisites. US7 depends on US6 persisted order and covers active socials first. US8 follows US7, extends the combined table for archived history, and uses the same account model.
- Within US2: T012 → T013 → T014 → T015 → T017 → T016 → T018. Cleanup must not ship before reference coverage, scheduled recovery, Undo, and receipt reconciliation work together.
- Within US3: T019 → T020 → T021 → T022 → T023 → T024. Do not show a file as deleted before confirmed postcondition; hosted state and existing Realtime owner are mandatory.
- Within US6: T030 → T031 → T032 → T033 → T034. Within US9: T039 → T040 → T041/T042 → T043.
- Phase 13 follows all delivered stories. A story is independently complete at its checkpoint; no production release is implied by completing these tasks.

### Parallel opportunities

- T001, T002 and T003 inspect separate domains and can proceed concurrently; T004–T006 then settle shared diagnostic contracts.
- T025 and T026 touch separate components and are marked [P]. US5 and US10 are also independent UI slices once baseline audit is done.
- After foundational work, US1 task-board work, US3 explorer work and US9 local image work touch mostly separate files. Coordinate analytics edits rather than merging conflicting changes blindly.
- US7 read projection begins after US6 ranks; US8 follows US7 and extends the overview for archived history through its own migration and UI change in `AccountSpace.tsx`.

## Implementation strategy

1. **MVP:** Complete Phases 1–3 and validate US1 independently. It addresses the copy/selection bug and visible task-board controls.
2. **Data safety:** Complete US2 and US3 with their database/operation receipts, then verify destructive edge cases before release.
3. **UI improvements:** Complete US4, US5 and US10 as small reviewable slices.
4. **Account workflow:** Complete US6, then active-account US7, then US8 archived-history extension; keep shared account files serialized.
5. **Local image choice:** Complete US9 independently, including agent settings migration and queue tests.
6. **Final gate:** Execute Phase 13; deployment follows the repository release runbook only when separately requested.

## Notes

- `[P]` means the specific task is safe to perform concurrently with adjacent independent work; unmarked tasks can still belong to separate story streams according to dependencies.
- The repository currently has unrelated uncommitted work. Preserve it and avoid broad cleanup while implementing these tasks.
- New SQL migration filenames must sort after the latest migration already present at implementation time; never edit historical applied migrations.
