# Historical incident reconciliation — T003

This separates historical facts from independently reproduced source defects.
T003 investigation/reproduction is complete at this boundary; this does not identify an unobserved provider cause or close the separate remediation and acceptance tasks.
Pinned read-only evidence: [incident-cli-asof-20261105.json](incident-cli-asof-20261105.json).
Operation inspection ends at 2026-11-05T15:00:00Z; journal inspection at 11:47:00Z.
Production rows were not changed. Current snapshots cannot reconstruct missing history.

| Complaint | Proved evidence | Remaining uncertainty |
| --- | --- | --- |
| Ruslan could not obtain/copy a URL; other tabs behaved poorly | Screenshot: generic server-response failure. F01: missing manager storage context could skip the file-attempt producer. Independent regressions proved permission mutation during Get-link, discarded restricted URLs and implicit remembered consent. | No correlated request/HTTP response establishes that historical provider failure or a server-wide outage. URL availability, sharing and clipboard delivery remain separate. |
| Two failed restitch attempts | Operations aa66028f-61ad-4d19-ae79-5f46feee14a7 and d97a7dda-9fe9-4350-a81a-8eec64dd0d65 have native failed terminals, RESTITCH_SCREEN_FETCH_FAILED and only transfer_failed. | Chosen image version, effective settings and original transfer cause are absent. Repeated selection of one image, corrupt bytes, disk exhaustion and global outage are unproved. |
| Catalog download failed in manager and Explorer | Independent regressions established that native Google Sheets require an authorized export, rather than an ordinary media download. Later actual beta exports produced valid workbooks. | The historical screenshot does not identify every affected file/type or HTTP cause. The tested export fix cannot explain every missing download. |
| Share/Get-link failed for the reported team | Beta tests distinguish restricted URL reads, explicit public-grant intent, viewer refusal, lost acknowledgement and clipboard failure. | No correlated historical operation/actor identifier establishes this team's exact cause. New evidence cannot retroactively supply it. |
| Missing manager rows, incorrect command results, partial deletion | F05/F06/F09 independently reproduce dropped invalid rows, malformed counts/booleans treated as no-ops, false accepted counts and lost partial batch state/new keys. | Their existence does not prove each historical complaint followed that path. Future diagnosis needs the actual attempt/item receipts. |

## Executable evidence

Existing suites are extended rather than adding a test that merely repeats this document.

- F01: tests/material-link-diagnostics.test.ts and tests/workspace-operation-analytics.test.ts.
  Actual producer, sanitizer, SQL ingestion and SELECT-only CLI coverage:
  [material-link-implementation.md](material-link-implementation.md) and
  [catalog-bulk-trash-followup.md](catalog-bulk-trash-followup.md).
- F05: tests/catalog-profile-outcome-api.test.ts and tests/catalog-updater-dialog.test.tsx.
  Malformed/partial/valid-empty responses remain distinct; invalid active-round identity
  cannot become an inactive no-op. T012 retains the earlier complete source proof.
- F06: the API/manager suites and tests/catalog-command-postgres.test.ts.
  Genuine zero/false outcomes, immutable receipts and concurrent transaction ownership
  are covered. T013/T024 retain the verified command and Stop boundaries.
- F09: tests/team-explorer-operations.test.tsx, tests/catalog-updater-dialog.test.tsx,
  tests/workspace-mutation-journal.test.ts, tests/team-material-tail.test.ts and
  tests/team-ux-reversibility.test.tsx. PostgreSQL overlap/provenance tests and actual
  API/provider evidence are in [catalog-bulk-trash-followup.md](catalog-bulk-trash-followup.md).
  Persistent single-action Undo, scope and partial companion recovery remain open.
- Native incident join: tests/analytics-team-process-journal.test.ts uses the two
  pinned operation UUIDs. Missing browser terminals cannot erase the native failure
  or prove delivery. T007 retains the committed regression.
- Image classification: tests/agent-screen-cache.test.ts, tests/restitch-screen-decode.test.ts,
  tests/team-bridge.test.ts and tests/agent-screen-recovery.test.ts. See
  [catalog-refusal-round-followup.md](catalog-refusal-round-followup.md) for the
  distinction between source primitives and the still-unwired persistent recovery path.
- Native document export: tests/catalog-export-download.test.ts and tests/team-bridge.test.ts.
  Actual workbook validation is in [manual-beta.md](manual-beta.md) and T009.

The new ESM initialization fault was introduced and fixed during this beta work;
tests/restitch-esm-boundary.test.ts reproduces it. It is not Ruslan's historical
cause. The fresh complete source suite is verification-fast-material-execution.json. Final feature, manual and packaged-beta acceptance remain open.
