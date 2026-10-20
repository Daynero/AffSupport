# Independent beta review loop

Local beta only. Scores belong to the independent reviewers; implementation does not assign or round their scores. Acceptance requires **both scores >96**, not merely their average.

| Round                    | Buyer  | Designer | Decision                                                           |
| ------------------------ | ------ | -------- | ------------------------------------------------------------------ |
| 1                        | 45     | 68       | Fix and repeat                                                     |
| 2                        | 88     | 86       | Fix and repeat                                                     |
| 3                        | 97     | 90       | Fix and repeat                                                     |
| 4                        | 98     | 94       | Fix and repeat; scale concern remains                              |
| 5                        | 92     | 95       | Fix focus drift and mobile grid; sources differed by the focus fix |
| Designer6                | —      | 97       | Observed UI pass; superseded by later mobile parity defect         |
| Designer7                | —      | 95       | Fix mobile inline-editor clipping                                  |
| Final buyer6 / designer8 | **97** | **97**   | Both >96 on the same final application source                      |

## Round 1 corrections

- Accept PostgreSQL composite lifecycle version `0` as a safe version; prevent repeated submission of social creation.
- Keep newly created active РК visible while finance snapshots refresh.
- Give the table its own vertical/horizontal scrolling; pin captions to that scroll container.
- Compact narrow-screen period controls and add focus scroll clearance.
- Replace UUID drag announcements with localized names and ordinal positions; announce saved order only after confirmation.

Round 2 independently confirmed these corrections and the five-РК morning workflow, exact two-day writes, current-day totals, clipboard payload, archive retention, restore and order persistence. See each review for limits.

## Round 2 corrections

- Constrain the unified panel's grid track with `minmax(0, 1fr)` so internal table and summary overflow cannot widen the page.
- Count/filter only effective active РК in operational occupancy and marker controls. Keep dated archive rows and their financial values in All.
- Attach sortable accessibility attributes to the dedicated grip rather than the whole row. Whole-card pointer activation remains configured separately, so disabling sorting cannot disable history or copy controls.
- Use the current reorder callback for repeated keyboard moves, including fresh scope versions.
- Correct lifecycle diagnostics to classify the actual committed period projection rather than raw archive-inclusive overview data.

## Test environment observation

Rebuilding the shared package while Vite beta tabs were active triggered an HMR-only `useAuth must be used inside AuthProvider` failure. Fresh reload restored authenticated beta. Heavy verification and interactive reviews are now sequenced. This observation does not establish that a packaged beta has the same failure or waive a persistent fresh-load failure.

## Round 3 results and corrections

Buyer independently scored **97/100**; designer **90/100**. Acceptance is still open because each reviewer must exceed 96.

- Buyer confirmed archived-account history remains interactive, explicit historical correction preserves today's totals, zero/no-data archive boundaries work, parent restoration preserves independently archived children, and a run change preserves manual order.
- Designer reproduced remaining document overflow at 390 px and an offscreen dirty Save action. Native Chrome 200% zoom reproduced the same narrow-layout issue.
- Corrected the sticky area's inner grid track, wrapped the summary, put Save/Cancel first, moved narrow-screen copy actions into the existing More menu, constrained date controls, and wrapped the search toolbar into separate rows.
- Resolved human-readable account names for history/correction instead of an empty history prefix or internal UUID, and centered newly focused creation inputs below the sticky controls.
- Focused regression after these changes: 3 files / 58 tests passed (`scratchpad/038/round3-focused.log`). Browser validation and round 4 scores remain pending.

The 50-social / 500-РК / 2,500-run local stress fixture is seeded separately from reviewer workflow data. Its existence is not a measured frame-time or touch-device pass.

## Round 4 results and corrections

Buyer confirmed the corrected human-readable history/correction labels, centered creation input, narrow-screen Save/Cancel and both complete copy formats. Designer confirmed no page overflow at390/768px and native200% zoom, reachable Save and both actual clipboard actions. See the independent reports for exact scope.

Designer then encountered browser/extension/native-control timeouts after the500-РК fixture loaded. The correlation is concrete; an application-specific root cause and frame timing were not established. The score remains94 and acceptance is open.

