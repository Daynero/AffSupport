# Tasks: Soty для Intel Mac

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md).
**Tests**: explicitly required by FR-013 and the release safety boundaries. Implementation authorised 2026-11-06 in isolated worktree; completed work must have evidence. Paths marked new are planned files. Tests for boundary changes must fail before their fix.

## Phase 1: Setup

- [x] T001 Record approved Node/FFmpeg/FFprobe/Whisper/Chromium Intel input versions, digest/source/license mapping, minimum OS and CPU baseline, reference hardware access and existing caller inventory in `specs/049-macos-intel-support/input-inventory.md` (new); inspect `scripts/lib/agent-staging.mjs`, all `release-meta`/download callers and proof readers; enumerate exact typed diagnostic producer → web sanitizer → server ingestion allowlist → stored props/columns → CLI query/code-map paths, required privacy guards and missing preboot evidence. Missing compatible input blocks packaging; Intel hardware observation is post-release (FR-002/FR-010).
- [x] T002 Reconcile actual implementation status and ownership of 048 signing/native updater and document Intel integration prerequisites in `specs/049-macos-intel-support/trust-integration.md` (new); record that manual handoff remains until capability exists and public launch requires applicable trust gates (FR-007/FR-011).

## Phase 2: Foundation

- [x] T003 Add failing target mapping/input-validation/canonical-name and historical-manifest tests in `tests/macos-target.test.ts` (new), extending `tests/release.test.ts` and `tests/release-manifest-signature.test.ts` for old two-platform versus new three-platform channel (FR-001/FR-009/FR-012).
- [x] T004 Extend canonical artifact definitions/URLs and validated target contracts in `packages/shared/src/release.ts`, `packages/shared/src/release-runner.ts`, `scripts/release-meta.mjs`, `scripts/dev-release-meta.mjs`; rebuild shared before consuming it. Keep historical verification separate; defer requiring Intel in final production candidate until US3 integration is ready (FR-001/FR-009).
- [x] T005 Implement `scripts/lib/macos-target.mjs` (new) for closed arm64/x64 parsing and toolchain mapping from canonical target, default ARM compatibility and target-specific staging/output paths; no cleanup for invalid inputs (FR-008).

**Checkpoint**: canonical target definitions exist, no production activation or claim of Intel availability.

## Phase 3: US1 — Intel package and functioning tools (P1, local MVP)

**Goal**: a genuine target-consistent Intel package preserving the existing product.
**Independent test**: static target/deployment/signature/source/config qualification without Intel hardware; runtime tools/Finder/auth/settings are first-user follow-up. Public availability remains gated by US2/US3 and 048.

- [x] T006 [US1] Add failing mixed-target/browser-helper/dylib/min-OS and target-isolation regressions in `tests/macos-package-target.test.ts` (new), with fixtures for non-system dependencies and runtime acceptance accidentally using host browser (FR-002/FR-008).
- [x] T007 [US1] Forward `--arch` through npm wrappers in `package.json`, `scripts/package-dev-dmg.sh`, `scripts/package-dmg.sh`, `scripts/package-dev-mac.sh`, `scripts/package-beta-mac.sh`, `scripts/package-mac.sh`; add a composite command wrapper that forwards arguments to every child, validate before build/admission/listener mutations, parameterize launcher/Finder compilation in `scripts/build-finder-extension.sh`, preserve environment identity and disjoint app/ZIP/DMG/generated files/mount staging (FR-001/FR-004/FR-008).
- [x] T008 [US1] Make `scripts/lib/agent-staging.mjs` and `scripts/stage-agent-runtime.mjs` provision/stage exact target Chromium with revision/architecture manifest and portable approved engines; inspect native Node dependencies and neutral model resources, preserve license/source attribution (FR-002).
- [x] T009 [US1] Generalize `scripts/verify-package.sh`, `scripts/verify-dmg.sh`, `scripts/verify-dev-package.sh`, `scripts/verify-beta-package.sh` with recursive target-slice/deployment/dependency checks including browser helpers, using the target helper; distinguish static cross-build checks from native execution (FR-002/FR-008).
- [x] T010 [P] [US1] Add regression tests in `tests/macos-runtime-policy.test.ts` (new) for runtime identity, CPU-only Whisper fast mode, unchanged ARM mode, nullable GPU diagnostics and governor cancel/timeouts at 20%/100% (reuse `tests/power-graphics.test.ts` and `tests/power-governor.test.ts` for the unchanged shared seams) (FR-003/FR-004).
- [x] T011 [US1] Extend `apps/agent/src/platform/platform.ts`, `apps/agent/src/server/app.ts`, `apps/agent/src/server/capabilities.ts` and `apps/agent/src/whisper/transcriber.ts` with Intel/backend-aware policy and authoritative runtime architecture through existing seams; no scattered OS/arch checks or unmanaged processes (FR-003/FR-004).
- [ ] T012 [US1] Post-release, collect first-user Intel runtime scenarios from `specs/049-macos-intel-support/quickstart.md`, write exact package/hardware/OS/results in `specs/049-macos-intel-support/acceptance-intel.md` (new): all local tools, Finder, auth/entitlement, bundled-engine-only execution, cancel, power, retained data and single-instance. This is deferred user-feedback work, not a publication prerequisite; absent observations never become pass (FR-003/FR-004/FR-010; SC-001).

