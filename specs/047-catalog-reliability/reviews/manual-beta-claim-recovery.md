# Manual beta repair acceptance — 6 November 2026

This is a source-beta check, with uncommitted changes over cf0835dd. The exact
runtime files are hashed in manual-beta-claim-recovery.json. It is not a packaged
promotion record or completion of feature 047. Production was not changed.

The first manual pass (manual-beta-commands.md) found two real defects. Both were
reproduced with failing regressions before repair:

- A terminal legacy attempt returned a legitimate null image authority, aborting
  every sibling in the scheduled claim batch. The worker now quarantines only a
  currently owned, inconsistent round. It retains its historical terminal and
  provider receipts, and healthy sibling claims continue. Shared authority outages
  still fail closed.
- Actual offline PostgREST fetches lost their cause as INVALID_RESPONSE. Known
  browser transport failures now carry TEAM_TRANSPORT_UNAVAILABLE through the
  retained UI request, SQL ingestion and read-only CLI diagnosis. They do not
  prove that an in-flight mutation was absent.

## Actual repeat in Chrome incognito, Ukrainian UI

1. Without another Run click, original command af3249c0-74b1-4b0f-ad5f-6543d8fd747d
   and attempt c0c185bc-c0f0-4ee4-9984-50b590030cfe resumed automatically. The same
   attempt completed successfully at 03:21 UTC, with six stages and delivery
   verification. There is exactly one attempt for QA v36. Its history visibly
   shows Updated, completion and the six confirmed stages.
2. The old failed round remains failed, with its original terminal. Its current
   quarantine cause is separate. The manager shows Requires review, disables Run,
   and explains the current problem above the unchanged historical Drive failure.
   No old unknown provider operation was cleared or replayed manually.
3. Kept DevTools open, selected Network Offline and clicked QA v35 Run. The notice
   explicitly said the server could not be reached, retained the unknown request
   and blocked another Run/settings mutation. Check status stayed read-only.
4. Closed/reopened the manager offline. The unknown request and its transport
   cause returned. After restoring No throttling, Cancel unaccepted request
   produced cancelled_before_acceptance for command
   85475650-ca46-4b90-8d9e-92b4a72394e0, with zero v35 attempts. The notice vanished.
5. Retried the list read and recovered all 38 catalogs. A separate offline reopen
   exposed contradictory Loading text in the header; after fixing it, the repeat
   showed Catalogs unavailable and a Retry action. Retry restored all 38 catalogs.
6. Downloaded the updated v36 Sheet through the manager and saved the actual
   .xlsx through the native save dialog. Chrome showed Done. The resulting
   66,737-byte file passes ZIP CRC and XML checks, with 402 nonempty rows (401
   products); formatted empty worksheet rows are not counted as products.

The network override was explicitly restored to No throttling and DevTools closed.
This tests manager reopening, not persistence across a full incognito/browser
restart. Link permission changes, clipboard denial, Windows, same-click image
fallback, N variants and delayed publication are not accepted by this walkthrough.

## Automated evidence

The repaired claim/transport increment passed 113 focused tests, including the
actual command hook → sanitizer → SQL ingestion → SELECT-only CLI path. The later
UI/history regression run passed 82 tests (overlapping that set). The
initial 13 static gates passed before the header/current-cause UI polish. The
final unchanged runtime source then passed the complete canonical fast command:
14/14 gates, 8,911 tests and 63 skips, retained in
verification-fast-claim-quarantine.json. Native cases skipped by the ordinary suite
are separately covered by the disposable PostgreSQL proof below.

verification-db-claim-quarantine.json proves the complete 422-migration replay,
1,064 pgTAP assertions, two real Auth tests and 43 native concurrency tests. Only
the new reviewed migration was then applied to local beta through official CLI
2.117; all 13 protected table snapshots matched across that migration. A cold
Storage health timeout was reconciled by canonical down/up; readiness was not
bypassed, the connected profile was preserved and no reset was used.
