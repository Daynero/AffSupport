# Validation — automatic catalog content

Implementation is isolated on `055-automatic-catalog-content`, based on `c2d81d29`. Production publication, shared-image activation, cleanup and release identity changes are outside this work. Final combined-branch verification is pending.

## Shared policy and performance

The initial shared test failed collection because the module did not yet exist; this was not a reproduced behavioral failure. After implementation, all 43 checks pass: every one of the 32 garment price bands, inclusive endpoints, matching facts, exactly 2,000 distinct variants/titles/descriptions, bounded exhaustion, neutral unknowns, independent deterministic streams and malformed random bounds. Shared TypeScript build passes.

The [content benchmark](content-benchmark.json) records 100 samples of 200 already classified images on Node 22.23.2/macOS ARM64: p95 approximately 0.71 ms, maximum approximately 2.34 ms. Provider/database/publication work is excluded. An isolated integration build was running concurrently. The 100 ms target passes; this does not measure complete catalog latency.

Two planning analysis/remediation passes and a third implementation review are recorded in [analysis.md](analysis.md).

## Focused checks

- UI: 208 passed, 0 failed, 0 skipped across creation, settings, legacy bookmarks, manager controls and Launch preparation.
- Initial backend/diagnostic run: 151 passed, 7 failed. The ACL fixture needed an actual `authenticated` database role, not merely its JWT. Three privacy assertions found slashes in the shared static agent explanation; wording was corrected without relaxing the privacy guard. Launch assertions were changed to verify actual image-source changes instead of retired text/price settings. An early failed fixture also left a recovery item pending.
- Corrected affected suites: 83 passed, 0 failed, 0 skipped.
- Final five-file focused pass: 73 passed, 1 failed. The remaining fixture omitted the preceding global-retirement migration. After correcting that baseline, its complete storage suite passed all 11 checks.
- Two new durable creation regressions pass without saved settings: interruption during planning and a lost create response both restore identical rows, without a second draw or spreadsheet.

These runs overlap and their totals must not be added. The complete integrated suite is still required.

## Static and database checks

The initial static run passed 13 of 15 gates. Formatting of the earlier native-source privacy test and test-fixture types were corrected. The next canonical static run passed 14 of 15 gates; only test typechecking exhausted the explicitly imposed 2 GiB Node heap. That exact typecheck passed separately with a 3 GiB heap. No type or privacy rule was weakened. Combined-branch canonical verification remains pending.

Migration versions are `20261208120000` and `20261208121000`, chosen before publication to avoid the independent catalog-video-replacement timestamp. No installed migration or ledger was modified.

The first disposable database run found a missing material-reference cleanup fence on the latest-recipe table. Thirteen existing pgTAP assertions failed closed. The existing `task_cleanup_reference_fence` mechanism was added, with a regression proving disabled fencing invalidates coverage.

The corrected complete-chain run passed 76 pgTAP files / 1,500 assertions, 3 real Auth checks and 83 native concurrency/recovery checks. Public DB types were regenerated from this disposable chain and formatted. The running local beta database supplied schema and role definitions only; application rows and role passwords were not copied, and the existing database was not migrated. Owned disposable containers were removed by the runner.

## Desktop evidence

[desktop-check.json](desktop-check.json) records actual `SpaceSettings` components at 1280 × 900, 2× scale in dark and light themes. Data was synthetic and read-only; every non-loopback request was blocked. There were no browser exceptions or horizontal overflow. Separate generated-data examples use the actual shared generator and are explicitly labelled examples rather than a shipped results screen.

PNGs and the gallery are in `~/Downloads/Soty-automatic-catalog-2026-11-13/`; the adjacent ZIP contains the same files. No mobile screenshots were produced.

## Remaining integration acceptance

Run canonical static/suite/build checks on the combined source, retain exact results and skips, and update the next-release inventory. Packaged native-update acceptance and shared-image provider/cutover acceptance remain release prerequisites; these local feature checks do not replace them.

## Combined-branch correction pass

The build group passed all 6 gates on `602c7a5c`; the complete fast run passed
all 15 static gates, then stopped after the first of 8 test shards. It reported
1,364 passing checks, 15 failures and 17 named skips; this is a partial result.

The failures exposed three integration boundaries. New exact-intent inspection
also reads the existing timing projection, so the synthetic SELECT-only batch
reader now receives the same two pure helper permissions as the real analytics
role. Historical video-state fixtures now merge their checkpoint patches instead
of discarding the new immutable server policy marker. Production marker validation
is unchanged. Finally, the existing guard contract detected that the SQL analytics
guard rejected all seven global-image Launch codes now emitted by the client.
`20261208122000_automatic_catalog_analytics_guard.sql` preserves the complete
integrated guard and adds only those closed values. A stale diagnostic source-file
reference was also corrected. The corrected 14-file run passed all 148 checks. Full validation is pending.

The next complete run on `a29fd6d1` passed all 15 static gates and stopped after
2 of 8 shards: 2,908 checks passed, 1 failed and 24 had named skips. The remaining
failure was another historical diagnostic-reader fixture missing the same helper
permissions. All custom diagnostic readers now inherit the actual migration-owned
`wishly_analytics_ro` role rather than copying its helper permissions. Fixtures
still enforce SELECT-only execution. Initial fixture edits used multiple commands
in a prepared query and were split into individual calls; the missing-view fixture
also revokes inherited access during its fault injection. The 13-file focused pass
then had 217 passes and that one revoke-fixture failure. After correction, all 42
analytics/Stop test files passed: 379 checks, no failures or skips. These overlapping
focused results are not a complete-suite total. No production ACL was changed.

The integrated run on `31bd7872` passed all 15 static gates and reached 3 of 8
shards: 4,294 passing checks, one stale R2 permission-copy expectation and 27
named skips. The permission behavior was correct; the test still named the removed
Catalog settings panel. Its wording expectation was updated. No other old strings
from this translation change remain in tests. Remaining shards are being run as a
diagnostic pass before the final complete canonical run; partial evidence is not
reported as a green full suite.

The diagnostic-only pass over remaining shards 4–8 on `d0d193e9` finished with
7,224 passing checks, 2 failures and 71 named skips. The failures were the derived
critical-module inventory missing the new content/native-update modules, and four
native-update test files bypassing the standard retrying temporary-directory cleanup.
The helper is now used consistently. The corrected six-file infrastructure check
passes all 16 tests.

Focused V8 coverage of the content generator and native-update contract passes all
59 tests and measures 100% of lines, branches and functions in both modules. Native
contract regressions now also cover beta loopback-only URLs, archive target identity,
malformed metadata, impossible snapshots and bounded command authority. Both modules
are registered with a 99% absolute line floor; no existing floor was lowered.
The owner subsequently asked the coordinator to include the parallel worktree's
completed fixes before final combined verification. That work remains independent
until its exact completed source is handed over.
