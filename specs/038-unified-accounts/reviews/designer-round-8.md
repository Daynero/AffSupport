# Independent designer review — round 8, final functional UI review

Date:2026-10-18. Frozen actual beta; own Chrome tab766198413. No product code edited by reviewer. UI actions/read-only geometry through cua_repl. Paused during two small root patches, then cancelled drafts and freshly reloaded before final verification to avoid stale HMR code.

Reviewed application identity supplied by root (working tree, not a committed/released build):94-file manifest SHA256 `cb9a6e7026ff8b1a4dcf6b2ae7c7469edba33abc5e5c61241e4814da53bdc1f3`; application SHA256 `f4d8f8141cc680aa097888f24dd9b05ca5e1c305fa3fb3f9efa95757f9ef2f89`.

**Overall observed UI/UX score:97/100.** The reported editor clipping and clear-focus defects are now resolved. No outstanding reproducible functional design blocker in the reviewed scope. This score remains separate from SC004 continuous-rAF certification, which is not claimed; R6 documents the trace and tooling limits precisely.

## D10 resolved with typed text, full field and clear X visible

At320/390/768px, Add RK under DESIGN038, type disposable ID99003808 and launch draft `DESIGN R8 readable draft`, navigate Tab/Shift+Tab:

| Viewport | Table scrollport | Entire launch field wrapper |
| --- | --- | --- |
|320|x33–287,254px|x63–287,224px|
|390|x33–357,324px|x69–357,288px|
|768|x37–731,694px|x340–628,288px|

Text is readable in the actual screenshot, and the clear X stays inside the visible wrapper. The normal document width remains320/390/768 respectively; only the intended table scrolls horizontally.

- Tab and Shift+Tab reveal whole ID/launch wrappers instead of merely the input portion.
- At320px, Tab reaches visible Save at x150–186,y553–597. Cancel is accessible and discards the draft.
- Click actual launch clear X: value becomes empty, activeElement remains the same launch textbox with caret visible. Previously focus fell to BODY; freshly reloaded patch verified this correction.

No RK created; every disposable draft cancelled.

Evidence: [final readable mobile editor](../../../scratchpad/038/designer-r8-mobile-final.png).

## Social editors and normal row regression

Rename DESIGN038, change only an unsaved name draft, Tab to empty2FA field. At320px, wrapper224px at x63–287; at390px wrapper288px at x69–357; at768px wrapper288px at x340–628. All fit their table viewport and page width remains bounded. No secret entered and no rename saved.

Opened Add social, typed unsaved name draft, reached Save with Tab, then cancelled. No new social saved.

Desktop1440px normal RK rows retain the six-area single-row grid. Measured four rows: ID/status/run/finance/actions vertical center spread0.00390625px each. Document width1440. R7 already measured same normal-row alignment at390/768/1000/1440; no contrary regression found after field-only changes.

Evidence: [final desktop table](../../../scratchpad/038/designer-r8-desktop-final.png).

## Prior coverage and limits

R4 proves mobile copy formats and actual200% browser zoom; R5 proves changed-order pointer social drop/mixed-fold restoration and reduced-motion controls; R6 proves scale500 source accounts with bounded mounted rows, far keyboard focus after deferred heights settle, intentional wheel release, lifted drafts and actual scale pointer trajectory. Those findings remain applicable except where superseded by targeted row/editor checks in R7/R8.

No continuous-rAF performance pass, exact500ms threshold measurement, new release verification or production readiness is inferred from97/100. Remaining three points reflect a dense horizontally scrolled table on narrow screens and the uncompleted quantitative performance acceptance proof, rather than a known lost-data or inaccessible-control defect.

Reset viewport and closed own413 tab. No media override or browser zoom change left in place. Browser released for final buyer review and root verification.
