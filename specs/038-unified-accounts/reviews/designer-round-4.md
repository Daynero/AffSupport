# Independent designer review — round 4

Date: 2026-10-18. Actual frozen beta. Reviewer used only cua_repl UI operations and read-only DOM/clipboard evidence. Independent native-created Chrome tab 766198386. No product source changes.

**Score: 94/100.** All previously reproduced layout blockers now pass. Acceptance remains below the requested threshold because the actual 500-RK fixture caused loss of browser responsiveness/control before its interactive behavior could be verified. This is a correlated observation, not a proven performance root cause or a fabricated frame-rate failure.

## D6 resolved with actual evidence

- Fresh390×844 page: document scrollWidth390, innerWidth390, page scrollX0.
- Edit DESIGN038 balance100 and Tab: yesterday expense remains visible with focus ring. Save is immediately visible at x33–118, y186–223; Cancel is beside it. Screenshot shows usable compact toolbar.
- Cancel clears draft. Both copy actions are present in the compact date More menu.
- Executed social copy: toast `Скопійовано — РК: 2`; actual clipboard contains date2026-10-18/USD, BUYER038, 88003801$50 and88003803$70.
- Executed tag copy: same two rows under `Без тега`; actual clipboard confirmed. Archived RK88003801 remains included correctly.
- 768×1024 at100%: document width768 equals viewport768.
- NativeChrome toolbar explicitly reported200% zoom. Effective viewport384: document width384; edited field visible at x246–328,y370–392; Save x33–118,y187–223. Cancel worked. Native zoom restored100%.
- 1440 desktop settled light theme readable; table and sticky controls usable. Dark mobile tested before theme toggle. Earlier full-eight-color-cycle and longhold results remain documented in round2.

## New concern D8 — actual scale fixture cannot be accepted yet

Fixture: team92754a0b-facc-4b54-8d78-95c055ad24a0, supplied50socials/500RK/2500runs.

Sequence with source/build freeze and own viewport ownership:

1. Ordinary beta tab386 was responsive: native browser controls, screenshots, DOM measurements, clipboard and viewport operations all completed quickly.
2. At1440×900,100%, settled light theme, navigated same tab to scale fixture `/accounts`.
3. Initial query showed All0 while loading. Waited specifically for visible button `Усі500`; this wait succeeded.
4. Next heading read timed out on browser `Runtime.evaluate` after3s. Screenshot then timed out after15s and reset the cua_repl kernel.
5. Tried independent nativeChrome observation: `getApp('Google Chrome')` took17s and returned noWindowsAvailable; inventory then listed Chrome running but browsers[]; exact bundle-id getApp took17s and timed out.

No native screenshot, scrolling, menu or pointer interaction could be observed after this point. Thus the data establishes **scale-correlated loss of available browser/native control**, while browser rendering, OS pressure, extension failure and tool failure cannot yet be separated. Do not claim scale responsiveness, exact500ms latency or SC004 frame targets pass. Reproduce in a recovered browser, record memory/main-thread evidence and determine whether the all-expanded component tree is too large before approving.

## Recovery and limits

- Initial stuck root359 could not be rebound, but nativeChrome worked. Created own386 via nativeCmd+T, navigated beta, then getTab386 worked. This recovered normal review without killingChrome or touching Launches355.
- Closing root359 prompted deletion of its synced tab group; cancelled that prompt and left359 intact.
- No full pointer trajectory or reduced-motion test completed; no frame timing asserted.
- Native zoom restored100% before scale navigation. Last viewport override1440×900; extension disappeared, so final reset/own-tab close could not be performed. Root informed explicitly. Reset once extension recovers.

## Improvements remaining

1. Resolve/reproduce D8 with actual scale interactions, then complete mixed-fold pointer reorder/restoration and quantitative frame capture through supported tooling.
2. Optional polish: distinguish the two identically named `Дії за обраний день` menu triggers for assistive technology (period/copy versus clear-day actions). Both are functional, but distinct names reduce discovery ambiguity.
