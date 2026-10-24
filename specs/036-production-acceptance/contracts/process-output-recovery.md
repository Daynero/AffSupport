# T139 — durable ownership of process uploads

Status: implementation and acceptance in progress. Agent checksum, protected generic Edge
start/finalize, v2 recovery worker, scheduler and reservation diagnostics are implemented.
The first four ownership migrations (through350) passed isolated PostgreSQL and were applied
only to local acceptance036 without reset; real auth, Drive connection and connected root
were preserved. Official beta:down/up rebuilt the agent and loaded the new Edge entrypoints.
Actual provider success with the captured ID and upgraded-producer enforcement passed.

The first protected in-flight cancellation reproduced the original race and correctly refused
revoked finalization. Scheduled cleanup ran at the existing **one-minute** catalog-updater
cadence, then retained the output as registered material. This exposed T145: incremental replay
still called the legacy three-argument catalog upsert, bypassing the snapshot-only filter.
The registered fixture remains preserved as evidence. Do not relabel it as safely deletable.

Forward migration351 protects baseline and incremental ingestion, including first-capture races
via the shared per-ID tuple lock and a scoped ingestion marker. Replay counters count accepted
materials. The CLI gains content-free registration/result booleans to explain a reference fence.
The corrected351 chain passed869pgTAP/34files and9native cases (including four actual
concurrency races). Test/script typechecks and targeted lint passed. Applied only351 locally
without reset; connection/auth were preserved. A fresh real final-PUT/cancel race then passed
automatic scheduled cleanup in one attempt, revoked finalize refusal and canceled/null result.
Independent v2 metadata readback confirmed the exact ID, nonce, checksum, parent and trashed=true.
CLI confirmed no material/result registration and explained why the earlier registered fixture
remains retained. T148 proves restart cleanup; T149 proves renamed/moved preservation. Remaining adversarial scope, literal UI last-upload Stop and final canonical acceptance remain open.

The controlled real-provider reproduction is in
`drive-followup/midflight-inflight-race.json`: the final PUT started before cancellation,
Google committed after cancellation, and the revoked finalize ticket correctly refused publication.
The provider file nevertheless remained. Settling a local fetch promise is not proof that Google
has stopped processing its request.

## Required behavior

- Allocate one provider-generated file ID for each new process output, then persist its binding
  before opening the resumable session. A retry reuses that exact identity. Never change a
  conflicting create into PATCH, allocate a replacement after an uncertain write, or identify
  a cleanup target by its name or marker alone.
- Bind operation, team, actor, credential, destination, new file ID, private nonce, MIME type,
  size and expected content checksum. The agent computes MD5 with bounded streaming reads and
  cancellation before upload. A protected upload request missing the required producer evidence
  returns the existing `AGENT_UPDATE_REQUIRED` code before any provider write.
- Preserve the separate overwrite path. Existing source IDs, version targets and original files
  are never eligible for new-output cleanup. Reject a new-file ID combined with an overwrite ID.
- Cancel continues to revoke business grants. A narrow service cleanup lease may only reconcile
  the recorded new output; it cannot finalize, read arbitrary material, or authorize another file.
- Hide recorded unpublished outputs from catalog ingestion. Successful finalization publishes
  its material atomically with the operation outcome. Indexing must not expose canceled or
  incomplete output and allow it to acquire task/catalog/source references before publication.
  An already registered material defeats cleanup, including a separate explicit adoption; its
  ordinary catalog readback continues. Snapshot conflict protection remains unchanged.
- Reconcile by exact ID, current parent, nonce, size/checksum and ownership/capability proof.
  Recheck a database fence immediately before reversible trash and on settlement. Never trash a
  published/referenced result, an identity mismatch, a moved or modified file, or an original.
- A 404 while an upload may still finish is pending, not proof of absence. Persist retry state
  across agent/browser/server restarts. Use finite attempts and backoff; exhaustion or missing
  evidence becomes explicit attention/unknown, never `cleaned`. A successful trash readback is
  positive cleanup evidence. Lost replies are reconciled using the same ID.
- Legacy operations without captured ownership cannot be backfilled by guessing. Preserve those
  files and report the diagnostic gap. The two retained synthetic reproduction files remain
  evidence, rather than targets of an unproven automatic deletion.

## Implementation seams

1. `supabase/functions/_shared/drive.ts`: `generateFileId`, new-upload `newFileId` metadata;
   POST-only identity, parser and overwrite fences. Implemented; fourteen new regression cases.
2. `20261206134000_process_upload_ownership.sql`: private ownership ledger, claim/authorize/settle
   functions, publication/indexing fences, bounded recovery and privacy-limited diagnostics.
   Implemented and verified: 9 PGlite behavior/reader cases, 21 new real pgTAP assertions
   within the original855-assertion/30-file chain. The forward chain through351 is now
   applied only to local Beta and has869pgTAP/34files plus9native checks verified.
   Do not edit applied migrations or persist resumable session URLs.
