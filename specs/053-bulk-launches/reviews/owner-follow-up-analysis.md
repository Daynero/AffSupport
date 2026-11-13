# Owner follow-up artifact analysis

2026-11-13, branch053. The owner explicitly superseded browser-local queue and background opt-in requirements. Earlier completed tasks/evidence remain historical.

Pass1: D1 HIGH historical mounted-hook A3 contradicted durable ownership; D2 MEDIUM new criteria sat under Assumptions; D3 HIGH legacy config normalization needed original selected-version CAS. Remediated all three in spec/plan/model/contracts.

Pass2: 20 requirements and9 criteria mapped to47 tasks,0critical/high unresolved. D4 same-ticket native confirmation cannot revoke/overwrite durable ownership, and D5 cancel semantics target unfinished accepted generations, are explicit T040/T042 test obligations. No constitution exception; typed shared boundaries, actor ACL, native managed execution and existing observation owners retained.

Subsequent owner additions: FR021 compact desktop creative/settings/neutral notes; FR022–023 canonical catalog rename with immutable bound-name warning/search aliases. T048–053 map acceptance; T050 must finish rename impact research before its implementation. Desktop screenshots only.

Rename analysis pass1: canonical-name override mismatch and launch mutation guard conflict resolved in T050 design; active attach/name proof remains serialized. Pass2: uncertain provider write and previous-name search omissions resolved with conditional ETag/stable reconciliation and append-only searchable aliases. Current contract maps FR022–023/SC011 to T051–053; implementation acceptance still pending.
Batch code review finding: per-item transient preparation could starve healthy siblings before acceptance. Refined contract requires durable pending admission with independent paced retries under existing recovery, covering first-time automatic setup. T038/T039/T042 tests must include this state.

Implementation review, pass 1:
- An aborted StrictMode observation could consume a retry slot; aborts now leave retry state untouched.
- An obsolete batch head could hide a history gap; changed heads restart keyset traversal, preserving observed rows.
- Two canceled requests in backoff could starve a third; due requests are filtered before the bounded claim.
- A definitive admission failure could be resubmitted from a retained parent prop; settled request IDs now fence it.
- Lost rename replies require distinguishing provider uncertainty from a command never admitted. Status absence records a metadata-only tombstone under the admission lock, preventing a late original POST.

Implementation review, pass 2:
- Pending preparation is queued, never emitted as admission failure; healthy siblings continue independently.
- Rename provider writes retain a strong original ETag, reconcile through readback, honor bounded Retry-After and cannot be generically canceled after dispatch.
- Setup and rename diagnosis use closed stages/codes and opaque correlation; safe persisted projections explain server state without browser telemetry. Historical as-of state and user-visible delivery remain explicit blind spots.
- Canonical names refresh through existing launch signals; immutable URL/SUB names remain read-only and searchable. Lazy rename UI preserves the pending observer after its first activation.

Focused root acceptance after these fixes: 95 unique cases pass across batch resilience/admission,
automatic-background UI, catalog updater and tariff recovery UI; web and full test TypeScript
checks pass. Exact final canonical verification, browser captures and bundle measurement remain
required before checking final acceptance tasks.

Backend security and recovery review, final focused pass:
- Closed the inverse catalog race: a pending rename now fences later generation admission/resume, catalog reuse attachment, and late intent material/SUB binding. These paths lock the same material rows as rename admission in deterministic order. The original active-generation and immutable revision guards remain in force.
- Duplicate apply with the original request key previously could bypass the persisted provider Retry-After floor. All claims now observe that floor, including same-key apply, status reconciliation and hosted recovery. The new regression proves no additional PATCH during the cooldown.
- Status never issues a provider PATCH. It may commit proven readback or an actor/team/material/key-bound absence tombstone; the latter rejects delayed original submission. An admitted but unissued command is resumed by the hosted worker. Ambiguous writes retry only after fresh unchanged-source proof with the original strong v2 ETag; a changed source is never overwritten.
- Background enrollment persists its ticket only in platform secure storage, scoped by environment, endpoint and enrollment ID. Cloud recovery requires the matching actor/team/installation ticket hash; a different ticket cannot replace a live credential. Expiry renewal requires the exact expired, unrevoked delegation. Revoked, retiring or corrupt ownership remains fenced. Same-ticket recovery survives native restart and lost redeem/confirm replies; an existing rotated refresh credential is preserved.

