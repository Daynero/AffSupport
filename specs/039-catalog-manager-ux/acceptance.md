# Catalog manager acceptance record

Status: implementation under verification; UX acceptance pending.

## Evidence collected

- Per-catalog profiles, atomic versioned patch, attempt history, delivery readback, retry/cancel and read-only catalog diagnosis are implemented in the feature migration, worker, API and dialog.
- Automated dialog coverage includes a 500-catalog fixture with bounded initial rendering, profile isolation, bulk editing, history, and an older success beside a newer failure. The focused dialog, worker and analytics suites passed (59 tests after the readback and held-bulk additions).
- The database migration and 17 pgtap permission checks passed inside a rolled-back transaction on the local `supabase_db_wishly` database. This is not evidence of production migration.
- Independent code reviews exposed an ambiguous Drive write that could be replayed. The worker now stores a private attempt marker and pending baseline before writing; Drive receives the marker with the sheet. SQL holds scheduled and manual writes until worker readback proves that marker was delivered or that the Drive version is unchanged.
- Final independent code review: buyer **97/100**, designer **97/100**; neither found a code blocker to that score. These are code review scores, not measured success in buyer sessions. A Drive version mismatch without our marker remains held and needs support escalation.
- `npm run verify -- --gates=static` passed all 13 static gates. A full suite run was started earlier and interrupted while code was still changing; it is not recorded as a pass.

## Pending acceptance gates

- Complete visual 390 px, keyboard and screen reader checks with an older success and newer failure, then record screenshots and observations.
- Run 10 unprompted representative buyer sessions for SC-001 and SC-002. Record task time, wrong changes, help needed, and the 9/10 pass threshold. No sessions have been run, so no pass rate is claimed.
- Exercise delivered, unchanged and inconclusive readback paths against a controlled Drive fixture, including a worker crash and subsequent scheduled invocation. This verification is still pending.
- Complete focused tests and `npm run verify` after the final edits; run relevant release and packaged beta gates before any production release.

No deployment or production data change is part of this record.
