# Bulk trash and restore — working increment

Base: `6ca96a5e`. This is implementation evidence, not complete T023/T028/T029
acceptance, a packaged-beta record, or permission to publish.

## Latest verified source checkpoint

Full fast verification now passes all 14 gates: 9168 total tests, 9099 passed
and 69 declared skips; all 8 shards completed. The 68 changed file
hashes match the frozen run. See verification-fast-catalog-workspace.json and
verification-catalog-workspace-source.json. Disposable native proof covers 433
migrations/1163 pgTAP assertions/2 Auth tests/49 concurrency tests. Actual beta
applied only 150000, preserved all 13 protected table snapshots, regenerated
schema types through the canonical compatibility envelope, and passed the
authenticated read-only RPC smoke.

This supersedes earlier full-fast failures below. It is a partial feature
checkpoint: current-generation recovery, complete single-Undo diagnostic
delivery, same-click image recovery wiring, variations/publication, manual UI
and packaged-beta acceptance remain open. No production publication occurred.

## Additional working follow-up: tied pages and retained Undo

The timestamp-only trash cursor skipped the remainder of a batch sharing the
boundary timestamp. A versioned read RPC now compares (trashed_at, id), requires
both cursor fields together, preserves microseconds and keeps the legacy RPC
unchanged. The actual SDK and view forward both fields. Causal SDK/UI tests failed
before correction; SQL regression failed on the absent RPC before implementation.
The focused SDK/view/PGlite checkpoint passed 100 tests, including 60 tied rows
and removal of the boundary row before fetching the remaining ten. The complete
disposable native gate passed 433 migrations, 53 pgTAP files/1163 assertions,
2 Auth tests and 49 native concurrency tests (verification-db-catalog-pagination.json).
Controlled application added only 150000 to the owned beta's exact 432-prefix;
all 13 protected table snapshots matched. Actual schema types were regenerated
using the installed 2.117 CLI. After canonical beta restart, authenticated RPC
acceptance passed for the actual three-row first page, paired next-page cursor,
incomplete-cursor refusal, another-team refusal and anonymous refusal. This was
read-only API acceptance (catalog-trash-pagination-api-smoke.json), not manual UI.

Two causal Undo regressions proved replacement-account dispatch and an unbound
actor on the original call. Undo now retains its originating actor/access epoch
and material/team/client scope, passes expectedActorId through the versioned SDK,
and suppresses late callbacks in a replacement scope. It remains usable after
the deleted row unmounts. Single restore keys persist through lost replies and
remount; only confirmed success retires a key. The 53-test focused checkpoint
covers remount identity and primary/companion owner checks; the earlier related
77-test checkpoint overlaps. Current source also bounds restore acknowledgement
waiting; canonical fast verification is retained above. A further causal regression
proved retired-scope busy state remained stuck; it now resets for the replacement
private epoch/team/material/client. Deadline/late-reply retention and this reset
pass in the overlapping 119-test checkpoint. These counts are not additive.
The additional actual-hook regression removes the row on confirmed trash and
then successfully executes its retained Undo with the original actor; all 36
tests in that file pass. This is controlled UI evidence, not manual beta QA.

This does not close historical-receipt/current-generation reconciliation,
cross-tab provider dispatch authority or partial companion feedback. The existing
workspace restore diagnostics do not yet prove the complete single-Undo visible
result path. Full task acceptance and manual beta remain open.

The causal hook regression reproduced a hosted batch acknowledgement followed
by a failed receipt refresh. The hook threw away the acknowledgement. It now
retains that exact authoritative group with uncertain readback, returns its ID
and starts no file writes until fresh receipts can be read. A missing group in
the refreshed list also retains uncertainty rather than inventing an empty result.

The actual SDK-to-SQL regression reproduced A's pending request creating a group
owned by replacement admin B after session acquisition. The new authenticated-only
`start_team_bulk_trash_as_actor` checks the original actor before delegating to the
existing ACL/idempotency implementation. The tested refusal creates zero groups.
The existing group-owned prepare/mark checks remain intact; they already reject
a replacement account for A's group and are not reported as new proven defects.

Two additional SDK regressions reproduced trash/restore calls using the new token
owner. Current callers use explicit `trash-as-actor`/`restore-as-actor` endpoints;
the Edge guard runs before the mutation handler. Older runtimes cannot silently
ignore an optional field on the legacy endpoint. Legacy paths remain for deployed
clients; current clients have no unbound writer fallback. Full endpoint acceptance
still requires the real beta request path.

A synchronous private-epoch regression reproduced a file write after access
changed during mark acknowledgement, before React cleanup. The hook now fences
each asynchronous boundary, the actual tail callback, read completion, locks and
late feedback. The server group's actor travels with the file write. Team/client/
actor/access changes revoke the old scope. Old analytics actors are fenced too:
the causal producer test originally emitted five events instead of the one
original request; replacement actors no longer inherit later receipt stages.

