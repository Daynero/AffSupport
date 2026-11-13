# Single-budget / SUB follow-up review

## Pass 1 — contracts and persistence
- Equal values violate both the existing shared calculator and SQL profile validator. Resolved by an explicit persisted `single` mode, one positive integer `maxBudget`, `budgets: null`, no `minBudget`. Auto/manual guards remain unchanged; the new migration replaces only the existing validator body and preserves its source, security and catalog checks.
- Applying a profile already replaces the complete reusable-field boundary. Regression proves old manual arrays/minimum cannot leak into single mode. Draft save/copy/reopen and both profile RPC scopes are exercised against the migration chain.
- Batch admission imports built shared output. The first isolated Edge regression found stale generated output; rebuilding the shared package (as canonical verify does) makes the real adapter derive equal amounts with distinct ordinal/ad ranges. No browser preview is trusted.
- No new worker, dependency, event payload or source read. Existing validation/save/admission/delivery correlation covers outcomes. Inventory documents intentionally unobserved mode clicks, amounts and SUB values; missing delivery evidence remains unknown.

## Pass 2 — desktop and boundary behavior
- Long SUB text initially expanded the fieldset and accordion grid item through intrinsic minimum sizes. Both now permit shrinking; the aside truncates, with the full resolved value on hover. Browser checks at 960/1024/1280/1440/1920 in both themes prove bounded layout, live updates, omitted unresolved/catalog slots and no page errors.
- Single mode exposes one field labeled per campaign, with no automatic lower bound seeded during count edits. Counts stay adjacent, with a larger separate gap before budget controls. Manual edits survive round trips through single/auto; 100 campaigns at one dollar stay valid. Empty/zero/fractional/oversized amounts and conflicting hidden fields are rejected.
- Server generation preview, naming preview, draft parsing, profile save and copy retain identical amounts. Existing strict automatic/manual behavior is covered. Shared/native/Edge consumers must ship together; older clients cannot interpret the added mode. No production schema or release changes are performed here.

Final verification and measured bundle evidence are recorded separately after checks complete.