## Phase 4: US2 — Correct download and update target (P1)

**Goal**: verified target choice across all discovered download/update surfaces.
**Independent test**: signed fixture matrix for Intel/ARM/Windows, unknown/legacy and browser/agent mismatch. Does not require production upload.

- [x] T013 [US2] Add failing resolver/pinning/caller tests in `tests/macos-artifact-selection.test.ts` (new), extending `tests/release-version-gate.test.tsx`, `tests/release-update-notice.test.tsx`, `tests/auth-ui.test.tsx` and `tests/onboarding-recovery.test.tsx`: absent/invalid Intel, wrong target, user-agent mismatch, unknown/legacy identity and no native updater capability (FR-005/FR-006/FR-007).
- [x] T014 [US2] Extend `apps/web/src/release-manifest.ts` and its inventoried download/update callers from T001 with explicit Intel target and available/unavailable/choice-required handling, native identity priority, historical-channel compatibility and fail-closed Intel links; preserve existing public adapters where needed (FR-005/FR-006/FR-007).
- [x] T015 [US2] Update all inventoried Mac download/update UI surfaces from T001 using `apps/web/src/components/ui/` and `apps/web/src/styles/tokens.css`; add accessible Intel/Apple Silicon labels, unknown choice and unavailable/manual-handoff messages in `apps/web/src/locales/uk.ts` and `apps/web/src/locales/en.ts`. Read `docs/DESIGN.md` then `docs/DESIGN-PRINCIPLES.md` before edits (FR-005/FR-006/FR-012).
- [x] T016 [US2] Integrate same-target candidate identity with 048 contracts only where implemented, using `apps/web/src/release-manifest.ts` and actual native updater entry point recorded in `specs/049-macos-intel-support/trust-integration.md`; test wrong-target refusal and manual fallback. Record missing 048 trust/native acceptance as blocked rather than adding an alternate updater (FR-007/FR-011).
- [ ] T017 [US2] Post-release, record manual Intel keyboard/screen-reader feedback; retain required automated download/update fixture coverage for selection, unknown/legacy, missing/invalid artifact, mismatched browser and ARM/Windows controls in `specs/049-macos-intel-support/acceptance-selection.md` (new) (SC-002/005).

## Phase 5: US3 — Repeatable release and architecture-aware diagnosis (P2)

**Goal**: one complete three-platform release proof and accurate read-only Intel diagnosis.
**Independent test**: negative proof/manifest fixtures plus isolated producer→storage→CLI pipeline, no production changes.