The manager's causal UI regression could not find an unfinished catalog batch
after reopening. It now discovers hosted receipts by exact current catalog IDs
as well as session-local group IDs, with team binding. Unrelated file groups do
not appear. This controlled UI evidence does not substitute for manual beta QA.

Restore regressions reproduced false success for pending/running/failed/canceled
acknowledgements and a changed request key after a lost reply. The view now checks
the parsed operation result and material identity, keeps the row for unconfirmed
outcomes and preserves an unknown request's key. Only success removes the row.
Failed/canceled receipts remain failures without assuming provider nonexecution.
Current pending identities survive remount in bounded actor/team/action-scoped
browser storage and are retained until confirmed success. Cause-aware retry and
reconciliation of older lifecycle intents remain open; this is not full restore recovery.

Verified focused checkpoints: 21 SDK/SQL and hook tests after group acceptance;
22 after the synchronous scope fence; 42 across SDK, guard, hook and SQL;
31 for workspace actor telemetry and related paths; 65 for the complete manager
UI plus workspace producer; 21 for restore truth and actor-bound SDK. These sets
overlap and must not be added as a unique-test count.

Migrations 145000, 146000 and 147000 passed the complete disposable native replay
and were applied incrementally to the owned loopback beta. Its actual history now
matches all 430 source migrations. No reset or production action occurred.
Computer Use still reports unavailable native pipe and browser hosts; manual UI
acceptance remains open. The full fast verification is also still open (see below).

## Restore diagnostic and pending-identity follow-up

The actual restore UI emits receipt-bound stages and records visible delivery only
after toast commitment. Unknown feedback leaves the operation open. A synthetic
real producer/sanitizer/SQL ingestion path reaches inspect and investigate through
a dedicated SELECT-only role and read-only transactions. Migration 146000 appends
restore states to the existing restricted workspace view and normalizes unknown
legacy reason text to UNKNOWN; other view branches and grants are preserved.
The four-suite diagnostic checkpoint passed 50 tests. Complete native replay
passed 51 pgTAP files with 1145 assertions, 2 Auth tests and 46 native concurrency
tests; exact migration hashes are in verification-db-catalog-workspace.json.
Ten additional checks against the actual beta confirm the new RPC, restricted
projection grants, legacy entry point and preflight refusal provenance.

Two causal regressions demonstrated replacement request identities after closing
and reopening the bulk-trash or restore view with lost acknowledgements. The new
workspace mutation journal persists only bounded opaque request/material IDs,
separates actor/team/action scopes, retains unknown identities without TTL
eviction, rejects overlapping replacement selections, and fails closed when
browser storage cannot preserve identity. Reordered selection reuses the same
canonical payload. The related journal/hook/restore checkpoint passed 49 tests;
the earlier bulk plus full manager checkpoint passed 79 tests. These overlap.

This is not proof of cross-tab atomic acquisition: browser storage is not a server
lease. Existing hosted operation/lifecycle fences remain authoritative. A failed
or canceled DTO alone lacks quiescence evidence for a new provider intent. Full
manual beta/provider acceptance, durable old-intent recovery and the remaining
T023/T029 criteria are still open. Bounded start/prepare/mark/tail/restore waiting
keeps the same request identity, ignores late replies and stops further companion
calls after its local deadline or scope retirement. The related 51-test checkpoint
passed; the SQL refusal-provenance/CLI/hook checkpoint passed 44 tests.

## Native schema, generated types and remaining verification

Only the exact reviewed pending set (145000/146000/147000) was applied using the
verified installed 2.117.0 CLI with --local and the owned Docker socket. The
previous function/view definitions and 13 whole-table digest snapshots are kept
in private local artifacts. Eleven table snapshots matched exactly. Connection
and credential table digests changed during the live-service window; the columns
and cause are unproven, so this does not establish byte preservation of those two
tables or attribute the change to workers. The other protected snapshots,
including auth, settings, materials and credential references, are unchanged.

Native public types were regenerated on the owned beta loopback network. The new
actor-bound RPC signature matched; regeneration also revealed 14 previously
missing existing RPCs and 34 existing signature differences. The generated file
is refreshed, with intentional nullable agent/attempt arguments represented in
the existing database.compat.ts seam. Full project, test and script typechecks
passed after that refresh.

The frozen 40-file fast run passed all static gates but failed four unchanged
Bulk Editor tests during shard 5/8, with durations exceeding their waiting limits
and STACK_TRACE_ERROR in the merged report. It is a partial failed run, not green:
5418 passed, 4 failed, 43 skipped. The exact Bulk Editor file then passed all
17 tests in a separate run without changing its timeouts or the runner. A complete
fast rerun remains required before commit; its three unexecuted shards have no
acceptance result. Later generated-type changes also require fresh verification.

