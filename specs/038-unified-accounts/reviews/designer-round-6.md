# Independent designer review — round 6

Date: 2026-10-18. Actual frozen beta, own Chrome tab766198401. Reviewed the D9 focus-anchor fix plus scale gesture and mobile regression. No source changes by reviewer. Browser actions/observations exclusively through cua_repl; local Python analyzed exported Chrome traces.

**Observed UI/UX score:97/100.** No reproducible functional design blocker remains in the reviewed journeys. This score is a judgement of observed interface quality; it does **not** certify the separate SC004 continuous-rAF performance acceptance criterion, whose measurement remains incomplete as explained below.

## D9 fixed, including intentional user scrolling

Actual50-social/500-RK/2500-run fixture at1440×900,100%, light theme:

1. Fresh page, keyboard focus g50 disclosure then Tab into move control, exactly repeating R5 failure. g49/g50 mounted80 finance inputs=20RK;50 headings remain accessible.
2. Active g50 move button rect y760.38–798.38 now stays inside inner table y231.55–798.88. Previously it was at3210px. Screenshot confirms focus ring visible on g50.
3. Sent real wheel deltaY−700 over table. ScrollTop changes90463.5→89763.5 and focused control moves to y1460.38. It stays away, proving intentional scroll is not pulled back by anchoring.
4. Edit first g50 balance43, Enter focuses next g50 balance at y560.29, visible. Navigate to g01 then return to g50: draft43 survives the unmount/remount. Cancel clears draft.

Evidence: [far-field focus screenshot](../../../scratchpad/038/designer-r6-far-focus.png).

## Scale pointer interaction still works

Using supported CDP Input.dispatchMouseEvent, picked up first social card after a held pointer, moved it through a45-step path and returned to its original position before release. All50 groups temporarily collapsed. After release, localized `Порядок не змінився`;50 headings and50 expanded states restored,20RK mounted. No freeze or unintended business edit.

R5 already independently proved an actual changed-order social drop and exact restoration of mixed folds on the ordinary fixture. This round adds an actual pointer trajectory with500 sourceRK present.

Evidence: [scale after drag](../../../scratchpad/038/designer-r6-scale-after-drag.png).

## Mobile regression remains fixed

At390×844, ordinary beta DESIGN038 balance104 then Tab: document width390 equals viewport390; Save visible at x33–118,y187–223. Active field remains usable; Cancel clears draft. Menu label now `Дії` for compact period/copy surface and `Дії за обраний день` for destructive day actions, reducing the previous ambiguity.

Evidence: [mobile Save screenshot](../../../scratchpad/038/designer-r6-mobile-save.png). R4 remains the independent evidence for actual200% zoom and both social/tag clipboard formats; source changes since then do not alter those paths.

## Frame evidence: measured, with explicit methodology limits

Captured actual Chrome traces through supported Tracing.start/end/readEvents, without app/global instrumentation. Both traces use clock-sync markers around pointer movement and contain the target renderer PID34353, compositor thread186932, main thread186918.

| Measurement | Trace1 | Trace2 |
| --- | ---: | ---: |
| Marker-bounded time |2273.265ms|2431.075ms|
| Pointer commands |45,16ms requested waits|90,no artificial wait|
| BeginFrame heartbeat p95 interval |16.687ms|17.422ms|
| BeginFrame maximum interval |18.551ms|17.520ms|
| DrawFrame p95 gap |42.326ms|35.185ms|
| DrawFrame maximum gap |47.737ms|35.414ms|
| FireAnimationFrame callback-duration p95 |16.247ms|1.287ms|
| FireAnimationFrame maximum duration |20.462ms|20.996ms|

Trace1 includes52 DroppedFrame events and trace2 includes14. Layout maximum is0.665ms/0.631ms and Paint maximum0.784ms/0.782ms. These numbers cannot be substituted for continuous-rAF intervals: pointer transport is substantially slower than requested16ms, visual frames are demand-driven, trace2 has a shorter active-frame span than its marker window, and tracing itself adds overhead. Compositor heartbeat meets20ms, while draw/presentation gaps do not; neither alone proves SC004's stated rAF sampling method.

Attempted read-only continuous-rAF timing support discovery: `requestAnimationFrame`, `window.requestAnimationFrame` and `performance` are all unavailable in the read-only evaluation bridge. Did not bypass it or mutate the page through Runtime.evaluate. Exact500ms pickup boundary also remains unmeasured;650ms held pickup was observed.

Raw artifacts (local scratchpad, not a claim of passing the performance gate):

- `scratchpad/038/designer-r6-scale-drag-trace.json` (~30MB).
- `scratchpad/038/designer-r6-scale-frame-only-trace.json` (~29MB).
- `scratchpad/038/designer-r6-frame-measurements.json` (derived trace2 metrics).

Remaining improvement is **validation tooling**: obtain controlled continuous-rAF evidence on the specified fixture/device before asserting SC004 complete. No unsupported numerical pass/fail is invented from on-demand frame gaps.

## Cleanup

Restored media emulation to default, reset viewport override, closed own401 tab. Native zoom unchanged100%. Review browser released for buyer review/root verification.