Validation: final rename/Drive/catalog run passed 74/74 cases (19 full-chain SQL+Edge, 8 conditional rename provider, 22 existing catalog SQL, 8 Drive retry, 17 conditional output provider). This includes literal/percent/plus-encoded name evidence, stale acknowledgement, immutable historical URL/SUB/name bytes, current-name signal invalidation, unknown writes, delayed POST after tombstone, permission loss/return, expired owners, inverse binding fences, cancel-before-dispatch versus unknown dispatch, and Retry-After. The earlier background-focused run passed 187 cases; final small native scheduling/confirmation changes were rechecked with 47 worker and 8 route cases. Additive-migration and diff-whitespace gates passed.

Validation limits: PGlite exercises the complete migration chain and actual SQL functions, but stubs Supabase Vault/cron and does not establish real multi-session MVCC interleavings or Google availability. Provider responses are deterministic fakes; live OAuth/Google behavior and packaged native execution are not claimed. Permission loss after a possible provider write remains explicit pending uncertainty until authoritative reconciliation is possible. Final native pgTAP, canonical verification, desktop browser evidence and exact bundle measurements remain root-owned acceptance gates.

Native PostgreSQL review found the new seven durable consumer tables lacked the
existing task-file cleanup reference trigger. The global coverage check correctly
failed closed and retained files as `cleanup_unverified`; no cleanup bypass was
introduced. Registered all seven tables with the shared reference/locking guard
in their feature migrations. The new regression additionally claims a catalog for
cleanup and proves rename admission, status-absence records and aliases cannot
attach afterward; no provider PATCH or partial receipt survives. Native pgTAP now
checks every new trigger and global coverage explicitly. The original twelve
failed coverage assertions remain unchanged for the rerun.

The corrected native SQL run passed 74 files / 1,479 assertions. Its subsequent
native integration run exposed two legacy fixture calls missing `protocolVersion: 2`
on delegation; the production Edge already supplies that field. Updated only those
two requests to match the current protocol, retaining the real-Vault encryption/
replay assertions and concurrent execution-reservation assertions. The entire
database gate is repeated after this fixture correction.

A subsequent run stopped in the existing 1,005-poll catalog ownership regression:
the canonical pending job was not yet claimed at one boundary, while its identity,
state and zero failure attempts were intact. Two prior runs passed that unchanged
test. Its purpose is ownership/retry accounting, so each synthetic poll now sets
`next_attempt_at` one minute in the past instead of exactly the current wall-clock
instant. All 1,005 iterations, identity checks and zero-attempt assertions remain;
the production claimer and its eligibility conditions are unchanged. The precise
cause of the intermittent empty claim was not independently established.

Canonical suite follow-up: the first shard found an old output-override UI test
that still treated catalog naming as a local override. It now verifies URL/campaign
override edit, copy, autosave, reopen and restore while the canonical name stays
unchanged; the separate canonical rename suite covers actual rename propagation.
The provider fault test also caught a behavioral regression: preserving Retry-After
had disabled even a one-second inline read retry. Short waits now honor the provider
floor within the existing two-retry budget (at most 1.2 seconds per wait); long waits
return their floor to durable scheduling. Writes remain single-attempt. Added
403/429/503 and HTTP-date floor checks. Fifty unique related cases pass, including
conditional rename and UI regressions; the full canonical command is repeated.
The first canonical failure is retained verbatim in
`owner-follow-up-verification-initial.json`; no tests were excluded. The final
matrix in `owner-follow-up-validation.md` distinguishes durable follow-up evidence
from the historical browser-local coordinator report. Screenshot ZIP integrity
checks pass with exactly thirteen desktop PNGs and no mobile entries.

Final provider-floor review found a longer wait was lost by durable non-catalog
source verification: the failing regression observed 30 seconds instead of the
provider's one-hour floor. The Edge now persists the bounded numeric floor with
the fenced failure receipt. A second worker holding a stale due-list row cannot
claim early; a row guard enforces the same due time. Healthy siblings finish.
The same review reproduced loss of that numeric field through nested catalog
error sanitization. Only the bounded integer survives sanitization (arbitrary
provider details are still dropped), and a service-only atomic interruption
command records the catalog cooldown under the original current lease. Three
new regressions failed before correction, then the complete related set passed
84 cases across eight files. The in-progress canonical run was deliberately
stopped after its first two successful shards to include these fixes. Canonical
DB and project verification are repeated for the final source; the interrupted
run is not counted as completed acceptance.

