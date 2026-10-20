# Independent designer review — round 1

Date: 2026-10-18. Reviewer: designer agent. Actual local beta route `/team/22222222-2222-4222-8222-222222222222/accounts`, independent Chrome tab 766198365. UI interactions exclusively through cua_repl. Read DESIGN.md, DESIGN-PRINCIPLES.md and 038 spec/handoff. Root was applying hot reload fixes while review ran, so findings describe observed first-round behavior and require fresh verification.

**Score: 68/100.** The merged surface is understandable and uses existing component language, but focus visibility and misleading save results prevent daily reliable use. This score is not a final acceptance score.

## Prioritized findings

1. **D1 — high: sticky column captions obscure table rows.** At default desktop ~1384×666, click the DESIGN038 RK name to cycle color. Browser brings the row into view. Captions `РК / СТАТУС / ЗАПУСК / ЗАЛИШОК…` remain painted across y360–410, covering the RK name/status/input contents rather than sitting above the table. Inputs and identity become slivers. Root reports a new internal scroll owner fix; not yet independently retested.
2. **D2 — high: narrow sticky toolbar hides keyboard focus.** At 390×844, toolbar occupies roughly y102–545; editing a field adds Save/Cancel and grows it further. Click DESIGN038 balance, type `-1`, Tab. AX focuses yesterday expense, but screenshot shows only a blank social block below the toolbar; the focused field is invisible. Compact sticky essentials and explicit focus scroll clearance are needed. Search/filter/export/copy/month presets should not consume most of the narrow viewport persistently.
3. **D3 — medium: reorder announcements expose internal UUID in English.** Space on DESIGN038 move button announces `Picked up draggable item ea42fd8a-…`; Escape announces `Dragging was cancelled. Draggable item [uuid] was dropped.` Provide localized names and meaningful ordinal/total positions for pickup/move/drop/cancel. Existing collapse and restoration worked, as did focus return.
4. **D4 — high: create social reports failure after successful write.** Create DESIGN038, save. Inline message `Не вдалося зберегти. Спробуйте ще раз.` appears; after Cancel the social exists. Root reports composite response parser and duplicate submission guards fixed. Requires round 2 verification.
5. **D5 — high: new active RK disappears until reload.** Add `99003801` under DESIGN038. Toast says `DESIGN038-801 додано`, but entire social vanishes from unfiltered view and All remains 1. Reload later returns the social/RK and All becomes 2. Root reports financial snapshot retention fixed. Requires round 2 verification.

## Positive evidence

- Name click moved from no color to green, preserved across reload, with descriptive localized accessible name.
- Four financial fields identify RK, exact target date, category and currency in accessible names.
- Invalid negative money shows `Некоректна сума` after Save and retains draft; Cancel clears draft.
- Reorder Space collapses all social groups. Up then Escape restores originally expanded groups and focuses original move button.
- Secondary archive/move/copy controls are distinguishable through accessible names.

## Remaining verification

Light theme, full eight-color cycle, 768px/200% zoom, archived late editing, pointer long press, smoothness and reduced motion have not yet been independently completed. Do not count these as passed. Active compilation detached root during end of round, so fresh reload is needed for round 2. No product code changed by reviewer; only isolated DESIGN038 fixture created.
