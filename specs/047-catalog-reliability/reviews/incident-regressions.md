# Historical incidents and regression boundaries

The read-only historical CLI extract is `incident-cli-asof-20261105.json`.
Inspection is pinned to 2026-11-05T15:00:00Z and the journal window to
2026-11-05T11:47:00Z. These are historical observations, not post-fix results.

Both reported native operations ended with `RESTITCH_SCREEN_FETCH_FAILED` at
image preparation. The journal supplies only `transfer_failed`: it cannot identify
the selected file, effective historical restitch settings, HTTP cause, or whether
both attempts selected the same image. The browser delivery stage is unobserved.
The report does not establish a server-wide outage or a corrupt-image cause.

Existing causal regressions are reused rather than duplicated in a new umbrella
test file:

| Audit finding                           | Regression seam                                                                                                                                    | What remains unproven                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F01 missing manager file-action context | `catalog-diagnostics-ingestion.test.ts`, `material-link-diagnostics.test.ts`, `material-share-link.test.tsx`                                       | Real manager and Explorer clipboard walkthroughs; the original complaint's exact provider cause      |
| F05 silently discarded malformed rows   | `catalog-profile-outcome-api.test.ts`, partial-manager cases in `catalog-updater-dialog.test.tsx`                                                  | Original user's historical payload was not captured                                                  |
| F06 guessed counts and Stop result      | `catalog-profile-outcome-api.test.ts`, `catalog-command-api.test.ts`, `catalog-command-coordinator.test.ts`, Stop UI and SQL-ingestion regressions | Manual new Stop acceptance and provider quiescence; an inactive target does not prove Stop caused it |
| F09 partial trash abort                 | `catalog-updater-dialog.test.tsx` preserves failed/unstarted selection and refreshes after success A / unknown B / unstarted C                     | Full hosted receipt, Undo, running/reference protection and actor acceptance matrix in T023/T030     |
| Native terminal lost behind reservation | `analytics-team-process-journal.test.ts` uses both incident operation IDs, late/conflicting/missing browser evidence                               | Underlying image transfer cause and browser receipt remain unknown                                   |

Source checks distinguish the proven code defects from attribution of historical
user complaints. Fresh source verification is recorded separately; the remaining
manual/provider and fault-matrix boundaries are not satisfied by these tests.
T003 investigation/reproduction is reconciled in incident-reconciliation.md: every complaint has a proved source regression or an explicit historical blind spot. This closes the analysis boundary only. Actual remediation, new diagnostic coverage and manual/provider acceptance remain in their respective tasks. The fresh complete source suite is verification-fast-material-execution.json.