Owner desktop polish (13 November, latest screenshots): bounded the creative name
field, paired creative/URL inputs, removed the duplicate visible URL heading,
shortened count/budget labels, capped automatic budget summaries and manual budget
viewport, aligned inline help, and condensed profile-save actions. Duration now
starts collapsed with its selected time/range visible; validation still opens it.
R2 remains outside disclosures. Real-browser 960/1024/1280/1440/1920 checks in both
themes preserve width and keyboard access to the 100th manual budget. The default
1280px fixture is 1,200px tall versus the prior 1,561px; creative input is at most
246.2px in these measurements. All thirteen desktop captures were refreshed.

The stress case exposed an existing recovery defect: entering manual mode after
an invalid automatic range produced no fields, and the hidden automatic minimum
could continue rejecting corrected manual values. A new regression first failed
on the missing controls, then on that hidden bound. Manual mode now seeds a bounded
field per campaign and derives its minimum from the first manual value. Switching
away/back retains the edited manual values. Shared budget validation is unchanged.
The canonical run in progress when this owner revision arrived was deliberately
stopped; only a subsequent complete run counts as final acceptance.

The complete canonical run reached six shards (8,309 assertions, 76 declared
skips) and found one critical-coverage inventory omission: the two new shared
contract modules were reachable from run-state entry points but had no absolute
floor. Both now have a 90% floor; no existing floor or global ratchet was lowered.
The focused V8 check exposed missing direct request-validation coverage for
canonical rename. Added Unicode/bounds/control-character/identity/version/
acknowledgement/receipt-state regressions. All 62 cases across five files pass;
rename has 100% line coverage and durable batch 95.7%. Evidence is retained in
`contract-coverage.json` and the failed canonical result in
`owner-follow-up-verification-coverage-gap.json`. The final complete command is
repeated after this correction. Runtime implementation and captured UI did not
change during the correction.

The next canonical attempt passed all 14 static gates, then the third test shard
hit host `ENOSPC` while writing Vitest's temporary transform cache and progress
journal. Collected assertions had no product assertion failure; module collection
and reporting were incomplete, so the run is not accepted. Its verbatim result is
`owner-follow-up-verification-disk-full.json`. The completed test process removed
its own cache; no other app/release artifacts were deleted or processes stopped.
The affected suite gate is repeated through `npm run verify -- --gates=suite` with
an owned `TMPDIR` on the external disk (608 GiB available at admission), nice 15,
one worker and unchanged test membership. Static source and test files did not
change after the successful static gates. Final acceptance combines those static
results with the complete affected-gate rerun, not the incomplete prior shards.

The external-disk rerun reached five shards and hit the existing release-controller
test's five-second limit while simulating 1,950 durable observation ticks. The
same unchanged file then passed all 13 tests in isolation; the affected case took
4.156 seconds. This establishes sensitivity to the execution budget, not a proven
product defect or a precise host root cause. The failed result is retained in
`owner-follow-up-verification-controller-timeout.json`. Neither the controller,
the assertions nor the timeout were changed. Once the other local verification
finished and internal free space recovered to 2.2 GiB, the full canonical command
was restarted on the normal temporary filesystem, nice 15 and one worker.

At the owner's next screenshot request, both settings themes, the expanded slider
and creative-source choice were recaptured from unchanged source components.
All four captures have zero page errors and no horizontal overflow. Their hashes
and recapture time are in `desktop-follow-up-verification.json`; the desktop
gallery and ZIP in Downloads were refreshed and the archive integrity checked.

The normal-filesystem rerun passed 14 static gates and 4,088 assertions before
one catalog-manager test checked its passive ownership effect synchronously.
The real panel was already committed, but `claim` had not yet run. The unchanged
file passed 66 cases alone, confirming the scheduling-sensitive assertion. It now
awaits that exact ownership claim with the existing `waitFor` budget; the expected
group, unrelated-group exclusion, placement and no-new-submission assertions are
unchanged. All 66 cases pass after the adjustment. No runtime source or timeout
changed. The original failure is retained in
`owner-follow-up-verification-rediscovery.json`; final canonical verification is
repeated after this test correction.

Final acceptance: the full canonical command passes all 15 gates and all eight
shards, with 11,165 passed assertions, zero failures and 95 declared environment/
platform skips. The unchanged controller wait test takes 260 ms on the normal
temporary filesystem. Final source/test hashes are retained in
`owner-follow-up-source.json`, and the verbatim successful report in
`owner-follow-up-verification-final.json`. Native PostgreSQL, focused source
coverage, built-asset budgets and desktop capture evidence remain separate and
explicit; none is described as live Google or packaged release qualification.
