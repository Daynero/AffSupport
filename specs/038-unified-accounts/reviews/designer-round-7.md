# Independent designer review — round 7

Date:2026-10-18. Targeted frozen beta review, own Chrome tab766198409. No app code edited. UI and read-only geometry through cua_repl. Prior scale/gesture results remain in R5/R6; no new performance certification.

**Observed UI/UX score:95/100.** Normal-row layout is now correct across all requested widths, but the related inline editor still hides entered text on390px. Previous97 score did not cover a valid geometric check of the old mobile grid; this round supersedes it for the updated final layout.

## Normal row alignment fixed

Measured five normal RK rows, including a busy RK with a run, at390/768/1000/1440 CSSpx:

- Every row uses `"rail id status note finance actions"` on one grid line.
- Vertical center spread across ID/status/run/finance/actions is0.00390625px at all four widths.
- Document scrollWidth equals viewport at all four widths.
- Row heights stay100–151px depending on contents; the former large empty vertical separation is gone.
-390px edit DESIGN038 balance105 → Tab → Enter: yesterday field remains visible, page scrollX0. Since this is last RK in its social, Enter stays in that field, as required.
- Save/Cancel remain visible in compact toolbar and Cancel clears the financial draft.

Evidence: [390px normal finance row](../../../scratchpad/038/designer-r7-mobile-final.png), [desktop](../../../scratchpad/038/designer-r7-desktop-final.png).

## D10 — medium: mobile inline editor input exceeds viewport and hides text

390×844, DESIGN038→Add RK. Create editor correctly uses `"rail fields actions"` and is65px high. However its fields grow to fill the1380px internal table:

- ID input403.66px wide.
- Launch input645.34px wide (613.34px once clear button exists).
- Tab from ID to Launch scrolls tableX164.5, but active Launch field is x330.16–975.5: only27px of it is visible in the324px table scrollport.
- Fill `DESIGN-R7 LAUNCH DRAFT`: browser scrolls tableX783, active input becomes x−288.34–325. Its text begins outside the left edge; screenshot shows an apparently empty focused field with clear X, while the value exists.
- Tab to Save does reveal Save at x313–349, so action reachability itself works. The inability to read entered text remains a real editing usability defect.

Suggested fix: constrain each inline field to a width that fits the narrow scrollport; when moving keyboard focus reveal the whole field within the internal table. Keep the row's three-area model and internal scrolling. Verify actual text visibility after typing, not only element presence or grid template.

Evidence: [mobile editor clipping](../../../scratchpad/038/designer-r7-mobile-editor-issue.png).

Cancelled both editor reproductions without saving new RK. Reset viewport override and closed own409 tab. Root may patch D10; review browser released. SC004 remains uncertified as explicitly documented in R6.
