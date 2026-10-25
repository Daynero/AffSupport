# Independent review 2 — backend, data and proof

**Reviewer**: independent agent `review_backend`. **Date**: 2026-10-25.
**Scope**: read-only speckit-analyze of the initial complete spec/plan/tasks/contracts. No file edits, no coordination with reviewer 1. Historical IDs refer to 76-task version; [mapping](task-id-map.json) preserves traceability.

| ID    | Severity | Original finding / location                                                                                     | Required action                                                                                                                       |
| ----- | -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01 | HIGH     | plan.md:98/103, tasks T023/T039: production-config DB-dependent journey before backend apply                    | Two admission phases; postapply/preactivation exact control; partial/resume regression                                                |
| R2-02 | HIGH     | data-model.md:20, verification.md:19, tasks T017–T019: beta Swift launcher differs as executable, not just JSON | Split byte-identical payload from native-wrapper source/toolchain/substitution/binary build provenance; no wildcard exclusion         |
| R2-03 | HIGH     | mini-release.md:34–35, tasks T033/T034/T040: custom vendor ledger lacks exact format/interop proof              | Supported version/schema/privileges/tuples, atomicity and real next full migration via vendor CLI                                     |
| R2-04 | HIGH     | plan.md:101/104, tasks T029/T034: per-statement 30s plus stop-new-transactions does not enforce total 120s      | Absolute transaction/apply deadlines, remaining per-statement timeouts, reserve for history/COMMIT/observe, multi-statement real test |
| R2-05 | HIGH     | plan.md:116, verification.md:15, task T047: same UID can read parent secret files                               | Real OS boundary, allowed inputs, denied host access/store, actual absolute-path/symlink canaries                                     |
| R2-06 | MEDIUM   | plan.md:96, quickstart.md:23–29, task T008: missing ordinary source+target intent preparation                   | Concrete operator entrypoint/task/CLI regression independent of harness                                                               |

**Initial metrics**: 42 requirements, 76 tasks, nominal coverage 100%, wholly unmapped requirements/tasks 0, CRITICAL 0, HIGH 5, MEDIUM 1, duplication 0. Proposed constitution change and production activation guards explicit; no silent override. All six findings require design correction; unexecuted native/hosted acceptance and ratification remain future prerequisites.

**Remediation**: see [closure ledger](closure.md); re-review is a separate verdict, not retroactive initial PASS.
