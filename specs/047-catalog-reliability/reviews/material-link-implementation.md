# Material links — implementation and acceptance in progress

This increment targets T006/T010/T011/T014. These tasks remain open until final
verification and actual beta provider/UI acceptance; this file is not a release
or packaged-beta promotion record. The historical complaint's exact cause remains
unproven; source regressions prove that Get-link used to request permission changes,
Share implicitly remembered approval, and restricted URLs were discarded.

Implemented protocol and privacy boundaries are in C7 of
`../contracts/catalog-lifecycle.md`. Browser URL delivery, public access,
acknowledged permission change, saved preference and clipboard delivery remain
separate outcomes. Unknown writes hold their file; Check never repeats creation.

The first disposable database pass validated migrations through 20261207141000:
47 pgTAP files, 1074 assertions; 2 real-Auth tests; 10 native suites, 46 tests,
including three new real-SHA/concurrent-share regressions. The temporary database
was removed. The complete follow-up pass also validated the diagnostic-index migration:
425 migrations, 1074 assertions, 2 Auth tests and 46 native tests; its hashes and
results are in verification-db-material-link.json. Source rows were not copied.

The controlled diagnostic path uses the real material-link hook and flow producer,
ProductAnalytics sanitizer, SQL ingestion and a SELECT-only test role. It separates
clipboard child terminals from URL resolution, discovers a server-only pending
request without browser events, preserves missing sources and current-snapshot
limitations, and exercises inspect, investigate and audit. Beta telemetry stays
disabled; manual walkthrough evidence cannot replace this ingestion proof.

Initial static verification caught a missing accessible loading label; it was
fixed using the existing translated loading label. No gate or privacy guard was
weakened. Earlier privacy and determinism regressions were fixed in producer text
and unsupported-source timestamps; established missing diagnostic boundaries remain
asserted alongside the added sharing boundaries.

Canonical fast verification passed all 14 gates in 1770 seconds: 8988 tests
passed, 66 skipped. All 43 files in its frozen snapshot remained unchanged during
the run. See verification-fast-material-links.json. This is source verification,
not packaged-beta promotion.

The three proved migrations were applied only to local beta, bringing it to the
exact 425-file history. Eleven protected table snapshots matched; connection and
credential digests changed during runtime and are not claimed identical. The
private snapshot limitation and failed native/browser control attempts are in
manual-beta-material-links.md. No new manual sharing success is claimed.

Remaining work: actual manager/Explorer Get-link and Share walkthroughs, clipboard
recovery and real provider permission acceptance. A read-only review also found
that a long-idle confirmation advances its key timestamp; the next regression
will require a fresh inspection rather than extending that first-use window.
T006/T010/T011/T014 remain open for their applicable acceptance boundaries.