Real actor-bound trash/restore provider API smoke passed on the existing
synthetic CSV fixture after canonical restart: a mismatched expected actor was
refused without a new operation, then exactly two succeeded receipts confirmed
one trash and one restore. The ordinary download grant delivered the original
44 bytes after restoration. Connection/account identity projections matched
through this smoke window only; they do not reconstruct pre-migration identity.
See catalog-workspace-provider-smoke.json. The first byte check incorrectly
expected a share-view URL to serve file bytes; the corrected check uses the
application's real download grant, with no repeated trash/restore request. Shared single-item Undo and companion
truth/scope parity, cross-browser group overlap, legacy uncertain restore recovery
and manual beta QA remain open. No task checkbox is closed by these partial
checkpoints, and neither native replay nor HTTP smoke is manual UI evidence.

## Subsequent native and provider acceptance

The isolated native database gate accepted all 430 migrations: 51 pgTAP files,
1,145 assertions, two Auth checks and 46 native tests. The controlled local beta
then applied only 145000–147000 through the pinned canonical CLI. The retained
verification-db-catalog-workspace.json records tested migration hashes.
Eleven of thirteen whole-table snapshots matched; connection and credential
snapshots changed for an unproved reason. This is not evidence of byte-for-byte
preservation across migration for those two tables.

A real provider/API smoke refused an actor mismatch before mutation, confirmed
one trash and one restore receipt for the existing synthetic CSV, and fetched
its restored 44 bytes through the ordinary browser download grant. Precise
connection/account identity snapshots matched within that provider-smoke window
only. This is not manual UI acceptance. Computer Use still returns no apps or
browsers and reports native-pipe/browser-host failure.

The subsequent canonical fast verification failed four bulk-editor tests with
slow timeout-like symptoms after five shards. The exact unchanged file passed
17 tests on a targeted rerun. No timeout or gate was relaxed; a fresh complete
canonical pass remains mandatory before committing this batch.

## Primary receipt and overlapping acceptance follow-up

Five causal tail regressions demonstrated companion trash after an unconfirmed
primary response. The tail now requires a parsed successful primary receipt;
malformed, pending, running, failed and canceled responses stop before companions.
Four Undo regressions observed the actual wrong Restored toast for non-success
receipts. Single-material and Explorer group Undo now require success, and a
partial group restore no longer falls through to a success toast. The focused
receipt/UI/code-map checkpoint passed 66 tests. These checks do not complete
persistent Undo identity, scope retirement or companion partial-result recovery.

The disposable PostgreSQL regression then reproduced five replacement-group
bypasses: identical queued material, selected parent, selected child, uncertain
historical terminal and extra accepted groups. Migration 149000 serializes team
acceptance across actor/group identities and rejects overlap with unresolved
items, folder descendants and retained lifecycle snapshots. Original same-key
readback remains available. A confirmed successful old item does not permanently
block a restored active file. The original actor-bound wrapper and ACLs remain.

Native acceptance passed all 432 migrations, 52 pgTAP files with 1154 assertions,
two Auth tests and 49 native tests across ten files. Three actual concurrent
transaction scenarios verify different-group exclusion, same-key replay and a
cross-actor parent/child race. Exact tested migration hashes are retained in
verification-db-catalog-overlap.json. The owned beta is still on migration 147000
until separate controlled incremental application. Full fast and manual UI
acceptance remain open; no task checkbox or production readiness is implied.

## Actual beta acceptance after 148000–149000

The owned loopback beta applied exactly the two proved pending migrations through
the pinned local CLI, without reset. Its complete history matches 432 migrations.
Eleven protected whole-table snapshots matched; the connection and credential
whole-table hashes changed for an unproved reason, so their contents are not
claimed unchanged across migration. Separate precise identity projections match
within the provider-smoke window only.

The new actual authenticated RPC/provider smoke accepted one group, replayed that
same group identity, refused a competing group without creating it, prepared and
marked the original item, confirmed trash in its hosted group, restored the file,
resolved its URL and downloaded the original 44 bytes. Exactly two successful
file-operation receipts belong to this new smoke. No new sharing permission,
fixture creation or production write occurred. Public evidence is retained in
catalog-overlap-provider-smoke.json and catalog-overlap-connection-identity.json.

This acceptance found an initialization cycle introduced by the new budget
module. Direct leaf imports in the real Edge runtime read the selection bound
before initialization; the bundled test importer had hidden the cycle. The fresh
compiled ESM regression failed for the same reason. Moving the unchanged limits
to dependency-free restitch-screen-policy.ts removes the cycle while preserving
existing exports. Three fresh-runtime imports, 24 coordinator cases, nine budget
cases and 19 diagnostic-map checks pass (55 focused tests).

The first file request could not boot its executor. The fixture stayed active
and no matching operation existed. Recovery preserved its original group/key,
removed the failed runtime through canonical beta shutdown, checked the corrected
executor with the early wrong-actor guard, and confirmed zero operations after
restart. Only that proved nonexecution allowed one dispatch with the same retained
key; it did not create a fresh intent or blindly replay an unknown provider write.
An earlier empty-body mark response was a QA-harness parsing error and was
recovered through hosted marker readback, without repeating the write.

This is actual beta API/provider acceptance, not manual browser acceptance or
completion of T023/T028/T029. Persistent single-action Undo identity, scope and
partial companion recovery remain open. Full canonical fast verification is
still required for the complete working batch before committing.
