# Manual-root admission and stable image identities — source work

Running beta now has schema 443. The four follow-ups 157000–160000 passed the
complete disposable native gate: 58 pgTAP files / 1284 assertions, 2 real Auth tests
and 62 native concurrency tests. All 443 migration and 69 native input hashes
match. Local beta applied only those four migrations in a quiesced window; all
17 full-row snapshots matched and the new private stores remain empty. Edge was
restored. Actual authenticated REST refuses all 12 internal RPCs with 403/42501.
See verification-db-restitch-owned-executor.json, restitch-owned-beta-migration.json
and restitch-owned-beta-refusal.json. The complete fast suite remains pending;
no user route, installed capability or native controller is enabled.

The internal factory admits a kind=download operation, frozen recipe, source
content binding, actor/pool namespace and candidate snapshots in one transaction.
The local display UUID is a separate identity in the request nonce and recipe.
A same-key replay reads the original acceptance before looking at later defaults.
An existing operation without its original root is missing accounting, not an
opportunity to initialize another budget. A per-key transaction lock serializes
concurrent acceptance; native concurrency proof is still required.

Stable opaque image versions distinguish actual connection/file identity as well
as checksum/MIME/size. Renames and metadata-only version updates preserve the
handle. Changed content and independent copies have distinct handles. The actual
schema permits one active connection per team and one material per provider file;
connection tests therefore exercise detach/reconnect and rebinding, rather than
an impossible pair of simultaneous active connections.

The actor-private namespace hashes semantic settings and declared sources, without
resave timestamps, editor identity, random seed or the sampled final duration.
This preserves refusal hints across ordinary clicks while keeping actors separate.
Candidate snapshots do not deduplicate identical checksums: a forbidden copy must
not hide an independently accessible file. Missing metadata and unresolved sources
remain unknown. The 501st eligible image, 5001st observed image or 5001st folder makes
coverage explicitly incomplete. Recursive folder consumption is materialized and
bounded, rather than enumerating an entire large tree to claim exhaustion.

Final duration is sampled once under the existing shared renderer policy and
stored as a custom duration. SQL/shared comparisons cover all five modes at
boundary and midpoint draws, including centered windows and the one-hour clamp.
The factory uses PostgreSQL's native SHA256 for the namespace. The generic PGlite
fixture's pgcrypto stub returns 16 bytes even when asked for SHA256; the production
32-byte constraint was retained and the native hash is exercised instead.

For this new manual-download protocol only, source identity is the frozen
connection/file/checksum/MIME/size tuple. A metadata-only video version change
passes; changed bytes stop the reservation before upstream I/O. Legacy/manual
process-source contracts keep their existing version policy. This is not an
unreviewed relaxation of process finalize or upload ownership.

The service adapter captures request identity before awaits and strictly parses
receipt scope, sampled defaults, observations and content binding. A lost or
malformed acceptance reply invokes only exact readback. Missing or failed
readback remains uncertain. Invalid settings use the existing transport code
RESTITCH_INVALID; no unchecked new error is cast into the closed contract.
Disabled screen slots are projected explicitly rather than appearing stuck.

The earlier focused checkpoint passed 147 tests across 8 files before the
traversal, missing-root and owned-executor increments. Counts from overlapping
checkpoints must not be added. The latest scoped run below passes 145 tests;
complete current-source static checks and the full fast suite remain pending.
The earlier type check exposed the unsupported RESTITCH_DEFAULTS_INVALID code;
that mismatch was corrected to RESTITCH_INVALID and the type check passed.

Deletion now refuses held ranges and active accepted recipes, including account
cascades. Exact late settlement remains available after cancellation. Protocol1
roots conservatively remain retained even if a parent is marked terminal: an
owned-executor quiescence/retirement proof is not implemented yet. That fence must
be completed alongside the executor lifecycle before enabling a product producer.

Still open: native ownership controller and observed quiescence, dedicated range/control grants,
current authenticated actor and session binding, server selection/refusal adapters,
manual native integration, updater/Launch logical aliases, complete diagnostic
production and real beta/manual acceptance. This work does not close T016–T020.

Owned executor storage (160000) now fences protocol 1 actions with the original
executor ID and monotonic epoch under the same parent lock as reservation CAS.
Unrestricted reads and exact late settlement remain bookkeeping only. Every
action, including an idempotent no-op, performs a current authority read. Historical
claims cannot reactivate or close a newer epoch. A missing executor row remains
unknown. There is no timeout-based takeover. The internal quiescence RPC requires
trusted server invocation after native requests and children have stopped; that
controller is not wired and the conservative deletion fence remains in place.

A focused run passes 145 tests in eight files, including deferred credentials,
mutable owner inputs, stale claims and late settlement after cancellation. The
full type check passes. The first disposable run passed 61 of 62 native cases; the remaining fixture
lacked an image extension and was correctly excluded. The corrected fixture
passes the fresh full native run, including all three new ownership races. These primitives
do not prove an installed native executor, a rendered video or user delivery.

Lost claim acknowledgements now use only the exact read-only claim receipt. The
claim adapter captures actor, claim, native instance and actual installed contract
before awaits; malformed or missing readback remains uncertain. This has mock
regressions and a real SQL receipt assertion in the native concurrency suite.
