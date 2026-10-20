# Compact accounts — independent designer, round 1

Reviewed application freeze `d83d4981b266ee6ea7c179d3585c953f15e8a2eddfe9b693c0c659b0f812512f` in real authenticated local beta through an independent Chrome tab 766198453. Reviewer authored no runtime or tests.

**Score: 9.0/10.** The latest desktop design is substantially more compact, but the explicit stable-position requirement still fails after scrolling the outer page. A phone adaptation also compresses money fields below a usable width.

## Verified

- Desktop 1384 × 666: document width 1384, table client/scroll width both 1259. No horizontal scrolling is necessary. Ordinary RK heights are 44 px; the one-run row is 47 px. Inputs use 30 px shells.
- Exactly three selected-day financial columns: balance, top-up, spend. Table headings contain no dates, and the main Today and Yesterday rows have zero repeated visible field labels.
- History and Archive are absent from the normal RK action shelf and accessible inside the RK More menu. Actual menu opened for BUYER038-802 showed Edit, Move, History, Archive, Delete. Escape closes it and restores the trigger focus.
- 1000 × 666: document width 1000, table client/scroll width 926/926. 768 × 666: document width 768, table 694/694. Neither produces horizontal overflow.
- Existing folding, tags, archived dated row and run content remain present. No fixture data was edited.

## Required fixes

1. **Outer-page date jump.** Scroll the outer page, outside the table, until the financial toolbar sticks near the top and the RK rows are visible; click Yesterday. On the first measured transition document scrollY changed 234 → 35, table top 247.55 → 446.55 and the same first RK top 397.89 → 596.89: a 199 px visible jump. Inner table scrollTop remained 0 and row heights remained 44/47. Preserve the outer scroll canvas and window position in addition to the inner table anchor. Evidence: `scratchpad/038/compact-designer-date-before-r1.png` and `compact-designer-date-after-r1.png` (the before screenshot is after native scrolling has settled; an immediate evaluate directly after native scrolling can report stale coordinates).
2. **390 px phone field compression.** Document width 390 and table 324/324 do avoid horizontal overflow, but each financial input's content is only about 24.06 px wide. Headings split into multiple word fragments and RK rows measure 77, 129, 107, 141, 107 px. Give the three money fields their own full-width row below identity/actions at narrow widths so ordinary values and the three headings remain readable. Evidence: `scratchpad/038/compact-designer-390-r1.png`.

## Evidence and limits

Screenshots also saved as `compact-designer-desktop-r1.png`, `compact-designer-1000-r1.png`, `compact-designer-768-r1.png` in `scratchpad/038/`.

The initial fresh tab was delayed at “Перевіряємо вашу сесію Soty…” and later showed “Soty не вдалося запустити / Оновіть сторінку, щоб завантажити актуальну версію.” It eventually recovered while other reviews/static work completed. A later direct navigation to the Accounts route loaded promptly. This is not attributed to Accounts without evidence of causation.

This review does not certify real hardware touch, Windows/WebKit, continuous FPS, or actual pointer translation: a separate independent interaction reviewer owns the drag scenarios. Browser viewport override was reset to the original 1384 × 666; the menu was closed; this reviewer changed no theme, language or fixture content.
