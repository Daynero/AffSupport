# 042 — Production readiness and extended acceptance

**Status:** OPEN; hosted execution BLOCKED pending a separately authorized test project.
**Created:** 2026-10-24. **Origin:** owner's explicit split of feature 036.

## Objective

Complete the substantial acceptance work remaining after 036's local implementation closure: authenticated 30/50-user load, soak and reconnect burst, hosted deployment/runtime identity, resource projections, fault/recovery races, backup/restore, exact-commit packaged acceptance and the remaining full manual role/browser/device matrix. This specification inherits the original requirements without declaring unexecuted work successful.

## Scope and traceability

[Inherited tasks](inherited-tasks.md) contains all 78 unfinished obligations verbatim with original IDs. The authoritative transfer is [036 scope-transfer.json](../036-production-acceptance/scope-transfer.json). Original [specification](../036-production-acceptance/spec.md), [data model](../036-production-acceptance/data-model.md), [contracts](../036-production-acceptance/contracts/acceptance-tooling.md), [manual cases](../036-production-acceptance/manual-test-cases.md), [required variants](../036-production-acceptance/required-variants.json), [capacity plan](../036-production-acceptance/capacity-plan.md) and [runbook](../036-production-acceptance/runbook.md) remain the normative detailed requirements for this work. Historical paths and Txxx references are retained deliberately; existing CLI/schema/policy interfaces are unchanged.

Completed components and proofs from 036 are starting points, not automatically adopted evidence for a later candidate. The protected adoption categories and full case/variant accounting still apply. 174 original manual cases remain distinct from task counts. Native Windows runtime remains owner-excluded under the original policy, never PASS; portable tests and applicable macOS multi-device work remain required.

## Acceptance requirements

1. Bind SQL, Auth, Functions, management, web and native worker observations to the same authorized target and candidate. Reject stale/mixed identity before writes. Preserve unavailable signals as unknown.
2. Exercise all remaining role/browser/security/tariff/recovery variants with correlated intent, acceptance, execution, terminal and user-visible delivery evidence. Retries, cancellation, interruption, partial completion and delayed/missing diagnostics must be explainable through the read-only CLI, following specification 031. No user content, credentials or raw provider payloads in evidence.
3. Run the original LOAD-01–10 workloads, including 30/50 users, eight-hour soak and 150-tab reconnect burst. Separate API and actual correct-visible-result latency; retain warmups, timeouts and censored samples. Enforce the original stop thresholds and baseline recovery limits.
4. Produce reset-aware bounded resource measurements and 30/90-day forecasts with explicit unknowns and headroom; do not claim local measurements prove hosted capacity.
5. Prove isolated backup/restore, RPO/RTO, permissions and external-file coverage. A database dump does not back up Drive contents.
6. Verify the exact clean commit's packaged beta with real authentication, entitlement and completed operation. Re-run candidate-sensitive critical evidence rather than adopting protected results.
7. Publish a complete immutable report and GO/NO_GO with unresolved cases and diagnostic blind spots explicit. A critical BLOCKED/NOT_RUN/FAIL prevents production GO. Production execution remains a separate explicit instruction under docs/PRODUCTION.md.

## Operational constraints

No production fallback, project purchase, deployment, invitation delivery or paid resource creation is authorized by this split. Use a separately authorized hosted test project. Preserve the owner's retained beta profile, pairing, approved tariff UI and existing Drive files. Drive operations stay within the previously approved folder and modify/delete only owned QA artifacts. Heavy local work runs one process at a time; fault scopes must isolate actual worker claims and backend-global clock effects.

## Starting evidence

036's current frozen local release verification passed 22/22 gates, 7,374 tests with 41 explicit skips, and 81.38% coverage; all 3,134 inputs stayed unchanged. Completed-log reconciliation passed 106 additional checks. See [verification summary](evidence/local-release-verification.json). These results prove that local source snapshot, not hosted capacity or a clean packaged commit. Only production was visible during hosted project discovery; no test project is configured.
