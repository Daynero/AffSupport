# Compact Accounts — independent buyer review, round 3

Final application freeze: `5ec8f4d77dc06e839660768aa49a23525baf1b3281eecf3e344266ae9bb68923`.
2026-10-18, real authenticated local Beta, Chrome1384 ×666, Ukrainian/dark unchanged. Fresh owned tab461 loaded normally; closed afterward. Reports only; no runtime/test authorship or existing data edits.

**Score: 9.9 /10 for the tested desktop buyer workflow. No remaining blocking finding in this scope.**

I independently repeated actual day changes after the new outer-page scroll protection. Native clicks on visible sticky toolbar buttons were used, avoiding Playwright locator auto-scroll changing the page before the application receives the click.

At the lower working boundary, all five observed states (Today→Yesterday→Today→Yesterday→Today) retained **window.scrollY234**, table **scrollTop371**, scrollHeight **704**. Every retained RK finance rectangle had **0 px** x/y/size change. Dated socials correctly alternated seven Today/five Yesterday; accounts created today did not leak into Yesterday.

At normal table position, Today→Yesterday→Today retained **window.scrollY234** and table **scrollTop0**. RK y positions remained exactly **404.0078 /448.0078 /492.0078 /537.5078 /583.0078 px** in all three observations. No table-replacing loading surface or screen blink was observed. Desktop width remained1384/scrollWidth1384, and no repeated visible field labels appeared. Selected-day three-column semantics, archived financial history and compact rows remain as tested in rounds1–2.

Evidence: `scratchpad/038/compact-buyer-round-3-measurements.json` and `scratchpad/038/compact-buyer-round-3.png`.

Limits: no amount was edited, clipboard overwritten, physical touch platform certified, or quantitative continuous-frame certificate claimed. The designer separately reviews the revised phone actions and the interaction specialist reviews dragging/cancel behavior. The score applies to the actual desktop buyer workflow above, not those other reviewers' scopes.

## Applicability addendum — final freeze

Final application hash: `b330a0350a23072527cefa870bf0ce9855ce826802d99bec5d226b0f0d25642e`.

**Buyer score remains9.9/10 within the desktop financial workflow scope.** This is an independent source/evidence applicability review, not a claim that I repeated the earlier actual UI run on this newer hash.

I inspected the current selected-day preparation/presentation and prepaint restoration paths in `UnifiedFinance.tsx`: they retain both the outer page position and the inner table anchor/canvas, present only a prepared matching period, and cancel stale scope/intents. The later reviewed changes concern social drag preparation/keyboard activation and sortable element ownership, plus action wrapping inside the `max-width:560px` phone media query. Those changes do not introduce a selected-day metric, change the desktop financial grid, or replace the daily finance context. The source still uses a complete social section as the sortable/feedback element and prepares folding before library keyboard positioning; no finance mutation is introduced by those preparation steps.

I also read the separate final reports: `compact-interactions-round-5.md` explicitly reports actual final-freeze keyboard insertion/cancellation, retained full source contents, original pointer grab geometry and phone bounds; `compact-designer-round-4.md` explicitly distinguishes that capture author's evidence from the designer's own prior UI runs. Both report9.9 within their stated scopes and retain the unsupported continuous-pointer/FPS/platform limits. I do not relabel those other reviewers' observations as my own.

My direct desktop daily UI evidence remains the preceding round3 run on `5ec8f4…`: exact zero-pixel row movement at normal/bottom positions, matching day semantics and no horizontal overflow. This addendum carries that narrowly scoped conclusion forward after reviewing the final changes; it does not certify new phone or drag behavior independently. No new browser action or data mutation was performed for this addendum.
