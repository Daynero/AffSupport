# Implementation progress — 047

Owner authorized implementation in beta on 2026-11-05.
Checkout: `/Users/daynero/RiderProjects/AffSupport-047-beta`, branch `beta`.
Base SHA: e3fcc1941e19c092ed2daa7571bd3c35adc883d1 (1.3.3).
Production unchanged. No completed-task checkboxes claimed for partial work.

## Implemented changes awaiting full acceptance

Latest follow-up verification: `npm run verify` passed all 14 gates in 1132s,
with 8807 tests passed and 60 explicit skips. The complete machine-readable
report is retained as `verification-fast-scope-cancel.json`. The separate real
PostgreSQL replay passed 46 pgTAP files / 1064 assertions, 2 Auth clock tests and
8 native concurrency suites / 37 tests. The completed-command summary and every
tested migration hash are retained as `verification-db-scope-cancel.json`.
The disposable clone was removed. The connected acceptance profile was not
migrated by these checks. Ordinary source-beta manual acceptance is now recorded in manual-beta.md; full feature and packaged acceptance remain open.

- T012 portion: run/retry require nonnegative safe integers; cancellation requires
  boolean. Malformed responses no longer masquerade as genuine 0/false no-ops.
  Regression first: 10 failures; after fix: all 15 profile/outcome API tests pass.
- T011 portion: shared material action host keeps a selectable readonly URL in a
  persistent dialog; Copy/Open remain available when clipboard is denied. Synchronous
  pending guard prevents duplicate share calls; lost-response retries retain the
  same request key; old scope results do not populate another team's dialog.
  Three initial interaction regressions pass. The later increment below adds share
  telemetry; durable recovery after unmount and real provider acceptance remain open.

## Verification

Initial increment full verify passed: 14/14 gates, 8678 tests, 60 explicit skips.
Preserved result: verification-fast-initial.json. Later changes: strict legacy list
readers reject malformed records; snapshot APIs retain valid rows with invalidRowCount;
manager displays partial-read warning and does not show a false empty-state. Retry UI
uses the actual accepted count. Updated touched suites pass: 63 tests plus the three
registry refresh tests. Static gates after these changes: 13/13 PASS (verification-static-current.json).
No live beta or provider acceptance is claimed. N-variant and publication storage/worker
and delayed-link features remain unimplemented.

## Image recovery increment

- Cache validates actual received/cached MD5, decodes frame count and honors cancellation,
  including cache hits. Three regressions failed before these fixes.
- Confirmed checksum/unsupported/source-specific image failures persist in a bounded,
  24h, team/settings/version-scoped native refusal history. Network/disk failures do
  not blacklist source images. Restart, expiry and settings isolation are tested.
- Protected native read + typed browser wrapper feed this history into the next random
  draw. Matching bad material/checksum is redrawn without a download grant; repaired
  versions remain eligible. Browser, updater claim and native recovery claim carry
  refusal history; the authorized server matches it against its own current draw.
- Shared selection bound and distinct selection-limit error are mapped to UI/diagnosis.
  Candidate rejection journal includes operation/material IDs without names or URLs.
- Missing index download size can be resolved from an authorized live provider read;
  mismatched identity/version is refused. Native document export remains unimplemented.

These changes do not yet provide automatic alternative fetching inside the same native
processing attempt, complete cross-machine refusal storage, or the full retry budget
ledger from C4. T015–T020 remain open until those acceptance requirements are proved.

## Local beta prerequisites

Existing ignored beta profile copied without printing values. Doctor reports
occupied 54321/54322/54324 and missing local Functions environment in this checkout.
No existing process was stopped, no database reset/migration was performed.
Use the canonical ownership/isolation workflow before starting this candidate.

## Latest verification — image refusals

108 related tests passed across native recovery, protected route, cache, selection,
updater claim and analytics map. A further 53-test run passed including Launch runner
and browser updater claim parsing. Final static verification: 13/13 PASS; retained
as verification-static-image-refusals.json. The final cancellation preservation change
passed static checks; the broader delegate scenarios passed before that one-line guard.
Launch defaults now load the same scoped refusal history. Browser updater and native
background claim both carry it to the authorized server draw; the server compares
settings revision, slot, material ID and checksum before excluding a candidate.

