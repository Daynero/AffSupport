# Independent review 1 — release orchestration

**Reviewer**: independent agent `review_release`. **Date**: 2026-10-25.
**Scope**: read-only speckit-analyze of the initial complete plan/contracts/tasks. Files were not edited by the reviewer. Historical task IDs refer to the initial 76-task version; [mapping](task-id-map.json) relates them to the revised version.

| ID    | Severity | Original finding / location                                                                                          | Required action                                                                                         |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| R1-01 | HIGH     | verification.md:23, plan.md:98, task T023/T039: production critical journey before its new backend exists            | Separate prewrite isolated proof, backend apply, exact production preview/control, activation admission |
| R1-02 | HIGH     | verification.md:15, plan.md:103, task T047: env/worktree does not deny absolute host key/store access                | Concrete OS/container isolation, trusted verifier outside, actual hostile canary tests                  |
| R1-03 | HIGH     | mini-release.md:35, tasks T033/T034: undefined custom Supabase migration history interoperability                    | Pin ledger shape/version/tuple, atomicity, source proof and real mini→CLI/full interop                  |
| R1-04 | MEDIUM   | verification.md:21, task T070: undefined support cohorts/native reuse could require manual Windows for every CSS fix | Finite versioned cohort artifact and fresh/reused selector                                              |
| R1-05 | MEDIUM   | FR-004, mini-release.md:3, quickstart.md:25, task T008: operator has to handcraft digests or use test harness        | Normal source+target command, automatic immutable draft/start, tests and quickstart                     |

**Initial metrics**: 42 requirements (27 FR, 7 AD, 8 SC), 76 tasks, nominal coverage 100%, unmapped requirements/tasks 0, CRITICAL 0, HIGH 3, MEDIUM 2, duplication 0. Governance exception explicitly proposed and production activation closed; no hidden constitution override. Findings were design blockers; native/hosted/timing/ratification remained future execution prerequisites.

**Remediation**: see [closure ledger](closure.md). This record preserves the independent original findings; follow-up verdict is recorded separately.
