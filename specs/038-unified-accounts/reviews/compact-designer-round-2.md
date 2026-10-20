# Compact accounts — independent designer, round 2

Freeze `ccbba6ae4ff8d9ef79257a6f2f63129e944b531e6fcff5ffb5eea2ea92326aea`; real local beta, same independent tab453. **Score: 9.6/10** across desktop and responsive scope. Desktop-only compact design now meets 9.9; phone action stacking still needs adjustment.

## Corrections and passes

The round1 outer-scroll observation used a semantic locator click, which itself scrolls a sticky target into view before delivering the click. A proper native pointer retest now preserves document scrollY234, document scrollHeight900, table top247.5546875 in both Yesterday→Today and Today→Yesterday. No visible table blink occurred. There are still no repeated input labels or dates in the table headings. The 199 px locator-generated jump must not be presented as an unfixed native pointer defect.

At390 the finance input content is now82 px (previous24); three equal full-width financial cells and their headings are readable, with no horizontal overflow (document390, table324/324).

## Remaining phone refinement

The phone action track inherits vertical stacking. An editable free RK's three30 px actions plus gaps create an98 px-high action block, making the whole row147.76 px; the one-run row reaches235.94 px. The three money cells remain32.76 px tall. Put the frequent icon actions into a horizontal group with an appropriately sized action track, so the identity/status zone is not stretched to98 px. This is not a desktop blocker but prevents a9.9 rating across the tested responsive scope.

Native day-switch geometry and mobile evidence: `scratchpad/038/compact-designer-390-fixed-r2.png`. The screenshot named `compact-designer-date-fixed-r2.png` was captured during the locator-click experiment, before the corrected native-pointer retest, and is not evidence of native-date instability.

No runtime/test edits or fixture writes. Viewport reset to1384×666 and menus closed. Independent interaction review owns actual drag translation/cancellation; this score does not assert its success.
