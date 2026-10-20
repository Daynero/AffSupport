# Owner UI refinements: hold progress and centered sorting

Application source fingerprint: `fab2cab1a425123766d098e695f7e8941027fa5a509b5dae782c6dd8e06b65d0`. Existing financial values, ranks, tags and folds were preserved; actual drag checks were cancelled.

## Changes

- Plain SOC/RK identities, no suffix pills or identity search highlights. Seven pure token palettes fill the identity band from the bright left rail, with rounded right corners.
- No visible six-dot grips. Whole-card pointer hold stays500ms; More menu and Alt+arrows preserve accessible ordering, with local permission/archive and membership guards.
- The ring follows the real dnd-kit Delay constraint: show at pointerdown, clear at actual activation or abort/release/tolerance cancellation. Coordinates stay local and are never collected as telemetry.
- Pure complete-row center collision replaces pointer-first collision, so tall RK target selection is independent of where the row was grabbed. Existing Feedback/placeholder and animation remain.

## Actual beta evidence

`scratchpad/038/hold-center-browser.json` records native pointer actions: a24px ring centered on470,880 with0.5s animation and no drag yet; subsequent103px tall RK capture with no ring. Moving the pointer90px upward moved the full row90px, preserving height and grab offset; the adjacent RK changed position. SOC capture was an opaque `rgb(28,23,37)` SECTION at opacity1 and temporary folded state. Cancellation restored expansion and left0 active/drop captures. Final DOM had0 visible grips,0 identity marks/pills and no horizontal document overflow.

`hold-ring.png` is timing-sensitive and is not standalone visual proof of an in-flight500ms ring; the contemporaneous DOM observation is the evidence. `accounts-polish-final.png` shows restored final UI. Earlier responsive/hover/red-dot proofs remain scoped to their recorded checks.

## Validation

Targeted five-suite run:82 passed,1 failed because the new test omitted its React JSX import. Fixed that test import; its full5-test suite then passed. The other4 suites passed, including mirrored tall/short geometry, grab-offset independence, disabled/removed-item guards and existing account workflows. Static gates/build/budget results are recorded below when complete.

Static first pass found the SOC More trigger using a legacy IconButton without ref support. Restored the existing ref-capable UI IconButton for that trigger; retry pending. No geometry or drag behavior changed.

Final regression run: **88/88 PASS across6 suites** (accounts, RK/SOC ordering, real Delay lifecycle, mirrored tall-row center selection, production asset budgets). Fresh `build:web`: PASS. The SOC AltArrow handler is on the head capture route because the ref-capable HeroUI button intentionally restricts keyboard handler props. Fixture script catch now narrows unknown errors before reading `code`; script typecheck retry PASS. Final static acceptance rerun pending.

Final static result: **12/13 PASS**, format gate hit its300s resource budget. Repeated only `npm run format:check` separately: **PASS**, all matched files use Prettier style. The canonical timeout result is preserved in `verification-hold-static.json`; it is not rewritten as green. Thus every static check passed on final source, with the formatting retry explicitly separate. `git diff --check`: PASS. Final fresh beta DOM after build: no errors,0 grips,0 identity marks/pills,0 pending ring/drag/drop surfaces, no horizontal document overflow. Screenshot: `scratchpad/038/accounts-polish-delivered.png`.

Owner follow-up: removed the permanent hold ring track. At pointerdown the arc starts at opacity0 and dash offset1; only the growing arc becomes visible during the same500ms delay. Actual native hold observation: no track, offset0.800008 (about20% filled), opacity1, duration0.5s; cancellation left0 indicators. Five hold lifecycle tests, targeted formatting and design-token checks PASS. Screenshot: `scratchpad/038/hold-empty-arc.png`. Earlier source manifests/88-test results keep their original scope.

Owner quick-click refinement: feedback is not mounted for the first200ms. A dedicated cancellable feedback timer shares the actual Delay lifecycle; release, tolerance abort, explicit cancellation and activation clear it. Long holds draw from zero during the remaining300ms; capture stays at500ms. Earlier UI captures retain their original timing scope.

Owner finance-alignment refinement: headings and finance input contents align left. Existing shared equal-width grid retained. Actual beta geometry at desktop: heading/frame widths84/84/84px, all three heading-to-frame left-edge deltas0px, equal8px gaps. Targeted CSS formatting, token gate and diff check PASS. Screenshot: `scratchpad/038/finance-left-aligned.png`.