- Added viewport-based deferral for expensive offscreen РК controls in workspaces above100 dated rows. Social headings remain mounted, opened/collapsed state is unchanged, placeholders retain measured variable height, and focus/editing/active RK drag pin their group. Dated drafts remain in the existing parent controller. A browser without IntersectionObserver retains the full rendering fallback.
- Preserve the captured social heading's viewport offset when its rows temporarily fold and unfold. This still requires real gesture review.
- Disambiguated the compact general Actions menu from the selected-day clear menu.
- Connected lifecycle save resolution to independent financial attempt IDs within one flow. A partially successful save now records partial with the actual closed failure code and cannot enter archive preflight. CLI diagnosis separates parent and child attempts; a successful child cannot overwrite a failed parent.
- Pinned the financial timezone while drafts or saves are pending and added an explicit context-change message. Local23/25-hour DST transitions and dirty zone changes have targeted regressions.

New control/deferred tests validate rendering and state boundaries in JSDOM; they do not establish pointer timing, real touch behavior, or500-РК frame-time acceptance. Round5 UI validation is pending.

## Round 5 results and D9 correction

Designer independently confirmed the500-РК workspace is interactive with50 expanded social headings and bounded row controls (10 initially,20 around the far group). A value42 survives offscreen unmount/remount; Enter remains within its social's column.

A real CDP pointer gesture on the small local fixture captured a social after650ms, temporarily folded all five socials, moved through a pointer trajectory, persisted a changed order and restored the original mixed fold state. Reduced-motion emulation and keyboard Space/Escape also worked. This is real gesture evidence, not a JSDOM manager mock. Exact500ms feedback latency and frame p95 remain separate measurements.

D9: keyboard focus on far group50 could become offscreen after deferred group49 grew from its estimate to its measured content height. Added a shared table focus guard: after deferred measurements settle it reveals the actual focused control inside the table below sticky captions, preserves horizontal scroll, and releases on explicit wheel/touch/pointer/page navigation so intentional scrolling is not undone. New focus guard5 + deferred4 + lifecycle6 + social controls4 regressions passed (19total); web typecheck and scoped ESLint passed. Independent R6 verification is pending.

Pre-R5 static checks passed12/13; only a newly added test file needed Prettier. After formatting that file, the standalone full format check passed. The canonical full runner result remains a recorded failure until its next complete run; it has not been manually replaced.

## Mobile parity follow-up (buyer5 / designer7)

Buyer5 independently scored92 after confirming the root's screenshot/source concern: legacy mobile card grid areas remained active beneath the new six-column grid. Finance occupied an implicit extra row (identity y1668.7 versus finance y1947.1 at390px). Successful parity checks included social/RK rename, public-fixture2FA copy/countdown/clear, tag dictionary assignment, run assignment/edit, daily values, clipboard grouping, monthly totals and dirty navigation guard.

Fixed normal rows with explicit six-area placement at every viewport and separate three-area inline editors. Designer7 confirmed normal-cell centers differ by only0.0039px at390/768/1000/1440, with document width equal to viewport. The standalone layout check now asserts cell alignment and uses actual fixture content rather than replacing DOM text.

Designer7 scored95 because the inline editor could grow a launch input to613px inside a324px scrollport, hiding typed text. Capped narrow-layout inline fields with existing spacing tokens, removed an obsolete identity-column scroll inset, and added fitting-control horizontal focus reveal inside the table. Intentional wheel/touch/pointer navigation still releases the guard. Ten focus/deferred regressions, web typecheck and design-token checks passed. Designer8 and final buyer6 verification are pending; earlier97/98 scores are not substituted for this final source batch.

## Final independent review closure

Buyer6 and designer8 each scored97/100 after the final fixes, on application hash `f4d8f8141cc680aa097888f24dd9b05ca5e1c305fa3fb3f9efa95757f9ef2f89` (94-file working-tree manifest `cb9a6e7026ff8b1a4dcf6b2ae7c7469edba33abc5e5c61241e4814da53bdc1f3`). Both reviewers reset viewport overrides and closed their own tabs before repository verification began.

- Designer8: normal-row alignment, bounded mobile inline fields, readable typed text and clear control, retained caret after clear, Save/Cancel, social rename/2FA field bounds. Earlier real500-РК focus/draft/scroll, pointer social reorder/fold restore and reduced-motion observations remain applicable.
- Buyer6: actual390px one-row geometry, balance save, corrected RK tag context, archive retaining financial/run history, exact complete clipboard grouping, and actual downloaded daily/monthly XLSX ZIP/XML including archived values. The browser download-event bridge had missed real files; that earlier timeout is not classified as an application export failure.
- The numeric review threshold is satisfied. It is **not** a certificate for the separate continuous-rAF SC004 criterion. Trace observations, unavailable read-only timing APIs, real-touch/platform gaps and per-inventory limits remain explicit in the reports and quickstart. Repository runner gates are recorded separately and still pending at this entry.

