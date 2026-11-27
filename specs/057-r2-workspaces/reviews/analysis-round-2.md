# Analysis round 2 — cross-check after remediation

2026-11-14. Read-only re-analysis, then explicit documentation refinement under the original recursive-improvement request.

| ID    | Severity | Location                                            | Finding                                                                               | Resolution                                                                                                                                                                 |
| ----- | -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-01 | HIGH     | contracts/migration.md cutover vs recovery snapshot | old text still accepted journal-only cutover protection after snapshot rule tightened | post-cutover snapshot must include exact receipt/new epoch/complete dependencies before completion or unfencing; after-commit timeout becomes explicit protection incident |
| R2-02 | MEDIUM   | contracts/recovery.md metadata GC                   | manifest dependency tracing lacks publication/GC concurrency fence                    | leased builder pins, generation fence, locks/keys through manifest expiry, unknown publication reconciliation and race fixtures                                            |
| R2-03 | MEDIUM   | contracts/recovery.md protected prerequisites       | requiring joint protected objects to publish their protection snapshot is circular    | replica_verified → snapshot_verified → joint protected; replica state separate from operation protection                                                                   |

Round1 architecture and finance findings rechecked: resolved at design level. No provider account, server quotation, cost benchmark, production migration or recovery result was invented. The updated plan still requires real qualification; source-based feasibility is not an implementation test pass.
