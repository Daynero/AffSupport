# Stop diagnostics and remaining manager scope — working increment

Base checkpoint: dedc9d13 (14 gates, 9034 tests, 66 explicit skips). That report
does not verify these subsequent working changes.

A pending Stop followed by client replacement retained old search/selection and
busy state. The causal regression failed with the old search still present; the
manager now remounts its scope by client identity as well as team/access epoch.
Late old replies cannot refresh or notify the new surface.

Stop now records its own lifecycle. RPC reply, bounded fresh state read, and
committed toast feedback remain separate. Unknown replies offer a read-only Check
and do not replay the RPC. Equivalent timezone spellings represent the same round.
The 89-test focused pass covered the UI, producer, actual SQL ingestion, clipboard
child identity and exact native error source mapping. Five additional real-SQL
boundary scenarios passed: Stop correlation, Check discovery, conflicting targets,
late delivery and unavailable target projection.

The actual producer-to-ingestion test found that flow_id had moved from properties
to its dedicated UUID column. Both new Stop lookup and related clipboard lookup
now use that canonical column; explicit casts preserve text parent comparisons.
The clipboard regression failed with three null child IDs before the fix. Native
team restitch diagnosis also used a generic wildcard source; its regression now
requires the exact image preparation origin, reusing the closed native code map.

The new migration creates only three partial diagnostic indexes. It does not add
a queue, Stop receipt ledger, role privilege or mutable target field. Native DB and source verification results follow below; real beta acceptance remains open. The
Computer Use native pipe/browser host remain unavailable. No production action
has been performed, and no complete feature acceptance is claimed.

Further scoped regressions reproduced old-actor browser-exit/navigation guards
before React effect cleanup in inline, bulk, defaults and the manager. Guards
now check the original scope synchronously; account replacement cannot inherit
an old pending/draft warning. The three additional surfaces failed before the
fix and passed afterward. Native index and full source proofs follow below.

Final static verification passed 13/13 gates in 109 seconds. The following
isolated native database pass replayed 427 migrations and passed 49 pgTAP files
(1122 assertions), 2 real-Auth checks and 46 native tests; exact migration hashes
are in verification-db-catalog-stop.json. All 26 source/test file hashes stayed
unchanged through these checks.

The proved index migration was applied only to local beta (426 → 427). Complete
history matched. Eleven of 13 protected table snapshots matched; connection and
credential digests changed while runtime workers were active. Whole-table digest
snapshots do not identify the changed columns or their cause; no stronger claim
is made. The migration itself contains only three index definitions.

A fresh attempt to open beta through the in-app browser failed with
`The browser access host is unavailable`. Native Computer Use was also unavailable
in the prior attempt. No new manual UI acceptance is claimed. Full source verification passed all 14 gates: 9049 tests passed and 66 were explicitly skipped (1307 seconds total). All 26 frozen source/test hashes matched afterward; see verification-fast-catalog-stop.json. This does not establish packaged or manual beta acceptance.

The fixed-as-of read-only production CLI was rerun against the unchanged historical
window. Exact native RESTITCH error mapping now resolves to screen-cache/restitch
origins rather than the generic process wrapper. Safe evidence is in
incident-code-map-readback.json; selected image and underlying transfer cause
remain unknown. A later source audit found malformed active-round values could be
coerced to null in the API; the strict validation follow-up is separate from this
frozen checkpoint and is not claimed fixed by its report.