## Final retained-period correction — buyer7 / designer9

The source audit after buyer6/designer8 found concrete parity omissions: monthly matrix, summary, top-up statement, report-day return context and spend/topup total copy were unreachable from the unified replacement. These were implementation gaps, not merely missing tests.

- Restored these views inside a secondary period-details modal using the existing `MonthlyFinanceSummary`; the unified main table remains mounted, with no Accounts section tabs added. Day drilldown and return remember exact custom/month range and selected report view; matrix scroll and focus are retained. Fixed the monthly anchor so repeated Previous period advances October→September→August rather than repeating one month.
- Added confirmed-total copy controls with dirty/pending/source guards, clipboard-denied handling and bounded content-free diagnostics. Amounts are clipboard content only. Modal applied proof follows the committed view; clipboard proof does not claim downstream delivery.
- Designer9 found the new modal lacked an explicit touch close action. Added the standard footer Close button; actual320/390px clicks succeeded. Narrow view tabs remain horizontally scrollable, with a small discoverability cost; the third statement view was actually reached and read.
- Buyer7 and designer9 independently scored **97/100** on application hash `268d80cc43fe6b7e7fcb28824f1deb022fe10d6a983a8febd7466145663e6080`,95-file manifest `ea4c26d1e7dabd8863160d037eb47db19c7f1af80abd0cbd01397838a2069a19`. Both used actual month/custom-range drilldown/return and clipboard; their addenda preserve prior report limitations. See [buyer7](buyer-round-7.md) and [designer9](designer-round-9.md).

Verification ledger: the preceding canonical full-fast run was deliberately stopped before the parity fix and is **not** a successful full-suite result. Subsequent static gates passed13/13 in144seconds. Focused single-worker period-parity6 + social-order5 + preferences3 passed14/14 in17.46seconds, including matrix scroll/focus, dirty return guard, denied copy and decoration accepted-versus-postcommit-visible proof. The fresh canonical full-fast run (root session91312) is in progress at this entry; release follows serially. No full-fast/release success, hardware repeat or continuous-rAF performance acceptance is inferred from targeted checks or reviewer scores.

## Final independent closure after bundle and diagnostic corrections

The later full-fast failure exposed genuine download-budget and suite inventory
issues. The corrected feature uses conditional Launch editor/session loading,
best-effort031 diagnostics, official supported-locale optimization and explicit
manifest-based038 download allowances; old performance/coverage baselines remain
unchanged. See [budget evidence](bundle-budget.md). Critical account state
contracts now have80 passing cases and100% focused coverage.

Designer10 found mobile Refresh sources compression in the existing Launch
editor. Root stacked its header/action at the existing mobile breakpoint; actual
320/390 EN/UA retest closed the finding. Designer10 scored97/100. A fresh buyer
with no implementation authorship independently exercised daily finance,
clipboard, RK/social archive/restore and monthly navigation and scored97/100.
Both reviewed application hash
`f0ff240c19c87564ecb524618049621a91a2be686c72c9b45ae115b6de5f99aa`.
Each exceeds96. Their reports retain honest hardware/performance/empty-existing-
Launch-session limits. Full runner results remain separate acceptance evidence.

## Canonical verification closure

Final fast14/14 gates passed (5898tests,12skipped). Release coverage initially
identified six live-file test gaps plus a stale record for the pre038-deleted
TaskAssigneeFilter. Added real missing behavior/error/retry tests; retired only
that deleted record with machine-verified unchanged live thresholds/globalfloor.
The historical dirty-restore test now controls its real500ms autosave boundary.
Final release passed22/22 gates,5926tests,12skipped,76.69% coverage, including
database/build/contracts/accessibility/browserCSP. Exact canonical outputs are
linked in [final verification](verification.md). The local test-role grant was
restored exactly. Reviewed application hash remains unchanged; hardware/frame
limits and expanded matrix partials remain explicit.

## Owner compact-layout correction — 2026-10-18

