# Durable launches and owner UI follow-up

This evidence supersedes the browser-local queue limitation recorded for commits
`49ade050` and `58172104`. Work remains in `AffSupport-053`, branch
`053-bulk-launches`. No production migrations, provider writes, release packaging
or deployments were performed. Native tests use isolated application profiles;
database acceptance uses the canonical disposable PostgreSQL runner.

## Implemented behavior

- Atomic durable batch membership, per-child pending admission and independent
  bounded retries. Lost replies replay the same keys; re-entry reads the server
  receipt. Cancellation and delayed results retain their authority fences.
- Automatic native background enrollment replaces the optional setting. Existing
  disabled settings, concurrent tabs, restarted native ownership, lost confirmation,
  cooldowns and revoked authority are covered by focused regressions.
- Stable launch cards, explicit copy/paste names, offer/social/RK/status captions,
  progressive results and a persisted attempt clock.
- Compact desktop settings with one creative picker/drop field and selected
  preview. The duration slider opens on demand with its selected
  time always visible, and R2 remains in the main settings row.
- Neutral notes until copied. Canonical catalog rename from results and manager,
  immutable bound names/URLs, searchable historical aliases, and a smaller warning
  explaining that the old name remains visible below the new name.
- Typed, bounded batch/setup/rename diagnostics through ingestion and the read-only
  CLI. Missing delivery and historical state remain explicitly unknown.

## Focused and visual evidence

Root and delegated focused runs are recorded in `owner-follow-up-analysis.md`.
The final compact-settings/editor run passed 112 cases across six files; the final built-asset budget run passed
all four checks. The final cleanup-fence follow-up passed 20 canonical rename cases
and 22 durable batch storage/catalog cases. The final provider-floor pass covered
84 cases across eight files, including persistent cooldowns for both catalog and
non-catalog children and stale-claim fencing. No new dependency was added.

Thirteen desktop screenshots use actual source components with synthetic data at
1280px in local Chromium. All views report no browser errors and no horizontal
overflow. The gallery includes dark/light settings, expanded/collapsed duration,
creative selection, per-launch/batch progress, rename confirmation/result/manager,
neutral/copied notes and list selection. R2 visibility outside collapsed advanced
settings is asserted. Earlier resize acceptance also exercises card geometry and
status changes at ten widths; no mobile screenshots are included in delivery.
The compact form also passed five desktop widths in both themes, including long
creative names, expanded controls, and keyboard access to all 100 manual budgets.
Dimensions, browser outcomes and screenshot hashes are retained in
`desktop-follow-up-verification.json`.

The files are in `~/Downloads/Soty-mass-launches-UI-2026-11-13/desktop.html` and
`~/Downloads/Soty-mass-launches-desktop-2026-11-13.zip`. These are component fixtures,
not a claim of live Google or authenticated production end-to-end acceptance.

## Current fault coverage

The older browser-local matrix in `resilience.md` is historical. The durable
follow-up exercises these boundaries through the real hooks, SQL/Edge handlers,
native enrollment/worker seams and deterministic provider responses:

