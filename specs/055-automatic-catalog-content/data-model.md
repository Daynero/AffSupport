# Data model

- `CatalogContentFacts`: validated garment name or null and normalized color or null. Unknown category does not assert a garment or color from malformed metadata.
- `CatalogContentVariant`: stable integer id0–1999, two-word model identity and neutral template wording. Version1 has exactly2,000 entries.
- `CatalogPriceBand`: inclusive integer `min`/`max`, exhaustive for32 garment names. Proposed ranges: basic tops12–28; shirts/blouses20–44; knitwear/hoodies28–60; trousers/skirts18–75; dresses/jumpsuits45–110; jackets/coats65–180 (overshirt45–85). Unknown20–40. The exact per-garment table is canonical in code and verified exhaustively.
- `CatalogContentSelection`: title, description, price, policyVersion1, variantId. Selection exhausts a shuffled pool then cycles safely; no cross-catalog uniqueness guarantee.
- New generation intent checkpoint: server-owned `contentPolicyVersion:1`. Absent means legacy; unknown versions are refused. Completed settings snapshots/rows preserve policy metadata where present.
- Frozen resource recipe: settings/defaults, selected image union, legacy texts or empty automatic texts, source version and policy marker. Existing frozen recipe is returned verbatim.
- Frozen automatic row: existing row fields plus optional `contentPolicyVersion` and `contentVariantId`; final bytes persisted before provider writes. Mixed updater snapshots preserve unmodified legacy rows.
- Active updater content recipe: catalog identity, stable update attempt, source/fence context and bounded final snapshot (≤400 rows). At most one latest recipe per catalog. Same attempt cannot replace its recipe; a new legitimate attempt replaces it. Permission/lease/round checks precede reads/writes. Historical attempt receipts retain only policy version, planned count, automatic count and retained count.
- No old pool/settings/schedule rows are deleted. Historical generation/update evidence remains readable; missing policy means legacy or unavailable evidence, not automatic success.
