# Scoped lifecycle claim recovery — working increment

Migration161000 and its paired coordinator are applied to local beta after the
verified443 migration prefix. This remains partial T023 work, not complete
generation reconciliation or manual acceptance.

Two failing SQL-backed coordinator regressions reproduced historical executor UUID
reactivation and interruption after a committed claim lost its acknowledgement.
The latter still ran its original finally cleanup: it failed the current request,
not necessarily all future retries. Exact readback now continues the same claim
without another mutation. Missing readback remains unknown and only the captured
scope can send cleanup. Foreign scope replies stop before provider I/O.

Modern execution uses an immutable intent/executor/epoch tuple. The context epoch
is captured once; a claim compares it under the same group and parent locks.
Every modern begin, checkpoint, close and failure callback checks that epoch.
Even a deliberately reused executor UUID cannot let an older callback change a
new owner. Legacy callbacks cannot act on an adopted modern scope. An old claim
cannot reopen a previously used legacy UUID.

An outstanding provider dispatch blocks ownership handoff. When none is issued,
an epoch change fences all future writes from older metadata callbacks before
another owner receives a permit. This is specific to Edge lifecycle work, whose
every PATCH requires the durable begin RPC. It does not prove native process
quiescence and must not replace the separate native restitch ownership contract.
Cancellation and provider admission share group-to-operation lock order. Already
issued exact bookkeeping can finish after cancellation without reviving a parent.

The restricted projection adds current claim protocol and epoch only. Legacy and
absent ownership remain null with explicit blind spots; counters do not recreate
past requests, lost replies or browser delivery. The query also reads older views
without their new columns. No owner tokens, paths, file names or provider payloads
are added to analytics.

Focused combined verification passes170 tests in seven files, with deliberate
equal-timestamp tariff fixtures and existing restitch storage included. The full
type check passes, and changed-file lint passes. All four new actual PostgreSQL races pass. The full disposable gate accepts444
migrations,58 pgTAP files/1292 assertions,2 Auth tests and66 native tests in10
files; frozen native inputs match. See verification-db-material-group-epochs.json.
All counts overlap earlier checkpoints.

The previous full fast run passed8259 tests before an unrelated tariff-test order
assumption failed in shard7. The two queue rows had the correct states but equal
creation timestamps. A forced-tie regression reproduced it; exact two-row set
assertions retain the business checks and all62 tariff tests pass. No product
tariff behavior changed. The subsequent complete fast run passes14/14 gates and all8 shards:9313 passed
tests and89 declared skips. Its source is committed as702e151a; see
verification-material-group-epochs-source.json and
verification-fast-material-group-epochs.json. It excludes the later source-integrity
and historical-refusal increments.

Local beta applies161000 with16 full-row snapshots unchanged and every prior
column of the group table unchanged; only the two new fields gain their legacy
defaults. The owned Edge runtime was stopped before baseline and restored with
the paired coordinator. All6 internal RPCs reject real authenticated REST access
with403/42501 and leave group rows unchanged. Generated public types come from
the actual local schema.

The fresh synthetic provider API cycle confirms hosted bulk trash, restore,
protocol2/epoch1 closed receipts for both operations, and the exact restored44
bytes. The fixture is active again. The first harness stopped after marking an
item because it parsed an empty void response as JSON; its failure evidence is
retained. Continuation read the exact marker and confirmed no provider operation
had started, then continued the same group without repeating that mutation.
See material-group-epochs-beta-api.json and its recovered report. This is API
acceptance, not a manual UI walkthrough.

Still open: historical result versus current material generation, complete partial
companion feedback, delivery diagnostics and manual UI verification. No production
action is authorized by this work.
