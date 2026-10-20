# Implementation and review evidence

Date: 2026-10-18. Scope: compact desktop catalog manager. The owner explicitly stopped mobile testing; no mobile acceptance is claimed.

## Delivered

- A semantic table with stable columns, five independent icon toggles, video first, inline frequency, visible next run and confirmed last success.
- One versioned writer shared by the row and live details. Single-field patches preserve other settings; synchronous locking prevents duplicate requests. Transport failures trigger readback, conflicts show current values, unresolved writes block execution.
- Session undo verifies current value/version before restoring only its field. A newer profile invalidates the old undo.
- Separate quick bulk entry points for video and schedule, explicit Apply, bounded four-request concurrency, mixed values and partial results.
- Manual execution waits for settings confirmation. Mixed selections explain exclusions and can run the eligible catalogs. Unready video has a separate warning and an explicit continuation.
- Full identity and precise schedule timestamps open in anchored inventory surfaces; tooltips attach to the original toggle without adding an interactive wrapper. Keyboard navigation, adjacent-row focus and filter disappearance are covered.
- Existing profiles remain authoritative. No reset, production mutation or release was performed. A later additive dispatcher function migration was applied only to the existing local beta database; details below.

## Independent review history

| Reviewer | Initial code | Second pass | Further pass |  Final |
| -------- | -----------: | ----------: | -----------: | -----: |
| Buyer    |           83 |          94 |           97 | 97/100 |
| Designer |           82 |          91 |      96 → 97 | 98/100 |

The buyer confirmed that runtime facts update even when profile version is unchanged, mixed bulk execution is reachable, unknown writes can be recovered inside details, focus follows the neighboring row, attention includes unready video, and exact next-run time is available without hover. The last minor issue, opening the first unready catalog instead of the first selected catalog, was corrected after that review.

The designer confirmed portal-based identity/tooltips, consistent visible/accessibility labels, stable readiness geometry and identical schedule information in the row and details. Both reviews concern inspected code and one real desktop screenshot, not measured participant success rates or a production release.

## Verification evidence

- Focused regression run: **45/45 passed**, five files, single worker. Includes uncertain response/readback, conflict, duplicate writes, guarded undo, equal-version runtime refresh, immediate schedule changes, manual launch guards, mixed-selection exclusions, unknown-write recovery inside details, neighboring focus after filtering, bounded 500-catalog rendering and read-only diagnosis.
- All static gates passed (format, lint, project/test/script types, design tokens and other registered static checks). Final changed web sources were additionally checked with TypeScript and ESLint successfully.
- The full `npm run verify` completed with **13/14 gates passed**, stopping in suite shard 2/8 on two `tests/launch-state.test.ts` dispatcher regressions. The earlier 039 migration replaced the shared dispatcher and omitted existing Launch settlement/recovery wake-ups.
- Added `20261204110000_catalog_dispatch_preserve_launch_recovery.sql`, merging those wake-ups and housekeeping with the 039 reconciliation guards. **65/65** tests in `launch-state.test.ts` and `team-product-catalog-sql.test.ts` then passed. The buyer reviewed the merge and found no evident functional regression.
- The complete eight-shard suite was **not rerun after this SQL correction**. `verification-result.json` retains the honest failed full-run result. Full-suite success is not claimed.
- After the last keyboard/progress changes, the two affected UI test files passed **36/36**, including the added protection for modified browser/assistive-technology arrow keys.
- Real Chrome desktop screenshot: `/tmp/catalog-icon-review/desktop-final.jpg`. At the inspected 1263×1514 desktop viewport, both existing rows measured 52 px, the list measured 831.55 px high, and no horizontal overflow was present. Exact next-run date/timezone, full identity disclosure and Escape closure were verified in Chrome. No catalog setting was changed through the browser during this implementation.
- The browser viewport override was unreliable; exact 1440/1280 capacity and participant timing targets are not claimed. The owner subsequently restricted testing to desktop. No mobile verification is required for this task.