- [x] T018 [P] [US3] Add wrong-target/source/config/seal/hardware/missing proof regressions in `tests/macos-beta-target-proof.test.ts` (new), extending `tests/beta-promotion-gate.test.ts` and `tests/mini-release-contract.test.ts`; one ARM proof must never certify Intel (FR-009/FR-010/FR-012).
- [x] T019 [US3] Extend `scripts/beta-package-provenance.mjs`, `scripts/verify-beta-runtime.mjs`, `scripts/verify-beta-promotion.mjs` and beta command wrappers in `package.json` to select target and retain separate exact-source/config/sealed-byte/runtime-architecture/hardware/OS proofs; aggregate every required target without overwriting evidence (FR-008/FR-009/FR-010).
- [x] T020 [US3] Bind existing Windows hosted validate/install/use proof and final installer digest/source from `.github/workflows/release-windows.yml` to aggregate evidence in `scripts/lib/release/evidence.mjs` and `scripts/lib/release/step-adapter.mjs`; extend `tests/release-gates-windows.test.ts` to reject missing/stale/wrong-source/installer Windows evidence. Do not fabricate a Windows macOS-beta record or add a Windows beta environment (FR-009/FR-012).
- [x] T021 [US3] Extend full release intent/state/artifact iteration and adoption/recovery in `scripts/lib/release/intent.mjs`, `scripts/lib/release/step-adapter.mjs`, `scripts/lib/release/adapters/package.mjs`, `scripts/lib/release/adapters/manifest.mjs`, `scripts/lib/release/bindings.mjs` and `scripts/lib/release/evidence.mjs`; process Intel under the same admission/resource locks, preserve unknown-outcome reconciliation (FR-009/FR-012).
- [x] T022 [US3] Complete required three-platform candidate set in `packages/shared/src/release.ts` and validators/metadata/signing/final-provider readback in `scripts/verify-release.mjs`, `scripts/sign-release-manifest.mjs`, `scripts/verify-published-release.mjs`, `scripts/verify-release-provider.mjs`; keep previous trusted manifest historically valid and preserve immutable assets (FR-009/FR-012).
- [x] T023 [US3] Update complete-baseline proof consumers in `scripts/lib/web-only-runtime.mjs`, `scripts/release-web-only.mjs` and `scripts/release-web-meta.mjs`; mini must retain sealed packages/current signed channel and refuse shared/agent candidate changes, stale/missing target proof or architecture switch (FR-012).
- [x] T024 [P] [US3] Add failing typed identity/guard/privacy and producer→storage→CLI tests in `tests/analytics-agent-architecture.test.ts` (new), extending `tests/analytics-coverage-registry.test.ts` and `tests/analytics-code-map.test.ts`; cover every diagnostic matrix row, delayed/missing joins/terminals and Windows x64 separation (FR-013; SC-004).
- [x] T025 [US3] Add bounded privacy-safe pre-server startup stage/reason recording and local bundle fallback in `packaging/Launcher.swift` and the existing support-bundle seam inventoried by T001; add `tests/macos-startup-evidence.test.ts` (new) plus actual native fault fixtures for missing Node, wrong architecture and interrupted boot. Export no raw paths/secrets/content; no startup record still means insufficient, not proven OS rejection (FR-013).
- [x] T026 [US3] Extend diagnostic typed props/codes in `packages/shared/src/types.ts` and existing analytics contracts, native producers under `apps/agent/src/server/` and web producers in `apps/web/src/analytics/`; propagate separate native architecture/target/build and correlation without changing browser field semantics. Follow `contracts/diagnostics.md` privacy/collection bounds (FR-013).
- [x] T027 [US3] Carry new safe metadata through `apps/web/src/analytics/events.ts`, `apps/web/src/analytics/guard-contract.ts`, `apps/web/src/analytics/service.ts` and database RPC `ingest_analytics_events` / guard `analytics_properties_are_safe_v2` via a forward-only migration in `supabase/migrations/`; prefer existing bounded props over new columns. Extend `tests/analytics-guard-contract.test.ts` and add `supabase/tests/database/analytics-runtime-architecture.test.sql` for the real authenticated ingestion path; regenerate `apps/web/src/lib/database.types.ts` if schema/RPC shape changes, and verify privacy/RLS. Add no production writes to analytics CLI (FR-013).
- [x] T028 [US3] Extend `scripts/analytics/` cohorts with additive `agent-architecture` grouping plus platform/build split and extend investigate/inspect/audit diagnosis; update `scripts/analytics/coverage-registry.ts`, `scripts/analytics/code-map.ts` and `docs/ANALYTICS_CLI.md` with missing-evidence semantics and unchanged envelopes/read-only guard (FR-013).
- [x] T029 [US3] Add/run three-platform runner/published-asset/historical-channel/recovery regressions in `tests/release-runner-contract.test.ts`, `tests/release-runner-step-adapter.test.ts`, `tests/release-runner-manifest.test.ts`, `tests/release-gates-windows.test.ts` and mini/beta tests touched above; record fixture results in `specs/049-macos-intel-support/acceptance-release.md` (new) (SC-003/005).
- [ ] T030 [US3] Collect post-release Intel runtime diagnostic outcomes after the mandatory isolated typed producer/guard/storage/CLI checks; write last-proven stage, native/browser identity, delivered/unknown outcome, delivery lag, privacy rejections and coverage in `specs/049-macos-intel-support/acceptance-diagnostics.md` (new). Missing/disabled collection remains explicit, no production telemetry injection (FR-013; SC-004).

## Phase 6: Integration and acceptance

- [ ] T031 Execute required ARM native beta, Windows hosted and Intel static package qualification; defer Intel minimum/newer-OS runtime controls to user feedback; retain applicable 048 per-architecture trust/install/update A→B/recovery checks, and three-target promotion proof aggregation; write `specs/049-macos-intel-support/acceptance-matrix.md` (new) with exact hardware/source/package/outcomes. Missing applicable Apple trust or required automated proofs blocks promotion; Intel hardware absence does not, no production activation (FR-010/FR-011/FR-012; SC-001, SC-002, SC-003, SC-004, SC-005).
- [x] T032 Update `docs/PRODUCTION.md`, `docs/BETA.md`, `AGENTS.md` and developer build/download documentation from T001 for target flags/paths, historical versus candidate platform sets, exact multi-target proofs, Intel prerequisites and CLI coverage; preserve one-source CLAUDE pointer and mini restrictions (FR-008/FR-009/FR-012/FR-013).
- [ ] T033 Format touched files, run required `npm run format`, focused single-worker regressions, `npm run verify` and `npm run verify:release` sequentially under the resource budget; inspect `verification-result.json`, record results/blockers in `specs/049-macos-intel-support/acceptance-matrix.md` and rerun cross-artifact analysis before declaring readiness. Do not commit unrelated formatting or mutate production (FR-012/FR-013).

