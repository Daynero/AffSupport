# US5 declared backend changes — recorded results

Recorded 2026-09-12 on the development host (MacBookAir10,1, 16 GiB, macOS 26.6.2).

`npx vitest run tests/release-runner-backend.test.ts` — 11 passed, 0 failed.
The read-only analytics CLI (`scripts/analytics/`) was not modified.

## Boundary scenarios

| Scenario                                                        | Expected refusal               | Result                                                                |
| --------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| Extra pending migration that the release never declared         | `BACKEND_PENDING_SET_MISMATCH` | pass — the pending set must match the plan exactly, members and order |
| Change aimed at a different target than the validated binding   | `TARGET_MISMATCH`              | pass — checked before any read of the server                          |
| Content whose digest differs from the reviewed one              | `BACKEND_CONTENT_MISMATCH`     | pass                                                                  |
| Change the currently released client could not survive          | `BACKEND_INCOMPATIBLE`         | pass — refused before any receipt is prepared (0 flushes)             |
| Partial nontransactional result                                 | `MIGRATION_EFFECT_AMBIGUOUS`   | pass — blocked; no rollback is guessed                                |
| Existing version with no trustworthy receipt                    | `MIGRATION_PROVENANCE_UNKNOWN` | pass                                                                  |
| No plan declared                                                | zero writes                    | pass — the server is not even asked what is pending                   |
| Rehearsal against a production binding                          | `TARGET_MISMATCH`              | pass                                                                  |
| Rehearsal without a resource lease                              | `LEASE_REQUIRED`               | pass                                                                  |
| Sandbox rehearsal of a declared change                          | applies under the lease        | pass                                                                  |
| Plan naming a production target while running a sandbox release | `BACKEND_PLAN_INVALID`         | pass                                                                  |

## Ordering

The prepared receipt is flushed **before** the write, verified by recording the
call order: `flush:prepared` then `apply`. A crash between the two leaves a
record that says what was about to happen, which is the only state
reconciliation can interpret. Reconciliation then requires history presence,
passing postconditions and a matching target before the change counts as
observed.

## Note on task status

Two tasks were marked complete without the work behind them, and both are fixed:

- T057 named `scripts/lib/release/adapters/backend.mjs`, which did not exist.
  The exact-pending-set, content-digest and backwards-compatibility checks had
  no implementation at all. They are implemented and covered above.
- T058 claimed the backend was embedded in the step registry. It was not: there
  was no backend step, so `applyBackendPlan` was unreachable from the release
  flow. The registry now runs `backend_beta` before `readiness` and
  `backend_apply` after `manifest_beta_verify` and before `deploy`, matching the
  two positions `backend-plan.mjs` accepts. With no declared plan the adapter is
  never called.

## Still open

These scenarios run against an injected backend adapter. The end-to-end sequence
against a real isolated Supabase project — beta rehearsal, then the dependent
deploy — is part of T062 and is blocked on sandbox credentials, as recorded in
`validation/blockers.md`.