## Remaining product evidence

User sessions for the novice/buyer timing targets and controlled desktop performance measurements remain future acceptance evidence. The expert scores do not substitute for these measurements. Native browser zoom was restored to 100% and device emulation disabled after the owner narrowed the scope.

## Local beta migration evidence

Applied only the additional function migration using the explicit local `supabase_db_wishly` container, in one transaction. Profile/schedule hashes before and after were identical:

`0b338b4ca786308f5c8e1aed76d28f24|facabfdf1d1cf64e8ec0020bbed2ae22`

No credentials or catalog content were printed. The migration was executed as a local function update; production was not contacted. Normal migration-chain application is still required for another environment.

## Manual video preparation correction

Manual and retry attempts with video replacement enabled must wait for a spare copy, including scheduled catalogs. The manual action starts preparation directly without a readiness confirmation. Scheduled automatic rounds retain their existing fallback. The existing correlated attempt, restitch job stages and CLI diagnosis remain the diagnostic seam. A delivery marker readback is authoritative even if Drive conversion advances the metadata version again; absent markers remain explicitly unknown and are never silently replayed. Reconciliation status takes priority over running and past failures in the compact row; error detail stays in history. Desktop verification only.

The updater now resolves and registers its generated destination through the same ensure-folder handler as catalog creation. Previously the Drive folder could exist without a material row, causing process-start `NOT_FOUND`. Local beta migration is applied additively without reset. Existing inconclusive writes retain their reconciliation hold until provider readback proves delivery or unchanged state.

Read-only `analytics catalog <id>` now includes current video queue state, failure code, retry time and lease expiry. Local beta diagnosis verified the projection end to end. Historical pre-claim stage history remains an explicit blind spot.

Independent correction reviews found and fixed a legacy global restitch gate in claim, heartbeat, output acceptance, queue creation and spare retention. The lifecycle now uses the frozen active attempt; sync derives the browser preparation flag without changing default_restitch. A full SQL regression passed with the global flag forced false and the future profile edited while the attempt remained active. UI review confirmed one mutually exclusive row outcome, actionable terminal results and no duplicated last-result badge in the last-success column. Blocked detail now links to space restitch settings. UI, worker, preparation-route and diagnostic regressions passed; repeated broad verification is not claimed. The 500-row UI case needed a larger per-command timeout under concurrent local-stack startup, and passed on its targeted rerun.

### Screen transfer and truthful preparation status

Screen grants crossing the browser boundary now use the configured public Functions origin, matching source-video transfers. The server endpoint builder also preserves the public prefix and forwarded port. Regression evidence: five endpoint cases and two claim handoff cases passed. Local preparation failures retain the closed `RESTITCH_SCREEN_*` codes through the process bridge and HTTP boundary, with diagnostic code locations; provider exceptions remain redacted. The process/privacy and code-map cases passed 34/34.

Pending rows distinguish queued preparation, active preparation, and a failed preparation with actionable details. Only the current authoritative readiness state chooses the message; an old failure cannot replace a currently leased preparation. Failed pending work is actionable and counted in attention. All 31 dialog cases passed across the initial 29 passing cases and two targeted timeout reruns; the three new pending-state scenarios and direct manual start passed. Real desktop rendering shows a compact row without the former stacked banners. End-to-end Drive completion remains unproven until the live attempt records confirmed delivery.

### Confirmed desktop beta delivery

The manual attempt `75eeba1a-5f4c-4461-9244-d05468be28c8` for the test catalog completed at `2026-10-18T18:51:05.535Z` with result `success`, `delivery_proven: true` and `actual_changes.videoReplaced: true`. It traversed preparing, refreshing, building, uploading, verifying and finalizing. Chrome displayed the confirmed last-success time (21:51 Europe/Kiev). This proves on-demand preparation plus sheet delivery; it is not a controlled latency benchmark. The beta database and existing configuration were preserved.

