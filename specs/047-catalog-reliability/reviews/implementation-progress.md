# Implementation progress — 047

Owner authorized implementation in beta on 2026-11-05.
Checkout: `/Users/daynero/RiderProjects/AffSupport-047-beta`, branch `beta`.
Base SHA: e3fcc1941e19c092ed2daa7571bd3c35adc883d1 (1.3.3).
Production unchanged. No completed-task checkboxes claimed for partial work.

## Implemented changes awaiting full acceptance

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