Owner clarification: broken images must be skipped on the next random selection.
Implemented for the same agent's persisted, bounded refusal history, including after
restart. This is code/test evidence, not live packaged beta acceptance. Other machines
need their own observed refusal history until central refusal storage is added.

## Manager, diagnostics and strict media increment — 2026-11-05

Implemented in the candidate (production unchanged):

- Bounded history/readback with abort, foreground reload and visible retry. Bulk
  saves reconcile lost responses by version plus requested fields before permitting
  another mutation; calendar time/zone/day and frequency are one patch. Successful
  per-item results persist across retries. Leaving stops further bulk enqueue.
- Catalog manager consumes the existing workspace bulk-trash receipt owner. The
  standalone fallback preserves operation keys, clears only proven successful rows,
  and refreshes even after partial failure. Full Undo acceptance remains open.
- Scope changes reset manager selection/filter/drafts/undo through a keyed scope.
  Inline writers fence late acknowledgements and reads after scope change/unmount;
  late manager run/trash/retry results cannot toast or refresh another scope.
  History focus returns by catalog identity, including duplicate names.
- Additive `list_team_catalog_manager_snapshot` RPC combines the existing authorized
  registry/profile projections under one stable statement snapshot. The web and
  readback helpers prefer it; old projections remain intact for older clients.
  RPC ACL, invoker/stable metadata, API partial rows and hook ownership are tested.
- File/share telemetry includes a closed surface and explicit unknown storage when
  connection metadata cannot be read. Share success is emitted after the selectable
  URL commits; clipboard failure leaves it available without another Share request.
  Producer→client sanitizer→real SQL guard is exercised. Optional diagnostic tracking
  failures cannot block a file lifecycle. The new guard migration is local source only.
- Exact native operation journal joins now explain the two incident operation IDs in
  inspect and investigate without a browser terminal. Duplicate/conflicting/late or
  unavailable evidence remains explicit; native completion never proves browser
  delivery. A reservation alone is no longer the final explanation for those failures.
- Audit sources fail independently for timeout/permission/schema availability. Unknown
  counts are null; unrelated sources survive. Programming errors still fail loudly.
  Start/terminal pairing uses one grouped pass rather than a materialized self join.
  Catalog CLI honors its requested attempt window and labels live profile/runtime
  fields as current snapshots; later receipts never become historical success.
- Strict managed FFmpeg image decode now gates fresh and cached screens, using the
  stitcher engine, a scaled 20-second deadline, cancellation, frame count and a
  16-million-pixel ceiling matching existing catalog validation. A truncated but
  metadata-readable PNG fails. Tool/deadline failures do not blacklist a source.
  Concurrent cache initialization shares one index load, retaining both refusal
  records. Successful revalidation clears the exact scoped rejection.
- Corrected the public Drive permission request: `sendNotificationEmail=false` was
  incorrectly sent for `type=anyone`. Official permissions.create permits that flag
  only for user/group grants. A transport regression fails on the old request and
  passes after removal, including idempotent existing-permission readback.

### Fresh evidence

- Manager/inline/API/SQL snapshot suites: 112 tests passed.
- Strict media/cache/manager/bulk/analytics guard suites: 116 tests passed before the
  final cache initialization/write classification changes; those cache/bulk/registry
  follow-up tests passed separately (27 tests).
- Audit/inspect/native/cutoff suites: 46 tests passed, including source failure tests.
- Public-link request regression: failed with DRIVE_UNAVAILABLE before correction;
  passed after correction. Share UI: five interaction regressions passed.
- Real read-only candidate CLI, pinned `2026-11-05T12:19:42.747Z`: both incident
  operations resolve to native RESTITCH_SCREEN_FETCH_FAILED; investigate includes
  the native-only failed operation. Before grouped pairing, audit returns partial
  with pairs/timeout; after grouped pairing it returns complete source availability
  with no unavailable source. Coverage summary: 62 covered, 16 partial, 17 uncovered.
  Complete source availability does not claim complete product coverage.