The owner rejected the prior97/100 UI. Its reviews and release result are historical and do not establish acceptance of this revision.

- Replaced the four-field morning row with selected-day balance/topup/spend, removed dates from column headings and repeated row labels, compacted ordinary rows to44px, and moved History/Archive into More menus.
- Removed the text-only custom drag overlay; the library's default Feedback lifts the complete original source with its original layout and pointer grab point.
- Added bounded scoped prepared day snapshots: commit the new date only after validated data is ready, preserve keyed input nodes, and restore the visible row before paint. Stale team/user/permission requests cannot replace the current data.
- Independent compact buyer round1 scored8.8/10 and found a real bottom-boundary defect: shorter historical membership clamped scrollTop, shifting retained rows132.5px. The correction retains the list canvas with start-aligned grid content before switching, without inventing historical rows.
- The first current static gate run found a More-button ref/anchor type mismatch; corrected to the existing UI IconButton and RefObject anchor. The second canonical static run passed13/13 gates in175seconds. Current three-role Beta review is pending and must finish at>=9.9/10 for each role.

### Compact second correction

The buyer's second review earned9.9/10 with five actual day transitions and exact0px retained-row deltas at the bottom boundary. The designer then observed an outer-window199px movement under locator clicks and phone input content compressed to24px. Native-coordinate retests later showed that locator auto-scroll before the application handler contributed to the reported window movement; it is not retained as proof of a native application defect. The next correction freezes the account-space canvas, captures/restores outer-window position before paint, keeps date controls enabled during preparation to retain focus, and gives three money fields a full-width row below identity/actions at<=560px. Fresh source acceptance remains pending; the interaction reviewer has proven unchanged full-source dimensions/content/grab point with actual500ms holds but has not yet certified translated pointer movement because the browser bridge rejects raw CDP during a paused response. That restriction is not bypassed and incomplete checks are not reported as passes.

The latest buyer round3 again earned9.9/10 on `5ec8f4…`: native day clicks preserve outer234px and inner371px/0px with exact0px retained-row deltas. Designer round2 confirmed stable native day switching and82px phone input content, then found a vertical98px phone action stack; the final phone correction places its three30px actions inline. Interaction round2 reproduced actual keyboard-movement cancellation corrupting social header ownership (zero headers in one group, two in another). The fix uses the standard library split: sortable element is the whole social section, feedback source is its original header. A new regression verifies sibling-wrapper registration and header ownership after DOM movement. Current focused tests pass35/35; independent designer/interaction closure and complete suite are pending.

### Interaction round3 correction

The clean round3 test confirmed that splitting section/header fixes ownership but gives fixed feedback a transformed sortable ancestor: its physical rectangle received the parent offset again. The source was displaced below the clip despite correct library coordinates. The replacement keeps the complete social section as both sortable element and feedback source. `onBeforeDragStart` synchronously folds only that social before the library measures it, preserving the scroll canvas; `onDragStart` then folds the peers. The library can now reorder its own proxy placeholder while the fixed source remains outside transformed moving ancestors. RK feedback is unchanged. This is a library lifecycle integration, not a custom drag engine. Two focused regressions cover sibling ownership and the source-before-measure/peers-after-capture sequence. Fresh real interaction closure remains required on application `2108b372…`.

The first canonical current suite stopped in shard1 on an unrelated workspace walkthrough's one-second `findByText('launch.mp4')` timeout under load (725 tests passed, one failed). It is not recorded as a suite pass. No heavy verification remains running during the current browser recovery; the affected test and full suite will be rerun after UI closure.

Final interaction round5 earned9.9/10 after fixing the keyboard pre-centering order: prepare the compact social inside the library activation guard before `handleStart` scrolls/measures, while pointer preparation still waits for its500ms hold. Actual SOC/RK movement now advances one neighbor and Escape restores complete ownership/folds. Independent design round4 earned9.9/10 after inspecting final390px busy-four-action geometry (all controls inside the98×64cell,324/324table,82px inputs). Buyer retains9.9/10 with a transparent applicability addendum for phone/drag-only final deltas. See `compact-final.md`. Current focused tests pass38/38, including the previously flaky workspace walkthrough; the complete runner is still required.

### Canonical compact baseline and retained-canvas filter regression

The complete compact baseline fast runner passed **14/14 gates,5939 tests,12 skipped** in1371seconds on application `b330a035…`. Its exact runner-owned output is preserved in [compact baseline verification](verification-compact-baseline-fast.json). This supersedes the earlier unrelated workspace timeout; no unrelated runtime or test timeout was changed.

