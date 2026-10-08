# Implementation evidence

## Worktree boundaries

Feature 029 is implemented on the existing branch. The pre-existing AGENTS.md,
team/sync/auth/design/analytics/Supabase changes, feature 028, and incident files
belong to parallel work and are excluded from staging. No production release is
authorized. Feature 029 artifacts and its feature pointer belong to this change.

Prerequisites resolve to feature 029. Requirements checklist: 16/16 complete.
Existing git/Prettier/ESLint ignores cover runtime release files and build output;
no blanket ignore or scripts typechecking exception is introduced.

## Acceptance

Provider feasibility is mandatory before dependent controller implementation.
Version/schema/auth inspection alone does not establish unattended repair safety.
Actual canaries and repair evidence will be recorded here; missing proof is not a
successful test.

## Implemented surface

Atomic task store/target ownership; deterministic controller/canonical adapter;
private Unix CLI; launchd installer; isolated provider/source checkout; persistent
budgets/fences; incremental hash-chain observations; canonical metrics; secure
loopback session/CSRF/SSE/log server; independent inventory/token-based panel.
Legacy acknowledged results are collected; controller-owned outbox jobs are
excluded from legacy delivery to prevent two editors.

Automatic import permits only product source under apps/packages, not gates,
tests, scripts, workflow/config, governance, package metadata, keys or artifacts.
Completed persisted repair results can be recovered without another model turn.
Incomplete acceptance/final usage/application remains a fail-closed blocker.

## Actual checks (2026-10-07/08)

- Actual Codex 0.161.0 managed-auth capability smoke: **PASS**, all 15 checks.
  Receipt: `/var/folders/t9/3xc8_cv17r55zvk7kjsbbl4m0000gn/T/soty-provider-canary-7UCxlK/capability.json`.
  Proved nonce read, real patch, isolation, cumulative usage and interruption.
  Successful tiny fixture used 38,002 cumulative tokens, 29,312 cached input;
  failed feasibility iterations are not successful evidence or zero usage.
- Provider/controller/ownership/budget/progress/real localhost security and
  canonical CLI/flow/step/recovery/cancel/handoff/metrics checkpoint:
  **54 tests passed across 12 files**.
- UI DOM/schema/source-scope and journal UTF-8/hash-chain checkpoint:
  **8 tests passed across 3 files**, overlapping four journal/progress tests
  already present in the 54-test checkpoint.
- Project/test/script typechecking, design tokens, Tailwind, styles, i18n,
  env registry, CSP and audit passed in full verify at the checkpoint.
  Script typechecking was rerun after recovery changes without exclusions.
- Isolated panel build **PASS**; output remains ignored under
  release/automation/panel, with no production Vite entry/deploy changes.
- Full verify checkpoint **FAILED** on parallel incident formatting and our
  symptom-cause lint error. Our lint was fixed; parallel files were not edited.
  Standard suite and final verification results are recorded below when done.
- Chrome visual QA **NOT PASSED**: localhost browser navigation returned
  ERR_BLOCKED_BY_CLIENT and native Google Chrome control was not approved.
  DOM/server tests are not a substitute for actual visual evidence.

## Remaining live acceptance

No production release, tag/asset/version/deploy/database change or launchd install
was performed. No activation.json or sandbox proof was fabricated.
Three real unattended sandbox releases, controlled real repair/candidate and
loss scenarios, installer/login/wake acceptance, 30-minute CPU/RSS measurement
and Chrome visual QA remain required. Unit evidence is not production activation.

Parallel feature 028 was independently committed as d873daab while this work
was running; none of those paths is included in the feature 029 commit.

## Final verification checkpoint

- Final provider receipt after denying .git/history and binding readiness to
  SHA-256 of the exact provider boundary code: **PASS**, all 15 actual checks.
  `/var/folders/t9/3xc8_cv17r55zvk7kjsbbl4m0000gn/T/soty-provider-canary-njBqWi/capability.json`.
  Boundary digest: b7494481243c8cb3bd0293c0259e4df1dd31bd001220307023567b890bdb668e.
  Actual successful fixture: 38,458 total tokens, 14,592 cached input. Model
  networking and original checkout remain inaccessible. Monitoring uses none.
- Combined focused tests: **68/68 passed in 15 files**; frozen sandbox-binding,
  foreign repository, unchanged intent and production-activation guards:
  **2/2 passed** separately. Total checkpoint: **70 tests in 16 files**.
- Whole repository `npm run lint`: **PASS** after correcting both feature-owned
  symptom errors to retain their causes. Typechecks and panel build passed.
- Standard suite phase: **4317 passed, 4 failed, 10 skipped**, 4331 total.
  Failures: catalog-scan-generations, suite-hygiene (team-explorer-refresh sleep),
  team-explorer-live-refresh and team-folder-sync-api. Those parallel feature
  paths were not modified. No claim of a green overall suite.
- Release static phase ran and failed on the pre-existing parallel incident
  document formatting plus the subsequently fixed feature lint error.
  Full release acceptance/build/database/coverage and production activation
  remain **NOT PASSED**, not inferred from a static or focused run.
- The synthetic localhost demo process was stopped after tests. Chrome remained
  unavailable to automation; no browser visual acceptance is claimed.
