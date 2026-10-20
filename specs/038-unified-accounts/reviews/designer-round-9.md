# Independent designer review — round 9, finance parity addendum

Date: 2026-10-18. Actual beta in own Chrome tab 766198428, UI interactions and read-only geometry through cua_repl. No application code edited by reviewer. Shared-library HMR produced a transient blank route during the announced build; fresh reload after that build restored the page. This was not scored as a persistent application defect.

Final reviewed working-tree identity supplied by root: 95-file manifest SHA256 `ea4c26d1e7dabd8863160d037eb47db19c7f1af80abd0cbd01397838a2069a19`; application SHA256 `268d80cc43fe6b7e7fcb28824f1deb022fe10d6a983a8febd7466145663e6080`. This identifies source, not a committed or packaged release.

**Overall observed functional UI/UX score: 97/100.** No outstanding reproducible functional design blocker in the reviewed scope. Restored period detail supports the finance workflow without reinstating navigation tabs in Accounts. This score does not certify SC004 continuous-rAF performance.

## Actual period-detail checks

- Desktop October 1–31 range opens the secondary “Деталі періоду” dialog with the monthly matrix selected. The main unified account table remains mounted beneath it.
- Matrix, totals and top-up statement are reachable. At 320px the third tab initially needs horizontal scrolling; actual semantic selection scrolls it into view, and the selected statement and its totals are readable. This is usable, with a minor discoverability cost from the dense narrow tab strip.
- October statement shows the October 18 top-ups, including archived historical RK, with total 128 USD. Clicking October 18 closes the report and opens that day. “Назад до звіту за період” restores the October 1–31 report and the selected statement view.
- Selected the custom October 17–18 range using the actual calendar. Opened totals and matrix, drilled into October 17, then returned. Exact custom range and selected matrix view are restored.
- Actual previous-month navigation produces September 1–30; next produces October 1–31. Month boundaries remain aligned.
- Actual summary copy buttons write `128` for top-ups and `88` for spend to the clipboard. Their accessible names distinguish the copied quantity.

## Narrow dialog and close control

Initially the new dialog lacked an explicit touch close control. Reported to root; the owner added the standard footer “Закрити” button. Actual clicks close the updated dialog successfully at narrow widths. This finding is resolved within round 9.

At 390px the dialog occupies x16–374, y24–820, while document width remains 390px. At 320px document width remains 320px. Matrix horizontal scrolling stays inside its own surface. Title, statement and footer remain usable. No new whole-page horizontal overflow observed.

Evidence: [desktop period report](../../../scratchpad/038/designer-r9-period-desktop.png), [390px period report](../../../scratchpad/038/designer-r9-period-mobile.png). Both show the actual custom-range matrix after the footer correction.

## Prior coverage, limitations and cleanup

Round 8 remains the detailed mobile normal-row/editor/focus evidence; no contrary regression was observed in this report-only addition. R5/R6 retain the actual social pointer-drop, mixed-fold restoration, scale-500 deferred rendering, far keyboard focus and draft preservation evidence. No fresh scale benchmark or full editor matrix was claimed for this addendum.

SC004 continuous-rAF performance and exact 500ms boundary remain uncertified for the documented R6 measurement/tooling reasons. An observed UI score above 96 does not replace that acceptance proof or release verification. Remaining points reflect narrow-table/report density and incomplete quantitative performance certification, not a reproduced inaccessible action or lost-data defect.

Closed own tab 766198428. No media or zoom override added in this round. Buyer was concurrently finishing the final 390px check, so reviewer deliberately did not reset the shared browser-scoped viewport underneath that check; viewport ownership was explicitly released to root/buyer for their normal cleanup.
