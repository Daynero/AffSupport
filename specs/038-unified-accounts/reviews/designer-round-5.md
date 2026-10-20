# Independent designer review — round 5

Date: 2026-10-18. Frozen beta; own Chrome tab766198397. Source reference supplied by root:90-file `ed8…` hash before test-only whitespace. Browser interactions and measurements through cua_repl only. No app source modifications.

**Score: 95/100.** The previous scale freeze no longer occurs and real social pointer sorting is now independently proven. One concrete accessibility issue remains: late mounting above a far focused group moves the focused control outside the visible table.

## D8 fixed functionally: actual scale fixture remains interactive

Team92754a0b-facc-4b54-8d78-95c055ad24a0,1440×900,100%, light theme. Actual All500 visible,50 social headings and50 expanded disclosure controls in DOM. Only40 finance inputs (=10 mounted RK) initially. Screenshots, DOM queries, far-group navigation and editing completed normally without the prior renderer/native-control loss.

Focusing g50 caused20 mountedRK (g49/g50), not500. Editing first g50 balance42 then Enter focused second g50 balance visibly at x681–763,y560–582. Navigating to g01 unmounted g50 inputs; returning through g50 disclosure focus remounted the original42 draft intact. Cancel cleared it. These verify bounded rendering and lifted drafts, not frame budgets.

## D9 — high: far heading focus lost after neighboring placeholder grows

Fresh all-expanded scale page. Execute keyboard focus via g50 disclosure followed by Tab:

`getByRole('button', {name:'Згорнути g50 — Long social account name for testi', exact:true}).press('Tab')`

The active control is g50 move button. Focus mounts g50 and near-viewport g49. Screenshot nevertheless shows g49 rows. Measured active control top3210.38/bottom3248.38 while table visible bounds231.55–798.88 and viewport height900. Focus has moved about2400px below the visible table.

Cause is consistent with observed heights: first mounted group actual height4419px, untouched placeholder group1734px. g49 mounts above g50 after the browser's initial focus scroll, expands substantially, and pushes the target away. Need table-scoped focus anchoring after deferred group heights settle, with caption clearance, while explicit user scroll cancels that anchoring. Do not use repeated global scrollIntoView that drags the sticky toolbar.

## Actual pointer trajectory: social sorting and mixed folds

Raw CDP capability became available in this recovered tab: Page.getLayoutMetrics and Input.dispatchMouseEvent both accepted.

Ordinary beta team222…: initial order g1,DESIGN038,BUYER038,DESIGN038B,BUYER038R3. Collapsed BUYER038 only; all four other groups expanded.

- MousePressed blank DESIGN038 header at x500,y350, held650ms.
- Observed all five groups temporarily collapsed, floating DESIGN038 overlay, localized status `DESIGN038: місце 2 з 5.`
- Sent mouseMoved path x500,y370…730 in30px increments with16ms spacing; released at730.
- Observed server result `Порядок збережено` and final headings g1,BUYER038,DESIGN038B,DESIGN038,BUYER038R3.
- BUYER038 restored collapsed; other original groups restored expanded. No finance/content action accidentally triggered. This is a real pointer pickup, movement and drop, not merely a synthetic reducer test.

650ms hold proves delayed pickup and click suppression, but does not prove an exact500ms boundary or frame performance. No trace was collected this round.

## Reduced motion and remaining scope

Used supported Emulation.setEmulatedMedia prefers-reduced-motion=reduce. Computed social transitionDuration became0.00001s, media query true. Keyboard Space/Escape remained functional. Cleared media override afterward (query false). Full reduced-motion pointer trajectory was not measured.

R4 already independently proved390 fresh-width containment, visible dirty Save/Cancel, exact200% zoom and both mobile clipboard formats; no contrary behavior found. R5 concentrated on new scale behavior and real gesture evidence. SC004 frame-p95/max proof remains outstanding; no numerical performance pass claimed.

Reset viewport override and closed own397 tab successfully. Root may apply D9 patch; review browser released.