New migrations `20261207130000_catalog_file_action_analytics.sql` and
`20261207131000_catalog_manager_snapshot.sql` have not been applied to any running
beta or production database. Full static/fast verification and real packaged beta
acceptance must be fresh for this increment. The full task list stays open where
acceptance spans additional work. N real video variations, delayed-link storage and
workers, provider conditional-content-write proof, centralized refusal memory and
same-attempt fallback in all executors remain outstanding; no UI-only substitute is
counted as their implementation.

### Full verification checkpoint

The manager/native/diagnostics increment passed `nice -n 15 npm run verify`:
14/14 gates, 8739 tests, 60 explicitly explained skips, 1525 seconds. Retained
machine-readable result: `verification-fast-manager-native.json`. This checkpoint
precedes the staged native-catalog XLSX export change. It is not packaged-beta,
live UI, Windows or production-release acceptance.

The full suite first caught the missing additive error catalog for the new selection
limit. It is now installed by `20261207132000_catalog_reliability_error_codes.sql`;
the applied base seed is unchanged and the generator checks the separate batch.

### Export, delivery evidence and shared save increment (uncommitted)

Native catalog downloads now export XLSX rather than requesting native-document media. Grants pin the provider version and catalog identity, enforce view/download rights and live registry membership both before export and after bounded body consumption, and carry a safe .xlsx filename. Export is bounded to 10 MiB. Provider size failures have a closed code and user-facing explanation. Real provider export/public-link evidence is retained in `provider-acceptance.md` and adjacent sanitized JSON receipts.

Browser download handoff is explicitly weaker than an agent-confirmed saved file: analytics records browser_handoff versus agent_saved and does not claim production_completed for an anchor click. URL visibility records url_visible. A regression follows actual producer → sanitizer → public.ingest_analytics_events → SELECT-only CLI diagnosis; seven emitted events are accepted and the native failure code survives the complete path.

Inline and bulk settings use a shared save/readback controller. Only exact next-version acknowledgements can confirm simple profile edits. Calendar changes always read back the authoritative interval/schedule/due time. Typed stale writes remain conflicts even when another writer saved the same value; unknown outcomes can be rechecked without repeating mutations. Scope revocation prevents late delivery. Focused controller/manager/navigation/runtime tests: 73 passed, bulk tests: 8 passed.

The complete migration chain passed isolated PostgreSQL verification after export/delivery changes: 46 pgTAP files, 1064 assertions; 2 real Auth clock checks and 37 native concurrency checks passed. This predates the progress-identity migration. No running beta or production migrations were applied. This increment still needs fresh canonical verify and actual packaged-beta acceptance.

The manager snapshot additionally carries active round/attempt, progress owner and live native child identities, with a separate view-authorized read helper. Cross-attempt/child progress resets, stale worker progress is ignored, and the existing RPC remains a stable security-invoker composition. SQL regression verifies stale timestamp exclusion and cross-team/anonymous denial. Runtime facts merge separately from acknowledged same-version settings; catalog lookups use an indexed map. Run/retry share the synchronous lock and zero accepted work uses an informational result. Focused identity/API/SQL suites passed after the new migration; shared save/manager suites and the real ingestion regression also passed. Canonical verification for the complete increment follows.

### Fresh complete verification of export/save/progress increment

`nice -n 15 npm run verify` passed all 14 gates, 8769 tests, 60 explicitly explained skips, in 1118 seconds. Machine-readable evidence: `verification-fast-export-save.json`. This includes the new export, producer-to-ingestion-to-CLI diagnostic regression, shared save controller, and progress identity changes. Coverage was not measured by the fast form. Packaged-beta and running-UI acceptance remain open.

A follow-up review identified two bounded remaining cases for T012/T025: a present malformed optional pending flag can still become false, and disappearance of a native child can unnecessarily reset the same round's fill. These remain open for the next correction and are not claimed fixed by the passing suite. The passing source is retained as an implementation checkpoint, not completion of all 60 tasks.

The fresh real PostgreSQL rerun including progress identity passed: 46 pgTAP files/1064 assertions, 2 Auth clock tests and 8 native concurrency suites/37 tests. `verification-db-export-progress.json` records the completed-command summary and every tested migration hash. The disposable container was removed by the runner. Running beta and production were not migrated.

