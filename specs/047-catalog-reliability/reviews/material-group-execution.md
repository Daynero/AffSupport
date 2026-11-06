# Material-group execution — working increment

This increment remains uncommitted and is not full feature or beta acceptance.
The actual SQL intent and shared provider coordinator reproduced two independent
faults: two same-key callers dispatched PATCH before either checkpoint; after
adding dispatch ownership, the rejected second caller could still mark the active
parent failed. Both causal failures are retained locally. The repaired boundary
passed 37 targeted tests before the latest SQL and diagnostic-reader additions.

The forward migration adds nullable execution metadata to the existing intent,
not another queue. Historical rows remain unknown. A managed immutable operation
nonce identifies new executors; an old writer cannot reuse it with its legacy
nonce. A service-only claim and per-member reservation precede provider PATCH.
Only that invocation can confirm its held member or positively attest that its
own provider call never began. Lost provider replies retain the reservation;
time does not renew permission. A known provider response can reconcile a lost
checkpoint reply without another PATCH. Contradictory provider metadata remains
unconfirmed. Managed completion requires all members and no pending dispatch.
The old checkpoint refuses managed intents. Current actor rights are rechecked
before dispatch. Existing same-primary uniqueness is retained; the new team lock
also serializes distinct primaries with overlapping frozen members.

An unowned or malformed claim returns GROUP_RECONCILING with a closed safe cause.
The parent failure boundary preserves GROUP_RECONCILING and
PROCESS_RESULT_UNCERTAIN; definite failures still use the existing terminal path.
The privacy-limited diagnostic view and SELECT-only CLI explain reservations and
confirmed counts even without browser events. Reservation is not proof of actual
provider execution, confirmation is not whole-group registration, and neither
proves browser delivery. Missing projections, malformed rows, current-state
cutoffs, unknown codes and truncation remain explicit blind spots.

Native replay, controlled local-beta migration, actual provider acceptance,
complete canonical verification and manual UI acceptance are still pending for
this increment. Full current-generation Undo receipts and complete partial-group
entry-point recovery remain separate open work. No production changes occurred.

The complete disposable gate passed: 434 migrations, 54 pgTAP files /1193
assertions, 2 real-Auth tests and 52 native tests across 10 files. Exact migration
hashes are retained in verification-db-material-execution.json. The three added
native races cover independent claim owners, held-member reservation and shared
members across different primary sources.

Local beta applied only 151000 after stopping its owned Edge instance. Exact
history is 434 and old intent execution fields remain null. Twelve of fourteen
protected table snapshots matched. The connection and credential digests changed
with reconciliation/sync/last-used timestamps inside that window. Earlier
connection/principal/root identity hashes still match, but field-by-field prior
mutable values were not captured; full preservation of those two rows remains
unproven. The mismatch and original baseline were retained, not replaced or
reported as an all-table pass. See material-execution-beta-migration.json.

Actual source-beta API acceptance caught a new regression in this working
increment: Supabase RPC builders are lazy thenables without Promise.catch.
The first CSV trash had already acknowledged its provider member, but the new
finally block threw before closing its executor. This is our new beta defect,
not a historical explanation for Ruslan. The failure and original request key
remain retained. A real SDK/custom-fetch-to-SQL regression reproduces both the
normal and failing-provider branches; both now pass after awaiting the builder
inside try/catch. The 27-test focused run passed. No unknown provider write was
repeated to recover this failure.

The next forward migration, 152000, reconciles only an active, fully confirmed
managed group's database completion. The new route uses the same accepted
operation before fresh metadata preflight, avoiding a second provider PATCH.
Current actor/source/action/destination bindings, pending placement/lifecycle
and cancellation remain authoritative. Terminal receipts are refused rather
than interpreted as a new-generation success. Partial unacknowledged groups,
old terminal replay DTOs and complete generation recovery remain open. The
causal missing-function regression and then 43 focused tests pass; full native
435-chain replay and actual beta recovery are not yet complete.

