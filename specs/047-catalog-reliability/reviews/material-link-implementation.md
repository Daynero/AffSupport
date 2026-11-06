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

Real-provider API acceptance subsequently passed against local beta: existing native
catalog URL read; new 44-byte synthetic private CSV; explicit public grant;
same-key replay retaining one confirmed acknowledged receipt. A viewer could obtain
the restricted URL, could not grant public access (HTTP 403), produced no grant
receipt, and left the file private until the owner granted it. The safe reports
are catalog-link-provider-smoke.json and catalog-link-provider-smoke-acl.json.
These are HTTP integration evidence, not manual browser or clipboard acceptance.
They ran from c331b6ed with unchanged share backend, before the next UI increment.

The long-idle confirmation regression was reproduced for 300001 ms and 31 days;
the working change requires a fresh inspection and uses its fixed server timestamp.
Focused sharing tests passed, then the full source verification passed 14/14
gates and 9034 tests (66 explicit skips); see verification-fast-catalog-actor.json.

Remaining work: actual manager/Explorer Get-link and Share walkthroughs and
clipboard recovery. Computer Use native and browser hosts are unavailable, so
no new manual sharing success is claimed. T006/T010/T011/T014 remain open for
their applicable acceptance boundaries.
