# US3 interruption and cancellation — recorded results

Recorded 2026-09-12. Suites run serially on the development host
(MacBookAir10,1, 16 GiB, macOS 26.6.2), single vitest worker.

`npx vitest run tests/release-runner-recovery.test.ts
tests/release-runner-effects.test.ts tests/release-runner-cancel.test.ts
tests/release-runner-cleanup.test.ts tests/release-runner-supervisor.test.ts` —
19 passed, 0 failed.

## Per-boundary effect counts

The crash matrix interrupts the release immediately after each of the fifteen
registry steps in turn, resumes from what the journal vouches for, and counts
how many times every effect actually ran. The interesting case is deliberately
the hard one: the effect has already landed when the run stops.

| Crash after          | Effects that ran more than once |
| -------------------- | ------------------------------- |
| preflight            | none                            |
| prepare              | none                            |
| candidate_gate       | none                            |
| beta_package         | none                            |
| beta_verify          | none                            |
| backend_beta         | none                            |
| readiness            | none                            |
| macos_package        | none                            |
| windows_smoke        | none                            |
| publish              | none                            |
| manifest             | none                            |
| manifest_beta_verify | none                            |
| backend_apply        | none                            |
| deploy               | none                            |
| live_verify          | none                            |

Every cell of the 15 × 15 table is exactly 1: each of the fifteen steps ran once
across the interrupted run plus its resume, for all fifteen crash points. A
resume also refuses to skip a step it has no record of — a run resumed with only
`preflight` and `prepare` recorded re-runs every remaining step rather than
assuming later ones happened.

## Defects found and fixed while recording this

| Defect                                                    | Effect                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release-worker.mjs` only wrote its ready file and exited | An accepted release did nothing, forever. The journal, lease server, flow, diagnostics and handoff existed and were tested, but no code path assembled them. The worker now runs the flow, journals before each effect, recovers from the journal, and blocks with one handoff on failure. |
| `journal.mjs` and `store.mjs` both wrote `snapshot.json`  | Two shapes at one path, each overwriting the other. The CLI and cleanup read the store's shape, so the journal's checkpoint corrupted the run state they read. The journal writes `journal-state.json` now.                                                                                |
| `recoverJournal` threw `ENOENT` on a first run            | A run with no journal yet could not start. A missing journal is now an empty one; interior damage and a torn tail are still refused.                                                                                                                                                       |
| `startLeaseServer` accepted an over-long socket path      | Beyond the 104-byte `sun_path` limit `listen` appears to succeed, no socket is created, and the next call fails with a bare `ENOENT`. It now fails with `LEASE_SOCKET_PATH_TOO_LONG` naming the path and the limit.                                                                        |
| `pathToFileURL(process.argv[1])` in the entry guard       | Importing the worker or runner from a context without `argv[1]` crashed on import.                                                                                                                                                                                                         |

## Scenario results

| Scenario                                                                  | Result |
| ------------------------------------------------------------------------- | ------ |
| Interrupted work reconciled before retry                                  | pass   |
| Deterministic and expired effects not retried                             | pass   |
| Torn journal tail distinguished from interior tampering                   | pass   |
| Ambiguous dispatch / upload / push / deploy / migration outcomes block    | pass   |
| Retry permitted only after proven absence                                 | pass   |
| Remote effect matched only by exact correlation evidence                  | pass   |
| Cancellation persisted without deleting assets or rolling back a database | pass   |
| Cleanup removes only aged, completed, owned runs                          | pass   |
| The worker runs every step and journals each before its effect            | pass   |
| A failure becomes one bounded, redacted handoff and blocks the run        | pass   |
| A resumed worker does not repeat effects the journal already recorded     | pass   |
| A worker with no configured step adapter refuses to look finished         | pass   |

## Still open

The restart-worker and live-child ownership integration is exercised here through
the supervisor and ownership modules and through the lease server's worker-death
path (`validation/resources.md`). The same matrix against **real** adapters —
actual GitHub dispatch, upload, deploy and migration — is T062 and remains open
for the reason recorded in `validation/blockers.md`: no sandbox credentials or
remote targets are configured for this host. Fixture counts are not presented
here as a substitute for that.
