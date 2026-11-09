# Actor-bound catalog mutations — working increment

This is partial T028 evidence, not completion or beta promotion.

The regression uses the actual SDK, a delayed session-refresh boundary and real
PGlite functions from the repository migration chain. Both fixture users are
administrators with process permission. Before the fix, seven cases applied A's
intent as B after the session switched: profile, observed Stop and all five space
default setters. The positive intended-actor case passed. The corrected actor-bound
RPCs make all eight cases pass and retain the original functions' membership,
version, observed-round and provider reconciliation checks.

The additive migration 20261207143000 creates authenticated-only wrappers and one
closed Stop error code. New clients refuse an unobserved Stop before dispatch;
there is no legacy writer fallback. Malformed default booleans now fail explicitly.
SDK/contract/code-map focused verification: 114 tests passed. The first native pass replayed all 426 migrations and passed 1074 pgTAP
assertions, 2 real-Auth checks and 46 native tests. The final pass also passed 42 explicit native RPC ACL/actor assertions: 48
pgTAP files, 1116 assertions, 2 real-Auth checks and 46 native tests. Exact
migration hashes are in verification-db-catalog-actor.json. Complete source verification subsequently passed: 14/14 gates, 9034 tests
passed, 66 explicit skips, 1445 seconds. All 25 implementation-file hashes
remained unchanged during the run; see verification-fast-catalog-actor.json.

The UI increment binds retained callbacks and delayed Undo to actor/access epoch,
team, client and mounted scope; Stops share existing synchronous locks with Run and
Retry. Defaults retain partial successes, have bounded reads/writes and suppress
old readback and completion after a scope change. The repeated focused run passed 219 tests in nine files, including retained
inline callbacks, StrictMode effect restart, legacy Stop refusal and delayed
default completion after an actor switch. Full typecheck passed. Seven RPC
contracts were generated from the disposable native database; the intentional
nullable observed-attempt argument is retained as a documented SDK refinement. Existing older full verification records
do not cover these working changes. No production data or migrations were changed.

The proved migration was applied only to local beta (425 → 426). Its history
matches all migration versions exactly. All 13 protected table count/digest
snapshots matched before and after this apply. No beta reset, production write,
version change or release action occurred. The source implementation snapshot
remained unchanged during final database verification. The complete fast verify passed as recorded above; manual beta acceptance
remains blocked by unavailable Computer Use hosts.

T028 remains open: the remaining client-replacement reset and complete navigation/
manual acceptance matrix must still be checked. Stop-specific diagnostic lifecycle
and target correlation are separate open T029 work, not covered by the sharing
lifecycle. This checkpoint does not claim all feature tasks completed.