3. `apps/agent/src/team-bridge/transfer.ts`: bounded, cancellable MD5 and upload protocol v2
   producer fields implemented. File identity/size/timestamps are checked around hashing and upload;
   changed files are refused before provider chunks. Nine upload regressions pass. Edge
   consumption is wired and captured-ID success plus revoked-finalize cancellation are live-tested.
   `supabase/functions/drive-ops/index.ts`: persist identity before the provider request, enforce
   producer evidence and preserve revoked finalization fences.
4. `drive-ops/process-output-recovery.ts`: implemented service-only recovery core with one
   claim per tick, seven-second total deadline, exact ownership checks, two lease authorizations,
   v2 conditional trash and positive readback. 22 worker cases and 17 v2-client cases pass. Scheduler integration is live locally and
   performed the corrected provider cleanup automatically, with no manual worker invocation.
   Failure must not starve ordinary catalog work or existing launch/task cleanup.
5. The read-only workspace projection and `analytics investigate` reader now include cleanup
   phase, finite attempt budget, lease/retry times and explicit absent/changed/malformed evidence.
   Include a typed uncertain-result code, code locations and capability-inventory coverage.
   Reader, code-map, coverage and error regressions passed in the recorded checkpoints. Coverage
   remains `pending_producer` until full real-agent and provider acceptance is complete. No content, names, provider
   IDs, raw paths, tokens or session URLs enter diagnostic output.

## Verified provider mutation precondition

Live probes on new synthetic files in the authorized QA folder found that Drive v3 returns
no metadata ETag and accepts a PATCH with a deliberately stale `If-Match` (200, mutation applied).
Do not use v3 conditional trash for this recovery lane.

Drive v2 supplies a file ETag. After changing the owned fixture, PATCH with the actual old ETag
returned 412 `conditionNotMet` and left it untouched. A fresh v2 ETag then authorized the same
fixture's trash (200), confirmed by v3 readback. All created probe fixtures are trashed.
Evidence: `drive-followup/t139-provider-precondition-v2-final.json`; earlier negative v3 proof
is retained in `t139-provider-precondition.json`.

The worker must obtain the ownership fields and ETag from the **same v2 metadata response**.
Reading ownership in v3 and then obtaining a newer v2 ETag would authorize an intervening change.
Map v2 field names explicitly, require a valid ETag, use v2 conditional PATCH, and preserve the
file on 412 or unknown response. Check current database authorization immediately before the
provider request. A successful request alone is insufficient: confirm trashed readback.
The durable database fence and the provider precondition cover different races. The actual
new v2 client also read the private v3 marker in its same-response metadata and successfully
trashed/read back an owned fixture (`t139-provider-recovery-client-live-recovered.json`).
The first client probe ran before its source mirror was refreshed and failed; that exact owned
fixture was recovered from its private ID/nonce journal and cleaned, with both records retained.

## Concurrent adoption fence implemented

`20261206135000_process_output_adoption_fence.sql` adds a durable mutation reservation and
private per-provider-ID tuple locks. `service_begin_process_output_trash` commits that reservation
before the provider request. Material insertion and provider-ID rebinding serialize against it.
An earlier adoption defeats cleanup; a later adoption is refused with `PROCESS_RESULT_UNCERTAIN`.
The reservation survives lost replies, lease expiry and attention/exhaustion. Do not clear it
merely because no worker is currently active. A retained uncertain output is preserved in Drive;
claiming it is safely adoptable requires separate positive recovery evidence.

Three actual concurrent PostgreSQL connection cases pass: begin-trash before adoption;
adoption before begin-trash; and first ownership capture against an in-flight material insert.
Fourteen PGlite cases cover durable behavior, including expired leases, waiting/attention, identity
rebinding and incremental replay. The latest351-migration chain passes869pgTAP assertions across
34files, including the50,000-file catalog fixture; five native tariff cases and four concurrent
cases also passed (the fourth covers capture versus incremental ingestion). Disposable clones
were removed and live Beta was not migrated. Evidence: `drive-followup/t139-adoption-fence-proof.json`.

The first per-file advisory-lock design exhausted shared lock memory on the large catalog
fixture. It was replaced with tuple locks, not a raised database limit. Separate native race
fixture setup issues (schema-owner role and atomic owner/membership creation) were corrected;
only the affected race gate was repeated after the unchanged SQL chain passed.

Worker core now has 22 targeted cases and calls the durable reservation before conditional
trash. The privacy-limited projection/reader now exposes the reservation and observed reference
booleans, verified end-to-end through the local read-only CLI. Current capability coverage
continues to say `pending_producer`; this checkpoint does not establish full T139 acceptance.

## Acceptance evidence still required