Finalize recovery retries the same uploaded file at most three times, without re-uploading or creating another operation. Seven retry/grant regressions passed. The additive usable-spare correction rejects deleted or unshared prepared files consistently in queue, claim and readiness; two SQL lifecycle regressions passed and the correction was applied only to the local beta. Idle background preparation failures now explicitly refer to the next video, preserving the previous successful result; its regression passed. Long empty-success text and the recursive instruction to open details while already in details were shortened.

Source transfer recovery is also bounded: at most four replays of the current Range, with partial bytes truncated before replay, identity/size pinned, and no completed-range progress reported early. Existing grant headroom is preserved and remaining uses are reserved for ordinary ranges. Exhausted transport failures surface as `DRIVE_UNAVAILABLE`. The combined transfer/code-map run passed 45 cases; the subsequent exact-budget regression passed separately. Agent compilation, targeted lint, design tokens and formatting were checked. No full verification-suite success is claimed for this correction.

### Immediate dispatch and final independent reviews

The additive `20261204150000_catalog_immediate_manual_dispatch.sql` wakes the existing durable dispatcher after an accepted manual round and after a ready spare is recorded. A failed wake-up does not roll back either result; periodic dispatch remains the fallback. Its SQL regression passed, including duplicate acceptance and dispatcher failure. Applied only to the local beta, without reset.

The final ready-spare manual attempt `67e56696-fc9b-4877-b440-a0537ea480c9` completed from `2026-10-18T19:05:43.697Z` to `2026-10-18T19:05:50.535Z` (**6.838 seconds**), with `success`, `delivery_proven: true` and `videoReplaced: true`. The preceding comparable live attempt took 41.375 seconds. These are individual measurements with a prepared replacement, not a promise for cold preparation or bulk load. The updated local agent separately completed preparation and upload for operation `f8faa4f4-2c66-47b2-94ae-8c5ad2226898` at `2026-10-18T19:04:07.423Z`. Chrome showed confirmed last success at 22:05 Europe/Kiev; final screenshot: `/tmp/catalog-final-confirmed-desktop.png`.

Independent final assessments for this corrected desktop journey: buyer **97/100**, designer **97/100**, with no remaining concrete blockers identified. These bounded expert reviews and focused regressions do not substitute for participant research, bulk-load measurements or a full release verification run. Beta remains open, and existing workspace data and schedules were preserved.

## Confirmation clarity and creation periods (2026-10-19)

The write/reconciliation flag is raised before an ordinary Drive mutation, so it cannot alone mean failure. While the latest attempt is running, the row shows a muted confirmation check, explains automatic verification, and does not count as attention. A completed unknown result stays distinct and actionable, retaining its reason and duplicate-write guard. The details poll every five seconds while reconciliation is active, permit only one in-flight read, ignore obsolete effect responses, and refresh when checking ends. Actual terminal failures retain their error and completion time. All enabled settings share the secondary accent; video no longer uses warning colors.

Creation dates come from `team_product_catalogs.created_at`, not the source video or last update. Dates include the year inline without another row. The calendar beside filters supports inclusive local from/to days, either open bound, an older-than-30-days preset, clearing and oldest-first sorting. Filtering precedes pagination and searches all loaded rows; changes reset the visible-page budget and preserve existing selections. Unknown creation dates remain visible without a date filter and never match an active period.

Diagnostic coverage reuses the correlated catalog-manager filter lifecycle: opened → result_visible → completed with visible count and the closed setting name `createdAt`. Date bounds and catalog content are not collected. Empty results are a successful filter outcome; missing browser completion remains unknown. Registry read failures use the existing READ_FAILED seam. Beta intentionally does not emit production analytics.