| Boundary | Required result | Regression files in `tests/` |
|---|---|---|
| Acceptance committed, reply lost, browser closed | Recover the same batch from protected readback; no new child identities | `launch-batch-resilience`, `launch-durable-batch-storage` |
| Missing receipt, hung server, stale response | Bound the read, keep original intent, continue observation; never regress confirmed progress | `launch-batch-resilience` |
| One source deleted or selected version edited | Refuse that member; preserve and finish independent members | `launch-durable-batch-storage`, `launch-durable-batch-catalog` |
| Preparation temporarily unavailable or setup absent | Persist pending admission and admit the same selected version when ready | `launch-durable-batch-storage`, `launch-durable-batch-catalog` |
| Cancel while preparing; delayed admission | Durable cancellation fences the late reply | `launch-durable-batch-storage` |
| Cancel archived child or unknown created catalog | Cancel independent siblings, retain uncertain output and cleanup evidence | `launch-durable-batch-storage`, `launch-durable-batch-catalog` |
| Two cancellations in cooldown | A third due cancellation still progresses | `launch-batch-resilience` |
| Oldest video set is uncertain | Pace that set so independent sets receive claims | `launch-durable-batch-catalog` |
| Native restart or crashed admission worker | Adopt only eligible quiescent ownership; reject expired owners and consumed grants | `launch-durable-batch-catalog`, `launch-durable-batch-storage` |
| Actor replacement, same actor signs back in, permission loss | Obsolete callbacks cannot submit or deliver private results | `launch-batch-resilience`, `recovery-automatic-setup`, `catalog-rename-ui` |
| Two tabs, lost setup confirmation, old disabled setting | Coalesce enrollment and confirm the same credential; do not replace live or revoked ownership | `recovery-browser-ownership`, `team-recovery-delegation`, `team-recovery-worker` |
| Google 403 rate limit, 429, 5xx or timeout | Retry only safe reads within bounds; honor numeric/HTTP-date Retry-After; retain durable longer waits | `drive-transient-retry`, `acceptance-fault-provider`, `catalog-rename-drive` |
| Rename reply lost or server closes before dispatch | Read back or resume the same durable intent; no blind repeated PATCH | `catalog-canonical-rename`, `catalog-rename-ui` |
| Rename command absent, original POST arrives late | Absence tombstone rejects the late submission before unlocking the UI | `catalog-canonical-rename`, `catalog-rename-ui` |
| Concurrent provider rename, permission loss/return | Preserve original ETag; never overwrite a changed source; reconcile proven success | `catalog-canonical-rename` |
| Generation/attachment or cleanup races rename | Shared row/reference guards serialize authority and reject late consumers | `catalog-canonical-rename`, native `launch-durable-batches.test.sql` |
| Bound SUB/link names and search | Keep immutable URL/name bytes; canonical projections and authorized alias search update | `catalog-canonical-rename`, `catalog-rename-ui` |
| Missing telemetry or historical projection | Read safe authoritative receipts; report missing history/delivery explicitly | `launch-durable-batch-storage`, `catalog-rename-analytics`, `background-setup-analytics` |
| Stage transition, reconnect, pending replay | Retain elapsed time for the same attempt; reset only on a new attempt | `launch-elapsed` |
| Shared producer deleted/canceled | Surviving verified consumers continue; in-use cache entries remain protected | `restitch-multi-variation-reuse`, `restitch-native-source-authority` |

## Aggregate acceptance

Final `SOTY_VERIFY_SERIAL=1 nice -n 15 npm run verify` passes all 15 gates in
1,700 seconds. All eight shards completed: 11,165 assertions passed, zero failed,
and 95 declared environment/platform cases were skipped (11,260 total). The
verbatim result and skip reasons are in `owner-follow-up-verification-final.json`.
This complete successful command supersedes the partial/failed attempts; it does
not combine partial shards or omit failing tests. The unchanged release-controller
wait regression passes in 260 ms on the normal temporary filesystem. The catalog
manager regression now awaits its passive ownership effect with unchanged
assertions and timeout. The 66-case focused manager run also passes.

The fast command does not measure global coverage. Focused V8 evidence for both
new critical contracts is in `contract-coverage.json`; the existing coverage
floors are unchanged and both new modules meet their 90% line floor.

The corrected native PostgreSQL gate
passes all 74 SQL files / 1,481 assertions, three Auth tests and 81 native
integration tests. The disposable test containers were removed by the runner.
The first native run replayed the full migration chain but failed twelve existing
cleanup-coverage assertions. Its fail-closed behavior retained files; the seven
new consumers now use the existing reference guard. The new focused regression
proves a claimed task file cannot acquire rename/absence/alias records afterward.
Two native delegation fixtures were updated to include protocol version 2, matching
the real Edge transport. An intermittent existing catalog ownership fixture now
uses an unambiguously overdue job; all 1,005 identity/attempt assertions remain.
The failed runs and their corrections are described in `owner-follow-up-analysis.md`.

The final web build passes. Exact compressed graph sizes and explicit allocation
are in `performance.md` and `bundle-budget-comparison.json`.

## Runtime limits

Provider faults are deterministic fakes. Native PostgreSQL tests establish real
schema/role/trigger behavior; PGlite logical tests do not establish multi-session
MVCC or external service availability. Packaged native runtime, real OAuth/Google,
physical Windows/Intel and release promotion remain separate release acceptance.
Unknown provider writes stay pending until authoritative readback is possible;
healthy siblings continue. No test substitutes a timeout for proof of failure.
