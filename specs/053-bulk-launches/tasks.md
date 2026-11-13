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

## Phase 11 — Owner follow-up: durable operation and UI (supersedes browser-local assumptions)
- [x] T037 Reconcile specification/plan/contracts with durable acceptance, default background, safe restart/fairness and two analysis/fix passes in specs/053-bulk-launches/ (FR-013–FR-020).
- [x] T038 [P] [US2] Add protected durable batch types/parsers, actor-authorized context, atomic per-item acceptance/refusal/read/cancel RPCs and Edge APIs in packages/shared/src/team/, supabase/migrations/, supabase/functions/drive-ops/ with DB/Edge regressions (FR-004, FR-006, FR-013–FR-016, SC-007).
- [x] T039 [P] [US2] Add fair paced background set claims and fenced old-native-boot adoption in supabase/migrations/ with pgTAP regressions, preserve uncertain upload authority and independent siblings (FR-015, SC-007).
- [x] T040 [P] [US2] Implement native coalesced setup/idempotent cloud handshake, actor-fenced automatic web ownership in recovery-worker.ts, recovery.ts, useRestitchPreparer.ts and recovery migration; cover old off, two tabs, logout, loss of reply (FR-018, SC-008).
- [x] T041 [P] [US2] Fix no-restart cooldown scheduling/legacy exhausted recovery in recovery-worker.ts and tests/team-recovery-worker.test.ts; retain persisted Retry-After and auth revocation (FR-013, FR-018).
- [x] T042 [US2] Replace browser queue with durable API submission/read/re-entry/cancel and existing workspace observation owner in LaunchBatch.tsx, LaunchSpace.tsx, batchModel.ts, apps/web/src/api/; remove manual status check and unload queue guard; update realistic fault tests (FR-013–FR-016, SC-007).
- [x] T043 [US1] Rename copy/paste/counts, offer/social/RK/status captions, reserve card dimensions and verify actual browser resize/state changes; deliver progress/settings screenshots in Downloads (FR-019, SC-009).
- [x] T044 [US3] Reproduce/fix clock reset, reconnect/reopen/scope and actual retry behavior in useLaunchElapsed.ts and tests/launch-elapsed.test.tsx (FR-020, SC-009).
- [x] T045 Remove background opt-in Settings UI and obsolete enable prompts in SpaceSettings.tsx/locales/updater notices; show actual automatic recovery/connection state (FR-018).
- [x] T046 Extend bounded typed diagnostics and agent-readable inspect/investigate/audit coverage for durable batches and automatic setup; verify missing/late signals (FR-011, SC-005, SC-007–SC-008).
- [x] T047 Run two code review/fix passes, focused/DB/browser/performance acceptance and canonical verify; update exact evidence and commit only 053 branch (FR-012, SC-006–SC-009).

Dependencies: T037 precedes T038/T039 and T040/T041. Those groups may be delegated in parallel with disjoint files and coordinated migration names. T043/T044 are independent. T042 follows agreed T038 contracts; T045 follows T040. T046 spans implementation; T047 follows all. Earlier checked tasks describe the previously verified implementation, not acceptance of the superseding durable requirements.

## Phase 12 — Compact desktop settings and canonical naming
- [x] T048 [P] [US3] Replace the creative picker with a single drop/pick/preview field and compact LaunchEditor shelves/disclosures; preserve authorization, validation and async scope fencing in LaunchCreativePicker.tsx, LaunchEditor.tsx and catalog field helpers; verify existing/new UI tests and desktop screenshots (FR-021, SC-010).
- [x] T049 [P] [US3] Remove note palette/tinted presentation, retain neutral legacy notes and actual copied-success marks in LaunchNotes.tsx/CSS and tests/launch-notes.test.tsx (FR-021, SC-010).
- [x] T050 Research and specify canonical catalog rename/embedded-name evidence/search aliases, update plan/contracts and analyze consistency before implementation (FR-022–FR-023, SC-011).
- [x] T051 [P] Implement actor-authorized idempotent canonical rename and old-name search/read projections through existing material operations, with DB/Edge/provider-race regressions (FR-022–FR-023, SC-011).
- [x] T052 [P] Add shared rename UI to LaunchResult and manager, actual-bound-name OK/Cancel warning and noneditable old-name annotation; verify confirmed synchronization and copy marks (FR-022–FR-023, SC-011).
- [x] T053 Extend bounded rename diagnostics and inspect coverage; repeat focused/visual/performance and canonical verification after all follow-up work (FR-011–FR-012, SC-006, SC-011).

T048/T049 use disjoint UI files and can proceed alongside Phase11. T050 precedes T051/T052; T053 and T047 final evidence follow all work. Desktop screenshots only per owner.
