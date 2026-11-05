# Manual beta acceptance — implementation checkpoint

Status: ordinary file/link, single-profile and two-catalog bulk Undo walkthroughs passed on macOS Safari.
Full feature acceptance remains open.

Owner requires manual beta testing after implementation and automated checks.
This checkpoint covers reliability changes through `c9e05c5e`; it is not the
full 047 acceptance, packaged promotion or production approval. Video sets,
delayed publication and the complete same-click screen replacement protocol
remain open in `tasks.md`.

## Environment and preserved state

- Real local beta authentication and entitlement keys; local-dev auth is false.
- Local Supabase project `r2beta045`, on loopback only. Its previous ownership
  journal belonged to the older isolated checkout; all recorded application
  and owner PIDs were absent. No unrelated application was stopped.
- All 411 applied migration histories matched candidate source statements.
  Seven pending files matched the successful full disposable PostgreSQL proof.
- The previous Edge runtime was stopped before applying those seven files with
  installed Supabase CLI 2.115.0, `migration up --local`. No remote target.
- Schema definitions were preserved privately. Counts and row digests of 13
  profile/connection/credential/material/catalog tables matched before and after
  migration. No acceptance profile or database was reset.
- The old invocation was reconciled with its own `beta:down`; the candidate is
  being started with `beta:up`. The only temporary source override is the local
  Supabase project ID, `wishly` → `r2beta045`, to reuse that connected database.
  This explicit override does not constitute a clean exact-SHA package proof.
- Original beta settings were backed up privately. Credentials and raw profile
  state are excluded from this report. Previous dirty source files were retained.
- Two starts on the default 2-GiB / 2-CPU Docker VM failed the service health
  gate. The first used automatically resolved CLI 3.0.0; the second used a
  candidate-local CLI 2.117.0 link. Both were reconciled with `beta:down`.
  These failures are retained privately and are not relabeled as successful runs.
- An owned Colima profile, `soty-beta-047`, was created with 4 CPUs and 4 GiB RAM.
  The global Docker context remained `colima`; its unrelated running project was
  not stopped. Ten official cached image IDs were copied and verified. The offline
  beta PostgreSQL and Storage volumes were streamed into new owned volumes; source
  volumes were not changed and credentials were not written into a tar artifact.
- Canonical `beta:up`, with only the owned local Docker endpoint selected in its
  invocation environment, passed readiness in that VM. All serving services were
  healthy. `/health` proves beta channel/environment, source `c9e05c5e`, ready
  FFmpeg/FFprobe and no active native work; `manual-beta-runtime.json` retains it.
- After startup 11 protected table digests still matched. The connection and
  credential tables changed during runtime; the digest baseline cannot establish
  their per-column delta. Both connections report connected without an error,
  all seven Vault secrets decrypt, and the existing browser session worked.
  No reauthentication or profile reset was needed.

## Automated evidence preceding the walkthrough

- `verification-fast-scope-cancel.json`: 14/14 gates, 8807 passed tests, 60 skips.
- `verification-db-scope-cancel.json`: 46 pgTAP files / 1064 assertions;
  2 Auth clock and 37 native concurrency tests. Disposable instance removed.
- Actual provider XLSX export/public-link results are recorded separately in
  `provider-acceptance.md`; those are API evidence, not manual UI acceptance.

## Manual observations — 2026-11-05

All UI actions below were performed in a fresh Safari window using native controls.
Browser automation access was unavailable; no mocked transport or fake auth was used.

1. The retained member session opened the workspace and the manager. All profile
   toggles were read-only with an explanation. Signing out and using the existing
   beta-owner login authenticated through the local stack; owner controls appeared.
2. The manager loaded 38 catalogs, two scheduled and two needing attention.
   Searching for the existing QA fixture narrowed the table to the intended row.
3. Its random-link option changed On → Off with visible Saved and Undo. A local
   SELECT confirmed version 2 / false. Undo from Recent changes restored On;
   another SELECT confirmed version 3 / true. Scheduling stayed off.
4. Update history for that fixture displayed a genuine empty history; closing it
   returned focus to that catalog's action menu. Keyboard navigation reached the
   frequency and action controls.
5. Manager → Download saved a real `.xlsx` file. Show in folder navigated to the
   same catalog in Explorer; Explorer → Download saved a second file. Both are
   71,109 bytes, pass ZIP CRC and workbook/worksheet XML parsing, and contain 402
   rows with values (1,000 formatted rows, 31 cells in the first row). The source
   is a native Google spreadsheet, so this exercises export rather than alt-media.
   File hashes and timestamps are retained in `manual-beta-downloads.json`.
6. Explorer → Copy link displayed a persistent selectable URL. Copy showed a
   confirmation. Pasting into a fresh Safari address field matched the displayed
   URL exactly; following it loaded the expected Google Sheets document.