Verification: five focused files passed 57/57 cases, covering active checking versus unresolved outcomes, eventual successful details, retained failure reasons, single-flight polling, creation filtering independent of last-success dates, local timezone boundaries, inclusive end dates, open/reversed ranges, calendar selection and clearing, and diagnostic payload bounds. Chrome desktop verified actual calendar selection, empty result and clearing; enabled video shares the same accent as other toggles. No mobile checks or new catalog writes were performed for this correction.

### Calendar simplification (2026-10-19)

The owner requested the standard shared range calendar only. Removed native From/Through date inputs (and therefore the browser date picker nested over the app calendar), and removed both footer buttons: older-than-30-days and clear. A completed period is chosen directly in RangeCalendar, as in Tasks. Clearing remains the compact X on the active filter chip. Updated the calendar and parent integration regressions to select periods through the shared calendar rather than removed inputs.

### Stable desktop geometry (2026-10-19)

Dialog geometry now uses a permanent `catalog-manager-dialog` class instead of the presence of a table. Tokens set a 1240px × 680px desktop box, capped by the available viewport; the list owns overflow with a stable scrollbar gutter. Loading, empty results and populated results use the same geometry. Chrome at a 1280×720 desktop viewport measured width1240,height680,x20,y20 with two rows, with an empty creation-date period, and after clearing the period. Geometry was read from the visible DOM in all three states. Final screenshot after restoring the normal viewport: `/tmp/catalog-manager-fixed-size.png`. The temporary viewport override was reset. Design-token and formatting checks passed; no mobile tests or catalog mutations were needed.

### Calendar schedule persistence — 2026-10-19

Backend implementation: additive migration
`20261204160000_catalog_calendar_schedule.sql`, shared `CatalogUpdateSchedule`,
atomic versioned schedule/interval patch, civil-time next-run calculation and
schedule-aware dispatch. No beta reset or production mutation is part of this
work. The raw profile RPC appends nullable `schedule`; the patch response returns
the same object. Legacy profiles may omit it and legacy schedules remain null.

Automated evidence: four focused SQL scenarios cover Sunday 18:00 Europe/Kyiv,
correct UTC conversion, daily/weekly spring-gap and autumn-fold behavior,
explicit hourly anchor advancement, null-schedule compatibility, saved/read-back
values, stale/null version refusal, invalid inputs, permissions, boolean/manual
preservation and the next scheduled dispatch with a frozen schedule snapshot.
Analytics regression distinguishes a current Sunday 18:00 schedule from an older
attempt's Monday 09:00 schedule without collecting content or paths. Final beta
save/reopen and browser preview evidence are pending integration; unit evidence
alone is not a claim of that live path.

### Schedule panel live acceptance and compact scale — 2026-10-19

The reference panel was implemented and visually approved by the owner; the owner's follow-up requested a proportional 25% reduction. One scale token now renders the same content at 75%, including text, controls and spacing. Chrome measured 330 × 307.88 CSS px (previously 440 × approximately 410); the catalog manager remains 680px high. Open-panel evidence: `/tmp/catalog-schedule-compact-final.png`. Desktop only; no mobile checks.

Local beta received migration 160000 additively without a reset. Through the UI, the weekly Sunday schedule was saved at 18:00, then reopened after a source reload with Sunday 18:00 retained and the row/preview both showing 25 October 18:00. The original 18:02 clock was then restored, confirmed saved, and reopened with Sunday 18:02 retained. Manual-run due-time preservation is covered by the SQL regression rather than an additional live content update.

Verification: SQL 4/4; analytics 2/2; the integration run passed 52/54, with the two remaining cases subsequently resolved (500-catalog timeout by gating closed-picker Intl work; custom-input test updated to clear its default). The 500-catalog regression passed on rerun and the final focused picker/dialog run passed 14/14 selected cases. The picker suite then passed 6/6 including a new peer-change conflict guard. Web TypeScript and targeted ESLint passed; design-token/Tailwind gates and diff whitespace checks passed. Full repository verification is not claimed. Schedule changes reuse the correlated catalog profile flow and preserve readback, version conflict and undo behavior.