The 435-chain proof passed completely: 55 pgTAP files /1205 assertions, 2 Auth
and 53 native tests. It is retained separately and 152000 is still unapplied.
A further causal SQL/helper regression then showed that the legacy failure
marker could change a successfully registered material back to reconciling.
The next additive153000 binds managed failure reporting to the current open
executor and refuses completed/replaced/closed owners before touching material
or parent rows. Active legacy diagnostics remain supported. Verified registration
also closes its finished marker atomically after all acknowledgements; no unknown
provider dispatch is cleared. The 40-test focused checkpoint passes; the last
additional closure assertion and new native races remain covered by subsequent
verification, not retroactively included in that count.

A source-wide syntax inventory found two other rpc(...).catch calls in the
updater, but both receive a real Promise from an async rpcValue wrapper. They
are not instances of the confirmed SDK defect and were left unchanged. The
shared raw RPC interface now uses PromiseLike; the actual SDK regression no
longer casts its client to a Promise-shaped mock type. Current typechecking
and complete canonical verification remain required.

The subsequent complete 436-chain proof passes: 56 pgTAP files /1214 assertions,
2 Auth and 54 native tests. Exact frozen SQL and test hashes are retained in
verification-db-material-late-failure.json. The added native case proves a late
owned failure waits for registration and then leaves placement ready and parent
succeeded. Source beta applied only152000/153000 after its owned Edge instance
was stopped before baseline capture. All14 full-row snapshots, including every
stored group field, matched; exact history is436. This is a new bounded window,
not a replacement for the earlier151000 mutable-row exceptions. See
material-completion-beta-migration.json. Actual provider recovery and full fast
verification still remain pending for the current source.

The next actual API call refused before completion with PERMISSION_DENIED.
Readback showed the original operation/group still running with all members
acknowledged and no pending dispatch, while the material was already trashed
and retained its moving placement. Current view/delete/edit rights and identity
bindings matched. The original active-only context returned zero rows; the
same authorized context with allowTrashed returned one. This proves the entry
boundary omitted an already observed target; the exact independent writer of
that observation is not reconstructed from current rows.

Forward154000 permits active/trashed observations only under the existing
managed pending marker and all completion/cancellation/identity fences. The
entry context can read the authorized trashed target; fresh writes retain live
provider preflight. An actual SQL/helper regression reproduced the refusal;
22 focused tests pass, including both trash and restore observations. Current
test typechecking passes with the raw PromiseLike interface inherited directly
by both Edge clients. The full437-chain native gate is in progress. Source beta
remains436;154000 is not yet applied. The original request flags remain retained.
A separate once-only known-refusal proof may authorize the same-key completion
call only after validated154000 application and replacement of the old runtime.

The complete437-chain proof passes: 57 pgTAP files /1220 assertions, 2 real-Auth
and55 native tests, including observation committed while completion waits for
the material row. Exact SQL/test hashes are in verification-db-material-observed.json.
Source beta applied only154000 after quiescence; all14 full-row snapshots matched
and history is437 (material-observed-beta-migration.json).

Actual local API/provider recovery now passes with the original trash key and
operation. The once-only known context refusal was retained and consumed only
after the old runtime stopped and154000 was installed. The hosted trash receipt
confirmed; the originally prepared restore key succeeded through the normal
provider path; the link was available and44 received CSV bytes matched exactly.
Both managed file receipts are succeeded, closed and have no pending member.
No unknown provider write was repeated, no direct SQL completion was committed,
and the unrelated held catalog was not retried. See
material-execution-provider-recovery.json. These new beta defects are distinct
from Ruslan's unproven historical causes. This is API acceptance, not browser
manual QA, disk-save telemetry, packaged beta or complete feature acceptance.
Full canonical fast verification of the current source remains pending.

The complete fast source checkpoint now passes all14 gates and all8 suite shards: 9121 passed, 75 declared skips, zero failures. Exact30-file hashes and unchanged437 migration/68 native-test inputs are retained in verification-material-execution-source.json; canonical output is verification-fast-material-execution.json. The first full run exposed an optional material-group projection incorrectly treated as core analytics schema. The corrected CLI preserves scoped unavailable evidence without invalidating older core schemas;81 targeted tests and the fresh full run pass. Earlier failed output remains retained locally. Actual API/provider acceptance above remains separate from blocked manual UI and packaged acceptance. T023 stays open for generation and complete partial-group recovery.