7. Manager → Share also displayed the URL. Its Open button opened the expected
   Google Sheets document. Escape returned to the beta manager. Before Share,
   an anonymous read had already downloaded valid XLSX from this existing public
   QA fixture; this walkthrough reused access, without broadening permissions.
   Fresh permission creation is separate real-provider API evidence in
   `provider-acceptance.md`, not claimed as a manual UI creation test.

## Additional source-beta walkthrough after focused checks

The following changes were tested on the running source beta with HMR, after the
117 focused controller/inline/bulk/dialog/chip/ingestion tests passed. These
observations include the working diff after `c9e05c5e`; the agent health snapshot
still identifies its unchanged running source revision. They are not a clean
packaged-beta promotion proof.

- Selected only QA video catalog variants 35 and 36 in the manager, opened Configure,
  changed only Random link variation On → Off, and saved. Both visible rows changed,
  with "Збережено каталогів: 2" and an Undo saved changes button.
- Pressed that button. Both rows returned to On; the editor showed
  "Налаштування відновлено: 2" and separate expandable per-item outcomes.
- Closed the editor, changed variant 36 once, opened Recent changes, and undid the
  last entry. The Recent dialog closed automatically, its count returned to zero,
  and native Safari focus returned to the variant-36 random-link control, showing On.
- A local SELECT after these UI actions confirmed variant 35 at profile version 3,
  variant 36 at version 7, both random-link values true, restitch false and update
  interval null. Thus the test restored the initial effective options and did not
  enable a schedule or start provider processing.
- Lost replies, foreign-version conflicts, pending cancellation and failed Undo
  preflight are controlled regression evidence; no manual network fault injection
  is claimed by these ordinary successful UI actions.

## Calendar smoke after the full verification run

After `npm run verify` passed all 14 gates (8,824 tests, 57 explicit skips), the
same source beta was tested again through native Safari controls on 2026-11-06
local time (2026-11-05 22:27 UTC). No application code changed between that run
and this smoke.

1. Selected QA variants 35 and 36, opened Auto update, used the native time field
   to draft Daily / 23:59 / Europe/Kyiv, and saved both settings.
2. Both visible rows showed Daily / 06.11, 23:59 and Saved 2 catalogs. A local
   SELECT confirmed the complete schedule tuples, versions 4 and 8, interval
   `1d` and UTC next due `2026-11-06T21:59:00Z` for both rows.
3. Pressed the new Undo saved changes button. Both rows showed Off and the
   editor reported Settings restored: 2. A fresh SELECT confirmed versions 5
   and 9, null schedule/interval/next due and the original unrelated options.
4. Closed the editor without a discard prompt, cleared selection and closed
   the manager. The workspace chip again showed its original two scheduled
   catalogs. Neither QA schedule became due during the test.

The bounded before/saved/restored evidence is `manual-beta-calendar-undo.json`.
The full verification result is `verification-fast-bulk-undo.json`. The existing
PostgreSQL replay proof covers the unchanged migration chain; no new migration
was added by this UI/controller increment.

A separate local readiness check found two older catalog leases blocked by
`previous_operation_open` (one open operation each), and no native restitch
leases. This smoke does not prove those previous operations completed. They
were not stopped or replayed to simulate an outage.

## Findings for the continuing polish work

- Fixed after this observation: the last Recent change now closes its dialog after
  confirmed Undo and returns focus to the affected row control. Repeated manually
  on the running beta after the change; the control showed On and held focus.
- Fixed after this observation: the workspace chip explicitly labels its scheduled
  subset. The live Ukrainian accessibility label now says "Каталогів за розкладом: 2".
- Safari's accessibility tree exposed underlying page controls after a nested
  overlay closed while the manager remained open. Keyboard focus returned to
  the intended row menu; background accessibility isolation needs a regression
  before claiming the full accessibility matrix.

Fault injection, Windows parity, clipboard denial and the remaining A01–A26
matrix are not inferred from a successful ordinary walkthrough.

## Code review follow-ups outside this checkpoint

These remain open; this walkthrough is not full feature acceptance:

- A newer settings acknowledgement without a runtime observation can discard
  older proven runtime metadata in the inline cache. Two targeted regressions
  and a merge correction are prepared separately, not applied to this checkpoint.
- New schedule previews still use the computer clock; the available server clock
  offset must reach row/detail/bulk pickers. Ordinary correct-clock beta smoke
  cannot establish skew handling.
- The legacy two-argument Stop RPC lacks the new observed-round wrapper's
  reconciliation check. Compatibility coverage must fence that older entry too.
- MaterialActionHost's pre-existing copy/share path always sends
  allowIfRestricted=true. Restricted-link inspection and explicit public-sharing
  consent need to be separated. This manual share fixture was already public,
  so no permissions were broadened by the walkthrough.