Regression tests must cover cancellation before provider start, a final PUT already in flight,
lost start/final PUT/trash replies, agent and worker restart, stale lease holders, grant and
membership loss, concurrent finalization/cancel/indexing, repeated starts, pending 404,
retry exhaustion, and wrong/original/published/moved/modified targets. Verify SQL permissions,
RLS/service isolation and privacy of the reader projection in disposable PostgreSQL first.

Then apply only to the guarded local acceptance stack and repeat the real-provider race on a
new synthetic output inside the authorized QA folder. Prove the exact file is trashed, the
operation remains canceled with no result, business finalize remains refused, indexed output
is absent, and the CLI explains cleanup. Original-file hashes and connected root must remain
unchanged. Finish source/beta regression gates before closing T139.

Google documents pre-generated IDs for resumable uploads and retry behavior in
[Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
and [files.generateIds](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds).
These support the identity strategy; they do not prove that our durable recovery is implemented.


Current real-provider records: `t139-protected-upload-live.json` (success);
`t139-inflight-recovery-live.json` (original48-second observation too short for minute cadence);
`t139-inflight-recovery-observer.json` and `t139-inflight-analytics-investigate.json` (attention,
registered material retained); `t139-provider-compare-live.json` (identity/content/root all match).
The next provider race must use a new captured output after migration351; never overwrite these
failed-attempt records or turn a registered fixture into automatic cleanup input.


Corrected live evidence: `t145-inflight-recovery-live.json` and
`t145-inflight-analytics-investigate.json`; independent `t145-provider-compare-live.json`;
`t145-local-migration.json` records exact local-only migration and preserved auth/connection.
The CLI labels reference booleans as observed-current, not reconstructed historical state at
as-of: material/reference changes do not necessarily change the ownership receipt timestamp.


## Actual-agent UI and progress acceptance (T146/T147)

CUA exercised the actual Beta agent on the existing owned English fixture: successful compression,
cancellation during source download, and cancellation after the agent reached processing20percent.
Local SSE and actor-scoped cloud readback agree on canceled/resultnull; the canceled requests had
no captured output handoff. An authenticated second cancel returned404, proving the active local
handle was removed. The final corrected UI run preserved26percent after cancellation, rather than
falling back to the sparse cloud counter0. It did not claim successful output.

ActiveOperation now uses the existing Modal primitive, so controls remain in the viewport instead
of following the full file table. Running work is not dismissed by Escape; terminal state allows
Close. A failed status read is announced and can be dismissed without implicitly canceling work.
The shared hook preserves an operation's measured progress on terminal readback but still clears
it when operation identity changes or the stream disconnects. Missing explicit measurement stays
indeterminate; this does not reconstruct progress after a lost historical snapshot.

Existing workflow completion/failure seams and operation-scoped local SSE/cloud reads are reused;
no names, content, paths or credentials were added to telemetry. Beta deliberately disables web
analytics, so these live observations use guarded local SSE/readback and screenshot evidence,
not a claim of newly captured production telemetry. Cloud state still does not prove browser
visibility or delivery, and dismissal after a status-read error is not proof of cancellation.
Evidence: t146-agent-ui-processing-proof.json, t147-agent-ui-proof.json,
t147-cancel-settlement.json, t147-progress-after.jpg. Tests:21targeted +24relatedPASS;
TypeScript tests/projects and targeted ESLintPASS. Restart and final canonical proof remain open.


### T148: official Beta restart recovery

A new synthetic output was fully uploaded into the authorized QA processing folder and canceled. Before official beta:down its durable receipt was pending with zero attempts; shutdown completed before the next minute tick. Official beta:up restored the existing database and credentials without reset. The ordinary dispatcher then recorded trashed in one attempt, with a durable provider mutation reservation and no registered material or recorded business result. No worker was invoked manually.

The read-only investigation CLI confirmed the receipt. An independent Drive v2 read confirmed the captured ID, name, MIME, size, checksum, private marker and parent, plus trashed=true and ancestry inside the connected root. The operation remained canceled with no result; root, connection and credential bindings were unchanged. Evidence: t148-restart-prepare.json, t148-restart-readback.json, t148-restart-investigate.json and t148-provider-compare-live.json. Remaining adversarial cases and final canonical gates stay open.


### T149: preserve renamed and moved outputs

Two new synthetic captured outputs were changed before cancellation: one renamed, one moved between owned QA folders inside the connected root. The ordinary dispatcher retained both in attention after one attempt, without reserving a provider mutation. Independent v2 metadata readback confirmed untrashed files with the expected changed name/parent and unchanged checksum. Both operations remained canceled without results; the read-only CLI confirmed attention. The first harness query requested an unavailable projection column; it was corrected and resumed on the same IDs, without creating replacement operations. This proves metadata-change preservation, not content modification or lost-reply behavior. Evidence: t149-preserve-live.json and t149-preserve-investigate.json.
