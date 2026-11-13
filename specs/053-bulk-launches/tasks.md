# Tasks: Масові запуски

## Phase 1 — Setup
- [x] T001 Isolate feature worktree and create spec/plan/research/contracts in specs/053-bulk-launches/ (FR-012).
- [x] T002 Prepare isolated dependencies and baseline checks in package.json / reviews/validation.md (SC-006).

## Phase 2 — Foundations
- [x] T003 Add failing projection/chronology tests in tests/launch-persistence-contract.test.ts and tests/launch-workspace.test.ts (FR-001, FR-009).
- [x] T004 Extend validated summary/detail types in packages/shared/src/team/launches.ts and launches/persistence.ts; add forward projection migration in supabase/migrations/ (FR-001, FR-007, FR-009).

## Phase 3 — US1 Manage launches
- [x] T005 [US1] Add behavioral mixed-state/keyboard/copy tests in tests/launch-card-interactions.test.tsx and tests/launch-bulk-selection.test.tsx (SC-001).
- [x] T006 [US1] Implement status/creation time/progress presentation in apps/web/src/team/launches/LaunchCard.tsx and launchPresentation.ts (FR-001, FR-009).
- [x] T007 [US1] Implement guarded range/select-all/delete/copy-paste and direct selection actions in apps/web/src/team/launches/LaunchSpace.tsx and useLaunchListSelection.ts (FR-002, FR-003).
- [x] T008 [US1] Remove redundant copy toast action in apps/web/src/team/launches/useLaunchCopy.ts and update tests/launch-copy-hook.test.tsx (FR-003).

## Phase 4 — US3 Progressive results
- [x] T009 [US3] Add pending-result and copy affordance tests in tests/launch-progressive-result.test.tsx and tests/launch-ui.test.tsx (SC-002).
- [x] T010 [US3] Implement pending result using naming preview/reserved name in apps/web/src/team/launches/LaunchPendingResult.tsx and LaunchSession.tsx (FR-007).
- [x] T011 [US3] Strengthen visible copy/check state in apps/web/src/team/launches/CopyResultField.tsx and styles/components.css, both themes (FR-008, FR-012).

## Phase 5 — US4 Shared preparation
- [x] T012 [US4] Add 20-consumer, canceled waiter, failed leader and eviction regressions in tests/restitch-multi-variation-reuse.test.ts (SC-004).
- [x] T013 [US4] Add cancellation-aware body sharing and consumer lease cleanup in apps/agent/src/stitcher/body-cache.ts and pipeline.ts (FR-010).
- [x] T014 [US4] Deduplicate compatible cold inspection in apps/agent/src/team-bridge/restitch.ts (FR-005, FR-010).
- [x] T015 [US4] Record reproducible cold/warm comparison and limits in specs/053-bulk-launches/reviews/performance.md (SC-004).

## Phase 6 — US2 Batch generation
- [x] T016 [US2] Add grouped admission, stop, uncertainty, stale draft, actor and invalid-sibling tests in tests/launch-batch.test.tsx (SC-003).
- [x] T017 [US2] Implement bounded batch coordinator reusing useLaunchGeneration in apps/web/src/team/launches/LaunchBatch.tsx and batchModel.ts (FR-004, FR-005, FR-006).
- [x] T018 [US2] Integrate selection action, per-item queue feedback and recovery in apps/web/src/team/launches/LaunchSpace.tsx (FR-004, FR-006, FR-009).

## Phase 7 — Diagnostics and polish
- [x] T019 Add typed batch correlation and coverage regressions using apps/web/src/team/launches/analytics.ts, scripts/analytics/coverage-registry.ts and tests/launch-analytics.test.ts (FR-011, SC-005).
- [x] T020 Localize additions in apps/web/src/locales/; run design/token gates and browser acceptance in specs/053-bulk-launches/reviews/validation.md (FR-012).
- [x] T021 Run two review/remediation passes, focused tests and npm run verify; record findings in specs/053-bulk-launches/reviews/validation.md (SC-001–SC-006).

## Dependencies and execution
T001 → T002 → T003/T004 → US1 and US3; US4 cache ownership before US2 concurrency; diagnostics spans all stories; final acceptance after all. Independent read-only review or tests can run in parallel, heavy processes remain sequential. Deliver complete stories incrementally; no task is checked solely because a document exists.

## Phase 8: Convergence
- [x] T022 Use explicit .js specifiers in new feature modules and centralize the batch selection limit in the shared contract per Constitution I (contradicts, CRITICAL).
- [x] T023 Verify four distinct accounts preserve five catalog variations and the shared source through bounded admission in tests/launch-batch-admission.test.tsx per SC-003 (partial, HIGH).
- [x] T024 Document forward recovery for the projection migration in supabase/migrations/ROLLBACK.md and finish exact validation evidence in reviews/validation.md per Constitution additional constraints / SC-006 (partial, MEDIUM).

## Phase 9: Acceptance follow-up
- [x] T025 Cover successful/denied early preview copy through the existing typed launch diagnostics, and verify the latest-generation lookup index per FR-011 / FR-009 / SC-005 (partial).
- [x] T026 Supply jsdom's missing Element.scrollTo seam in tests/support/setup-dom.ts and repeat the canonical suite per SC-006 (verification prerequisite).

- [x] T027 Update two stale pgTAP privilege signature references to the current default-argument RPCs and repeat isolated PostgreSQL acceptance per SC-006 (verification prerequisite).

- [x] T028 Bridge local batch admission states into cards until server reconciliation arrives and preserve authoritative later generations per FR-001 / FR-009 (partial).
- [x] T029 Measure the exact base and feature download graphs, address the launch route budget failure and verify bounded bundle growth per FR-012 / SC-006 (verification follow-up).

- [x] T030 Fence deferred batch loading with the original actor epoch, including sign-out/sign-in of the same actor, per FR-006 (acceptance follow-up).

## Phase 10: Owner-requested unattended fault hardening
- [x] T031 Enumerate cross-layer failure/race matrix and extend specification/plan with explicit safe uncertainty and browser lifetime semantics (FR-013–FR-017).
- [x] T032 Reproduce ten-item starvation after two lost replies and unavailable receipts with real useLaunchGeneration; reproduce missing producer input poisoning surviving consumers (FR-013, FR-017).
- [x] T033 Implement bounded readback, same-key replay, parked uncertainty, hidden-tab cadence, terminal child handling and unload guard; verify stop/scope/stale/late-response races (FR-013–FR-016).
- [x] T034 Isolate deleted/canceled shared producers and verify surviving consumers, retained outputs and authority checks (FR-017).
- [x] T035 Verify diagnostic ingestion/CLI semantics, design, download budget and broad fault regressions; run two review/fix passes and canonical verify; commit only to 053 (FR-011–FR-017).

- [x] T036 Verify automatic recovery after five-minute preflight/admission outages, fair atomic slot reservation, Stop during internal provider backoff, late save completion, and pending cancellation/cleanup isolation (FR-014–FR-016).