## Dependencies & Execution Order

T001→T002→T003→T004→T005 is the foundation. Tests precede corresponding implementation. T006→T007→T008→T009; T010→T011; T012 follows both paths. T013→T014→T015→T016→T017. T016 depends on T002/048 implementation state; a manual-flow pass never closes public trust readiness.

US2 resolver tests can use fixtures after foundation; integrated identity selection depends on T011. US3 tests can start after foundation. T018→T019→T020→T021→T022→T023→T029; T024→T025→T026→T027→T028→T030. T019 consumes T007–T012 package proof; T026 consumes T011/T014/T016 identities/stages. T031 follows T012/T017/T029/T030 and actual applicable 048 trust implementation. T032 follows accepted interfaces; T033 follows all changes. All required acceptance is sequential per heavy resource policy.

### Parallel opportunities and examples

`[P]` means independent file edits after prerequisites, not permission to run concurrent heavy commands or spawn agents. Within US1, T010 tests may be written alongside T007/T008. US2 test scenarios may be authored against foundation fixtures while US1 packaging proceeds; overlapping runtime/download files stay serial. Within US3, T018 proof tests and T024 diagnostic tests use disjoint files. No production verification is bypassed by parallel work.

## Implementation Strategy

Deliver US1 as a local Intel MVP, validate actual outputs. Add explicit choice/update selection as US2. Finish US3 target-bound release evidence and agent-readable diagnosis, then integrated trust/regression matrix. Only the complete accepted increment is eligible for an independently authorised full production release; a local package or green unit suite is not Intel launch.

## Implementation checkpoint — 2026-11-07

Worktree: `AffSupport-049-intel`, branch `049-macos-intel-support`, base `59524e4b`. Main task files were not edited. No production action, version change, tag, deployment or publication performed.

Source now includes both Mac packaging targets, actual pinned portable Intel inputs, recursive native payload inspection, architecture-aware download/update handoff, exact multi-target beta seals, three-platform release orchestration, source/run-bound Windows proof, complete mini-release baseline and bounded native pre-server diagnosis with UUID correlation through producer/guard/storage/CLI. The old transitional ARM-only production block was replaced with actual multi-target proof and Apple trust gates.

Tests, native build and verification results are recorded in [acceptance-matrix.md](acceptance-matrix.md), [acceptance-release.md](acceptance-release.md) and [acceptance-diagnostics.md](acceptance-diagnostics.md). Source completion and external acceptance are distinct: physical Intel macOS 13/newer runs, public Apple trust and packaged ARM/Windows controls cannot be marked passed from local cross-builds. T012/T017/T030 are post-release Intel feedback follow-up under the owner decision; T031/T033 retain required automated/trust verification. Intel physical/native absence is not a pre-release blocker. Compiled native missing-executable, foreign-CPU and interrupted-boot fixtures pass, including the actual local CLI diagnosis. Hardware acceptance remains distinct.

## Owner decision — 2026-11-07

The owner has no Intel test hardware and selects first-user runtime feedback, as with Windows user feedback. [release-policy.md](release-policy.md) supersedes earlier pre-release physical/native Intel requirements. Deferred feedback tasks are not marked passed.

- [x] T034 [US3] Implement `intel-user-feedback-v1`: exact-source/config/payload/signature-bound schema-3 static Intel evidence, no target execution, no hardware-report prerequisite, mode-bound mini baselines, unchanged ARM native/Windows hosted/Apple trust gates and non-execution/false-native/byte-tamper regressions (FR-009/FR-010/FR-012/FR-013).

## Review — 2026-11-09 (Claude)

Independent audit of the uncommitted implementation: [review-claude.md](review-claude.md). Task status unchanged: T001–T011, T013–T016, T018–T029, T032 and T034 are implemented in source (with the fixes listed in the review); T012/T017/T030 remain post-release user feedback; T031/T033 remain open because the full `npm run verify`, `npm run verify:release`, `npm run test:db`, packaged ARM/Windows controls and Apple trust were not executed in this review. The 049 migrations were renumbered to `20261207190000_agent_native_identity_analytics.sql` (collision with 047); the guard body must be rebased on 047's when both merge.