A subsequent primary-agent actual beta test found that searching after a retained day canvas and bottom scroll371 could leave the matching row above the clipped table. The new regression failed before the correction, then passed: changing Search/occupancy/marker removes retained list/panel minimum heights and resets the result viewport to0. Date is deliberately absent from that effect's dependencies. The five touched finance/accounts suites pass **86/86** after this correction. Buyer round4 independently repeated actual normal/bottom date transitions (all retained-row deltas0px), then search and launched-only filtering from the retained canvas; matching results were visible and document width stayed1384/1384. Final application fingerprint is currently `2d721f61…`; the full5939-test baseline predates this last filter-only correction, so it is not falsely described as an exact-final-source full run. Current static/build/budget checks and an additional middle-social stress review are recorded separately.

### Additional middle-social stress correction

Interaction round6 invalidated the previous final interaction acceptance with an actual50-social/500-RK case: at table scroll34867, holding g25 folded every body but kept all neighboring social headings above the viewport on the retained71900px canvas. The complete source/grab point and Escape restoration were correct, but moving among neighbors was unusable; the independent score dropped to9.3/10. This was not hidden behind the earlier9.9 happy-path result.

The root cause was the anchor measuring the actual source, which default Feedback fixes under the pointer. The library's hidden same-ID placeholder is the item that participates in collapsed document flow. The layout effect now prefers that placeholder's heading, falling back to the real heading after the proxy is removed. This keeps native Feedback, collision detection, animation and original-source ownership intact. A regression first failed with scroll1000 instead of200, then passed both collapsed-neighbor anchoring and exact1000 restoration on cancel. Fresh actual stress closure remains required on application `36010b79…`.

Interaction round7 independently closed the exact middle-social defect at9.9/10 on `36010b79…`: during native hold the collapsed viewport is1451 with adjacent targets visible; release and actual one-neighbor keyboard movement followed by Escape both restore34867/page234/g25y416.125, all50 expanded groups and one heading per group. The screenshot backend serialized a requested held image until release; the report correctly labels it restored context and relies on the actual in-flight DOM measurement for the held state. Buyer and designer independently assessed final-source applicability and retain9.9/10 with explicit capture provenance. Exact-final-source static verification now passes13/13 in177seconds, and the five affected suites pass87/87.

### Collapsed-scroll-range stress correction

The next stress check invalidated round7's closure: while a social was captured, native wheel scrolling could still enter the retained expanded canvas below every collapsed group. Round8 independently observed table1451→6451, zero visible peer targets, scrollHeight72800/client333, then exact Escape restoration; score9.4/10. The prior13-static/build/budget pass applies to `36010b79…`, not this subsequent correction.

The social anchor now also saves the frozen minimum canvas height. While captured, it uses only the physical table viewport as the minimum, allowing the collapsed groups to define the actual scroll range and keeping the table's screen height stable. Before expanding again, it restores the frozen canvas and applies the flow-placeholder anchor. The regression first failed with71900px instead of333px and now verifies both bounded capture floor and71900px restoration with exact scroll1000→200→1000. Fresh round9 and exact-source checks are required on `7b457a15…`.

Round9 independently closed the blank-tail defect at9.9/10 on final `7b457a15…`: active list minimum333px, actual collapsed scrollHeight3328/client333; native wheel5000 clamps at2994 with g46–g50 visible, then Escape restores34867/page234/g25y416.125,50 expanded groups and one heading each. The persistent keyboard-capture PNG agrees with its DOM measurements. Buyer/designer independently inspected final code, regression and actual artifacts and each retain9.9/10 with transparent scope. Exact-final-source static runner passes13/13 in180seconds; final affected suites pass87/87 in35.66seconds.

Final source also passes a fresh web build and4/4 actual-dist budget tests: Accounts75381B gzip, Launch37514B and charged existing/shared1003321B below the unchanged1004788B ceiling. Reopened clean authenticated main beta after builds, restored the reviewer-left launched-only filter to All, captured final screenshot/geometry (document1384/1384, table1259/1259, ordinary44px rows, zero active captures), and retained the live deliverable. No user finance values, tags, ranks or folds were reset. C005 is closed with final-source checks and explicit separate full-baseline provenance.