### Further manager/native corrections after 68709d21 (uncommitted)

Owner additionally requires a manual beta walkthrough after implementation and automatic checks. No manual candidate-UI acceptance is claimed yet. The existing connected beta belongs to the dirty older `AffSupport-catalog-beta-20261104` checkout, HEAD a6c8b274; its ownership journal records an old packaged source and its recorded app/owner PIDs are absent. The local database/functions containers still run. No existing workspace files, stack, connected profile or credentials were changed during this read-only preparation.

Regression-first follow-ups now cover:

- Present malformed pending flags, impossible accepted counts, invalid or cross-catalog history and invalid stage times fail explicitly; genuine legacy absence, empty data and no-ops remain distinct.
- Progress survives child completion within one round, but resets for a new round/child; history applies confirmation labels only to its matching active attempt.
- Actor/access epoch or catalog changes reset manager/history state. Late old commands, retry errors, file terminals and diagnostic errors cannot enter the replacement actor/view.
- Lost retry replies trigger a fresh bounded history read before another mutation is offered. A same-tick hide/refocus queues a fresh serial read even if the canceled read has not yet unwound.
- Additive observed-round cancellation rejects a replacement round, leaves it active, and refuses a provider reconciliation hold with a closed user-facing code. Its existing provider-worker lease refusal is preserved. Error refresh is limited to command paths, preserving per-item trash refresh ownership.
- Server observation time orders same-version runtime facts. A scoped cache retains the newest observation across later stale responses, preserves acknowledged settings and detects an old acknowledgement after a newer settings version was already observed. Plain patch acknowledgements never invent observation time.
- Screen transfer enforces its own byte ceiling before reading, cancels rejected upstream bodies, removes partial bytes, and limits transient retries. Cache classification preserves missing/changed source, expiry, permission, network and local-disk causes; only candidate-local defects enter refusal memory.

Focused follow-up suites passed (separate runs): 121 manager/API/SQL tests; 75 inline/manager/bulk tests; 38 history/cache tests; 46 analytics/file/ingestion tests; 62 native bridge/cache tests; 29 cache/real-decoder tests; 52 SQL/code-map tests. Some groups overlap. Earlier full 8769-test proof belongs to commit 68709d21; the current follow-up requires a fresh full verification and real-PostgreSQL rerun of the new migrations. Nothing was published to production.

## Bulk inverse and bounded acknowledgement checkpoint — 2026-11-06 local time

`npm run verify` passed 14/14 gates in 2815s: 8824 passed tests, 57 explicit skips.
The exact machine report is verification-fast-bulk-undo.json. The preceding static
run also passed 13 gates. An earlier static failure was a legacy Button import in
the new inverse component; it was corrected before the successful full run.

- Per-catalog bulk Undo restores only changed fields and the complete calendar
  tuple, with a fresh CAS/readback, four-write limit, unknown read-only recovery,
  foreign-version rejection and scope/unmount guards. Calendar source-beta smoke
  after full checks restored two actual QA profiles and UTC due times correctly.
- The shared settings controller bounds an unanswered write at 15 seconds, then
  reads its exact expected version. An unchanged old version remains UNKNOWN.
  Inline recovery retains the original intent and restores/removes Undo metadata
  only on confirmed readback; no second inverse is dispatched.
- Closing an unknown bulk result explains that closing does not cancel an
  accepted write. An emptied Recent changes dialog closes and restores focus.
  The workspace chip labels its scheduled subset explicitly.
- Ordinary native-Sheet downloads from manager and Explorer, visible link/copy/open,
  profile Undo and bulk boolean/calendar Undo are documented separately from
  controlled fault tests. No packaged-beta promotion or production action occurred.

T013 and T025 acceptance is recorded against the completed earlier implementations
and these complete checks. T027 is explicitly reopened for the newer-settings /
missing-runtime acknowledgement path found during follow-up review. T022 still
needs server-clock preview wiring. Legacy Stop, restricted-share consent and
command identities are continuing work, not claimed complete. Independent drafts
were prepared under ignored scratchpad while the verified application source was
frozen; they are not included in this passing checkpoint.
