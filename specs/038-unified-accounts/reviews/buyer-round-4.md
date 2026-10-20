# Buyer review — round 4

2026-10-18. Independent actual beta review. Dedicated Chrome tab766198392. **98/100 for targeted buyer regression on the normal-size fixture.** No certification of500-RK performance; the designer's separate stress findings remain a condition of overall acceptance.

## Directly verified after the R4 changes

- Fresh review tab loaded preserved daily totals5/120, active7/free6/launched1, manual order and existing launch.
- Archived801 history drawer now identifies“Історія · BUYER038-801”. Historical correction heading and inputs useBUYER038/fullRK88003801/date rather than internal UUID. Saved yesterday spend16→17 while801 stayed archived; today's5/120 unchanged.
- Add account auto-focused and centered the name input fully below sticky column captions at default1384×666. After enteringBUYER038R4, Save/Cancel visible; cancelled draft, no extra social created.
- At390×844, changed802todaybalance102→106. Both Save and Cancel were plainly visible in the sticky toolbar screenshot; clicked Save and confirmed input106 after the toolbar returned to clean state.
- Mobile overflow menu exposes Copy topups by social/by tags, date choices and Excel. Actual copy-by-social clipboard read exactly date2026-10-18, currencyUSD, BUYER038,88003801-$50 and88003803-$70, including archived801.
- Viewport reset to normal after mobile interaction; final screenshot showed successful copy toast.

## Remaining minor improvement (2 points)

Mobile presents two visually identical ellipsis controls with the same accessible label“Дії за обраний день”. One contains copy/date/export; the other destructive clearing actions. The correct operation is reachable, but distinguish labels/tooltips (e.g. period/export vs clearing daily values) so users and assistive technology can predict the menu.

## Limits and honest interpretation

R2/R3 remain detailed evidence of the full5-RK morning pass, archive blank/yesterday-only/explicitzero, parent/child restore independence and order stability after business changes. This round retests changes that could regress those flows rather than claiming every scenario reran.

500-RK stress performance, frame timing, live midnight, lost network replies and two-client concurrency are not independently proved by this reviewer. DesignerR4reported94because its500-row stress route caused browser timeouts; this buyer score does not override that finding. Root must resolve/retest scale before asserting both reviewers have accepted the whole implementation.

No app source modified. Local test mutations this round:801yesterdayspend17,802todaybalance106; no new account/RK persisted.
