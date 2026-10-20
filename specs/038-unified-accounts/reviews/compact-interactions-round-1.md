# Independent interaction review — compact Accounts, round 1

Reviewed 2026-10-18, app freeze `d83d4981b266ee6ea7c179d3585c953f15e8a2eddfe9b693c0c659b0f812512f`. Runtime and tests were not edited by this reviewer.

**Score: 9.8/10 for the interaction scope observed.** No reproduced runtime defect in the completed hold/geometry checks. The requested 9.9 threshold has not yet been earned for actual pointer translation and sibling animation; those checks remain incomplete rather than being reported as passes.

## Environment and real UI evidence

- Chrome, real local beta authentication, 1384 × 666 viewport; synthetic team `92754a0b-facc-4b54-8d78-95c055ad24a0` with 50 socials, 500 RK and five long run descriptions per RK. No financial values, names or stored ranks were changed. No viewport, theme or language overrides were made.
- Fresh tab initially stalled during session boot, then the app watchdog recovered to the tools page. Reload and navigation restored a working Accounts page. Concurrent browser commands were then serialized with the other reviewers. This environmental delay is not counted as an Accounts design failure.
- The visible table has exactly three selected-day finance headings: balance, top-up, spend. Header labels contain no date and no prior-day spend column.

## Passed with actual native input

1. Held the first social header at `(700, 540)` for 2000 ms and measured it during the hold, after approximately 700 ms. The captured source remained **1258.953125 × 53.1953125 px**, at `x=62.5234375, y=512.5`, matching its pre-capture bounds exactly. Its content remained present. All RK rows temporarily disappeared during the social capture (10 mounted before, 0 during, 10 after release), and social header positions and expanded state returned after release.
2. Held the first RK at `(400, 610)` for 2000 ms and measured after approximately 700 ms. The captured source remained **1258.953125 × 218.796875 px**, at `x=62.5234375, y=565.6953125`, matching pre-capture bounds exactly. All five original run descriptions and all three input values were unchanged. There was no empty enlarged substitute row.
3. RK grab point matched the physical press: offset `(337.4765625, 44.3046875)` inside the original rectangle. The library source recorded transform origin `26.806126121653655% 20.249232307362707%`, consistent with that offset.
4. Releasing without moving restored the normal rows and reported unchanged order; no stored order mutation was performed.

The unusually tall stress RK is already tall before capture because it contains five long run pills; it does not grow on capture. Ordinary 44 px RK density is covered separately by the buyer review. This review does not assert that a five-run row should fit into 44 px.

## Uncompleted checks and exact tool limits

- The documented immediate native `Tab.drag` did not meet the app's 500 ms hold requirement and selected text instead. It did not provide evidence of an activated drag translation.
- Raw CDP `Input.dispatchMouseEvent` was explicitly rejected twice while the browser bridge reported a paused document response, even after a complete AX snapshot. That restriction was not bypassed through injected DOM events, another automation framework or OS scripting.
- A concurrent native Escape press during a held click did not establish a cancellation outcome: after release the app reported unchanged order. Escape is therefore not marked passed by this attempt.
- Actual pointer-following translation, intermediate sibling animation, changed-position drop and exact mixed-fold restoration after such a drop still require a permitted native input sequence. Quantitative FPS, physical touch and cross-platform behavior are outside this review's evidence.

Source inspection supports the intended implementation: default dnd-kit Feedback keeps the actual source and measured geometry; PointerSensor uses 500 ms/5 px activation; sortable movement uses a 220 ms transform transition; social temporary collapse does not overwrite stored collapse state. Source inspection alone is not substituted for the remaining real movement checks.