### Fixed schedule-panel geometry across modes — 2026-10-19

A fixed 308px panel height and a fixed form grid now reserve the fields, feedback and footer slots in every mode, including empty hourly fields and custom intervals. Feedback errors occupy the existing feedback slot; additional fields scroll inside their slot. Chrome exercised daily → weekly → custom → weekly → hourly → weekly without saving. Every state measured 330×308px at the same x/y; Save also retained identical coordinates, ending 13px above the panel bottom. Screenshot after returning to weekly: `/tmp/catalog-schedule-fixed-modes.png`. Existing saved off-state was preserved. Picker regressions passed 7/7, including the mode cycle. Design-token and whitespace gates passed. No mobile tests.

### Schedule readability adjustment — 2026-10-19

Owner requested 10% enlargement of the whole panel after the fixed-size correction. Scale increased from .75 to .825; fixed height from 308 to 338.8px and measured width from 330 to 363px. Custom interval labels and numeric input now use the section type token and the input uses the XL control height, improving readability beyond the global enlargement. Mode geometry remains fixed; no persistence logic changed.

### Custom interval correction and next-run preview — 2026-10-19

Custom interval labels/input were returned to the standard body type and large control height, matching other fields rather than the oversized section type. Panel dimensions remain 363×338.8px. Hourly/custom drafts now show an elapsed-time next-run preview; an unchanged saved interval retains the server nextRunAt. Invalid intervals have no invented next run. Chrome confirmed 6 → 8 → 6 hours updates the preview, without saving. Picker suite passed 8/8, including saved-due retention and invalid-value coverage; token checks passed. Evidence: `/tmp/catalog-schedule-normal-next-run.png`.

### Time-arrow first-click correction — 2026-10-19

The time arrow is now an accessible button with a distinct label. Its first click focuses the time input and calls showPicker in the same user gesture; the hidden native indicator no longer intercepts the arrow. A regression starts without input focus and asserts one picker call and focus transfer. Picker suite passed 9/9; targeted ESLint, token and whitespace gates passed. In Chrome, reopening the panel then clicking the arrow directly moved focus into the native time list without clicking the time digits first. Evidence: `/tmp/catalog-schedule-first-arrow-click.png` (native widget options are exposed by accessibility rather than the tab screenshot). No schedule was saved.

### Stable save feedback and tooltip anchors — 2026-10-19

Profile saving/saved feedback is a 16px spinner/check in a permanent 20px slot beside the catalog name. The extra feedback text row is removed for these phases. Recent-history trigger/count and a 52px Undo footer slot remain mounted, so saving does not change toolbar/list space. Update/Undo keep native disabled/locking semantics while transient setting saves retain normal opacity; unknown writes, reconciliation and actual update work retain their existing disabled presentation.

Shared Tooltip now merges trigger/child/anchor refs, closes on press, and mounts only for a connected anchor; catalog tooltips are suppressed while settings save. Legacy tooltip CSS positioning/translation was removed in favor of HeroUI positioning.

Browser: the link variation setting was toggled off/on twice and restored to its initial on value; original schedules were preserved. Before/after all sampled x/y/width/height values were identical: manager 680px, row 56px, name/actions 38px, toolbar 70px, Undo slot 52px. Update/Undo showed opacity 1. Keyboard navigation showed exactly one tooltip: images at x545.5,y586.05 beside its x611,y614.20 anchor, then text settings at x569,y586.05; Escape removed it. No origin-positioned tooltip appeared. Screenshot showing the inline saved check: `/tmp/catalog-stable-save-feedback.png`.

Verification: Dialog 35/35 tests passed, including two deferred consecutive writes with stable status/history/footer nodes and preserved disabled guards; Tooltip 4/4 passed (merged refs, native click close, rapid neighboring hover/pending suppression, generic keyboard focus/Escape). Web TypeScript, targeted ESLint, design tokens and whitespace checks passed. No mobile tests or production changes.
