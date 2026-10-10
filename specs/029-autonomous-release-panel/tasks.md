# Tasks: Автономний локальний реліз із панеллю

**Input**: spec.md, plan.md, research.md, data-model.md, contracts/.

Tests required by acceptance specification. Changes restricted to feature paths; existing parallel fixes are excluded from staging.

## Phase 1 — Setup

- [x] T001 Record dirty-worktree boundaries, verify ignore files and feature prerequisites in specs/029-autonomous-release-panel/implementation.md.
- [x] T002 Add validated automation contracts and policy defaults in packages/shared/src/release-automation.ts and config/release-automation-policy.json.

## Phase 2 — Foundation and provider feasibility

- [x] T003 Write provider protocol, usage, permissions and cancellation tests in tests/release-repair-provider.test.ts.
- [x] T004 Implement pinned stdio provider with managed auth, restricted permissions and bounded output in scripts/lib/release/codex-provider.mjs.
- [x] T005 Prove real isolated repair/read-network canaries and record capability evidence via scripts/verify-release-provider.mjs.
- [x] T006 Implement atomic task store, target ownership and generation fences in scripts/lib/release/task-store.mjs and scripts/lib/release/target-ownership.mjs.

## Phase 3 — US1: Request to final completion

Independent test: complete full isolated task with canonical final proof, no manual coordination.

- [x] T007 [US1] Write end-to-end controller and target contention tests in tests/release-controller.test.ts.
- [x] T008 [US1] Implement controller orchestration and canonical runner adapter in scripts/lib/release/controller.mjs and scripts/lib/release/controller-runner.mjs.
- [x] T009 [US1] Add accept/status/report/serve/doctor CLI and package scripts in scripts/release-controller.mjs and package.json.

## Phase 4 — US2: Automatic repair

Independent test: controlled failure triggers one agent repair and independent validation.

- [x] T010 [US2] Implement repair dispatch, cause-level budgets and independent result application in scripts/lib/release/repair-dispatch.mjs and scripts/lib/release/repair-budget.mjs.
- [x] T011 [US2] Normalize legacy bridge statuses and collect acknowledged-job results in scripts/lib/release/agent-bridge.mjs and scripts/lib/release/handoff.mjs.
- [x] T012 [US2] Implement isolated source repair and candidate replacement under validated policy in scripts/lib/release/repair-source.mjs.
- [x] T013 [US2] Test lost delivery/result, source invalidation, publication restriction and attempt caps in tests/release-repair-dispatch.test.ts and tests/release-controller.test.ts.

## Phase 5 — US3: Live local panel

Independent test: panel renders truthful progress, repair and stale observations without model.

- [x] T014 [US3] Implement frozen progress and incremental journal observations in scripts/lib/release/progress.mjs and scripts/lib/release/observation.mjs.
- [x] T015 [US3] Implement secure loopback snapshot/SSE/session/log/cancel server in scripts/lib/release/panel-server.mjs.
- [x] T016 [US3] Implement isolated frontend entry, subscription owner and inventory-based UI in apps/web/src/release-panel/ and apps/web/vite.release-panel.config.ts.
- [x] T017 [US3] Test stream/security/progress/UI and production build exclusion in tests/release-panel.test.ts, tests/release-panel-server.test.ts and tests/release-panel-ui.test.tsx.

## Phase 6 — US4: Token-free monitoring

Independent test: 5/60-minute unchanged waits create identical zero monitoring model calls.

- [x] T018 [US4] Wire canonical metrics and usage normalization in scripts/lib/release/metrics.mjs and scripts/release-runner.mjs.
- [x] T019 [US4] Test waiting/usage/bounded observation in tests/release-repair-budget.test.ts and tests/release-panel.test.ts.

## Phase 7 — US5: Recovery

Independent test: restart/cancel/adoption never duplicates published effects or repair owners.

- [x] T020 [US5] Add worker heartbeat and safe controller recovery in scripts/release-worker.mjs and scripts/lib/release/controller.mjs.
- [x] T021 [US5] Add explicit install/uninstall launchd integration in scripts/install-release-controller.mjs and packaging/release/controller-launchagent.plist.template.
- [x] T022 [US5] Test restart, stopped-worker adoption and late-result fences in tests/release-controller.test.ts. Real login/wake remains T027 acceptance.

## Phase 8 — US6: Genuine owner blockers

Independent test: access/scope/budget failure produces one concrete decision and preserves artifacts.

- [x] T023 [US6] Implement persisted blockers and validated owner decisions in scripts/lib/release/controller.mjs and scripts/release-controller.mjs.
- [x] T024 [US6] Test scope, repair quota and owner-decision behavior in tests/release-controller.test.ts and tests/release-repair-dispatch.test.ts. Real account quota remains T027 acceptance.

## Phase 9 — Verification and separate commit

- [x] T025 Document setup, limits and actual commands in docs/RELEASE_AUTOMATION.md and specs/029-autonomous-release-panel/quickstart.md.
- [x] T026 (closed 2026-10-10: done — the actual results are recorded in `implementation.md` ("Final verification checkpoint"): focused 70/70 in 16 files, lint/typechecks/panel build pass, full suite 4317 passed / 4 failed in other features' paths, which is stated rather than hidden) Run focused tests, type/build/design checks and npm run verify; record actual results in specs/029-autonomous-release-panel/implementation.md.
- [ ] T027 Run full isolated acceptance/provider/restart/overhead checks and npm run verify:release; record remaining external gates honestly in specs/029-autonomous-release-panel/implementation.md.
- [x] T028 Stage only feature-owned paths and commit separately, preserving parallel fixes; record SHA in final handoff.

## Dependencies and strategy

T001→T002→T003/T004→T005 gates autonomy; T006 before all runtime stories. US1→US2; US3 depends on foundation/observations; US4 follows usage/metrics; US5 follows controller; US6 follows repair budgets. Verification follows all stories. Runtime feasibility failures halt dependent implementation until resolved safely; never mark unexecuted acceptance complete.

Parallel opportunities (independent checks, not required delegation): provider tests and contract tests; UI rendering and server tests after shared contract; documentation and test review after behavior stabilizes. Execution is sequential for same files. MVP visibility is not autonomous acceptance.

## Remaining acceptance scope

Unit scope/budget/cancel/recovery fences are implemented and passing, but do not
replace full live fault/turn-loss/login/wake/account-quota scenarios in T027.
T026/T027 remain unchecked until their complete gate sets pass. Production
activation is closed; no real release was authorized.
