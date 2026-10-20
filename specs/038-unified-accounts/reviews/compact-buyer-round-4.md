# Compact Accounts — independent buyer review, round4

Application freeze: `2d721f61ae2f5089a8db19ca5bb0c2d453829da3a5b3730a9c4fafe39786693a`.
2026-10-18. Actual authenticated Beta, Chrome1384×666, Ukrainian, existing dark theme. Fresh owned tab477; closed afterward. Reviewer authored reports only and changed no account/finance data, theme, language or viewport.

**Score:9.9/10 for the tested buyer workflow. The reported search regression is fixed, and daily position preservation still passes.**

Actual retest:

1. Today→Yesterday→Today at normal position retained outer scroll0/table scroll0. All five RK row rectangles were identical across states: y631.890625/675.890625/719.890625/763.890625/810.890625, heights44/44/44/47/44px.
2. Scrolled the inner table to371 and outer page to234. Native clicks on visible sticky Yesterday/Today controls retained outer234, table371, scrollHeight704. Every RK row rectangle remained exactly unchanged, **0px delta** in both directions. No table-replacement loading screen appeared.
3. From that actual retained date canvas and bottom371 position, typed `88003802` into Search. Exactly the matching RK appeared. Table scrollTop reset to0; its row was visibly at y537.1953125–581.1953125, within the table beginning y453.0546875 and within the666px viewport. This directly exercises the formerly invisible filtered result, not just an isolated fresh search.
4. Cleared Search and selected the existing “Запущені1” occupancy filter. The single launched RK805 appeared at y534.1953125–581.1953125 inside its table, with table scrollTop0. Financial values were untouched.

Document client width/scrollWidth remained1384/1384. Selected-day three-field semantics and hidden secondary history/archive remain covered by the preceding buyer rounds. Search/filter intentionally resets its result position; date changes preserve the working position.

Artifacts: `scratchpad/038/compact-buyer-round-4-measurements.json` and `scratchpad/038/compact-buyer-round-4-search.png`.

Limits: this is a new actual desktop finance/date/search/occupancy review, not a new drag, phone, physical-touch, Windows/WebKit or continuous-FPS certification. No marker was changed because that would mutate existing user presentation data; marker reset dependency was not separately exercised in this UI run.

## Final scope applicability — middle-social anchor fix

Final application hash: `36010b798cea217f50dfb94782395c34cf04aa8245d5f8519faa2561ea77048c`.

**Buyer score remains9.9/10 for the desktop finance/date/search workflow.** This paragraph is an independent code and supplied-evidence review; no new buyer browser run occurred after the round4 actual run above.

I inspected the final provider adjustment and new regression test. During a social drag, the viewport anchor now prefers the library-owned placeholder in document flow rather than the fixed feedback source. The test explicitly distinguishes those two geometries, verifies inner scroll1000→200 while peers fold, and restores1000 on cancel without a reorder request. It does not alter daily finance preparation, selected-date inputs, search/occupancy reset dependencies, finance writes or desktop CSS. Consequently the actual round4 date/search evidence remains applicable within that unchanged scope.

The earlier interaction acceptance was correctly reopened: interaction round6 scored9.3 after reproducing an empty neighboring-target canvas for a middle social at deep scroll. I independently read the replacement actual measurements in `scratchpad/038/compact-middle-social-fixed-proof.json`: expanded50/page234/table34867 before capture; during capture table1451 with intact source and nearby g23/g24/g26/g27 headings; after release table34867/page234/header416.125 with50 expanded states,50 one-heading owners and zero active drags. The same artifact records actual keyboard25→26 and Escape restoring the original position. These measurements were produced by the interaction reviewer, not by this buyer reviewer. The screenshot backend serialized after release, so the PNG is not used here as proof of an in-flight held frame.

This supports the narrow fix's applicability without laundering old interaction acceptance or treating the buyer score as a physical-pointer/FPS/platform certificate. The separate interaction round7 report owns the final drag assessment. No new account, finance, rank or presentation mutation was performed by this buyer for the addendum.

## Final applicability update — bounded active drag canvas

Current final application hash: `7b457a1575537ecae15dd0d59e2c4eeb529660e54cb26c6aa2af04b95b91f927`.

**Buyer score remains9.9/10 for the reviewed desktop finance/date/search scope.** This supersedes the preceding hash's applicability statement. It is code/evidence inspection; it is not a new buyer UI run.

I inspected the final provider code and updated regression: capture stores the existing list minimum height, active social dragging temporarily sets that minimum to the table clientHeight, and termination restores the stored minimum before restoring the flow anchor. The test now asserts both333px during capture and the original71900px after cancellation, alongside scroll1000→200→1000 and no reorder request. This confines the shortened canvas to active social capture; it does not replace the retained daily canvas after release. The financial selected-day three-field mapping and prepared-period path remain intact, and the search/occupancy/marker reset effect still depends only on those three filters, not the selected date. This supports carrying forward the actual round4 finance/date/search observations.

I independently read `compact-interactions-round-9.md` and its actual `scratchpad/038/compact-drag-bounded-tail.json`. The previous round7 acceptance was reopened by round8's empty scroll-tail defect; it is not reused as final acceptance. Replacement evidence records active social tableHeight3328/client333, native wheel5000 clamping scrollTop2994 with g46–g50 visible, then Escape restoring34867/page234/g25y416.125 with50 expanded states,50 one-heading owners and zero captures. The artifact and active keyboard-capture screenshot belong to the interaction reviewer; I do not claim those actions as my own. The separately reviewed drag score is9.9 within its documented scope.

No new browser action, finance/rank mutation or runtime edit was made for this update. Physical touch, other browsers/platforms and quantitative continuous FPS retain the explicit limits in the independent interaction report.
