# Buyer review — round 5

2026-10-18, independent actual beta parity review. Dedicated Chrome tab766198405, closed after review; viewport390override reset. **92/100. Not accepted: confirmed mobile row geometry defect.** Earlier98review score does not override newly found evidence.

## Required fix — mobile row layout

At390×844, unified RK row inherits legacy card `grid-template-areas: "rail id" "rail status" "rail note" "rail actions"`. Unified finance child has `grid-area:fields`, creating an implicit extra row. It therefore is not a desktop-like single horizontal table row with internal horizontal scroll.

Actual read-only DOM geometry on testBUYERFINAL-RENAMED RK88009902:

| Part | Top CSS px | Left CSS px |
|---|---:|---:|
| Whole row |1659.71|33|
| Identity |1668.71|48|
| Status |1805.10|48|
| Runs |1820.56|48|
| Actions |1898.94|48|
| Finance fields |1947.13|881|

Row height394.45px, width1380px. Finance fields lie below all identity/status/actions and far to the right. Screenshot in tool output shows large blank space and stacked card controls. This confirms the issue independently of root's code hypothesis. Reset legacy areas and child placements within the unified-table override; retest390/768/default plus date ranges and launch rows.

## Parity passed through actual UI

- New fake beta socialBUYERFINAL created with public fixture seed`JBSWY3DPEHPK3PXP` and RK88009901. Renamed social toBUYERFINAL-RENAMED successfully.
-2FA button copied actual six-digit code715100; success toast and22-second countdown observed. Cleared seed via edit;2FA button disappeared. No real secrets used or changed.
- Edited RKID88009901→88009902; identity/copy control/financial labels updated.
- Empty RK tag picker links to settings. Followed link, created RKtagBUYERFINAL, returned and assigned tag. Header count1 and row tag visible. Minor existing label says“Зняти … з цього завдання” for RKtag; should say РК.
- Assigned manual runFINAL PARITY, edited it toFINAL PARITY EDITED; busy count and row updated.
- Morning flow in unified table after rename/IDedit: todaybalance20, yesterdayspend3, todaytopup8 saved. Todaytotals5/128, yesterday spend excluded.
- Actual clipboard by tags grouped88009902-$8 underBUYERFINAL; archived88003801-$50 and88003803-$70 remained under“Без тега”.
- MonthOctober1–31 selected, report renders numeric aggregates, totals88/128 consistent with previous fixture records plus new test3/8. Existing archived9-spend and0case still represented.
- Dirty balance20→21 then clicked launch navigation: proper save/discard/stay guard appeared. Chose Stay, then Cancel; test20preserved.

## Explicit limits

- Clicked Excel export while awaiting browser download event; bridge timed out30s and reset, so actual file/output not certified. No visible error was observed after rebinding. Do not call that a proven application failure or a successful export.
- Custom range was not completed after download-bridge timeout. Existing task peek navigation had no related-task fixture on the new RK; no pass claimed.
- No continuous frame-time, live-midnight, full concurrency/offline/release certification from this round. Designer's independent tests cover scale but their earlier score must be reconsidered for this new geometry evidence.

Root received GO to fix after all UI operations ended. No app source modified by reviewer. Testsocial/RKtag/run/financialrecords retained locally for regression;2FAseed cleared. No production changes or destructive deletion.
