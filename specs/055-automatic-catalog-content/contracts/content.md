# Automatic content contract

Shared pure API (`packages/shared/src/team/catalog-content.ts`):

- `AUTOMATIC_CATALOG_CONTENT_VERSION = 1`
- `CATALOG_CONTENT_VARIANT_COUNT = 2000`
- `catalogPriceBand(garment: string | null): { min: number; max: number }`
- `createCatalogContentDraw(random?: () => number)` returns a function accepting `{ garment: string | null; color: string | null }` and returning `{ title: string; description: string; price: number; policyVersion: 1; variantId: number }`.
- Returned titles are ≤200characters, descriptions ≤9999, prices positive inclusive whole USD. Caller persists selected values. Random input is bounded defensively and cannot create invalid indices or an unbounded loop.
- Automatic rows blank unsupported material, size, pattern, style, gender and shipping fields instead of inheriting random factual claims; known garment/color/category remain populated. Legacy rows keep their original fields.
- A full cycle produces2,000 distinct model identities and titles for identical facts. The next cycle is allowed to repeat. No external requests.

Catalog boundary:

- New standalone intent inserts seed checkpoint policy1. A Launch child seeds it only for the matching automatic accepted revision. Legacy existing checkpoint remains unchanged.
- The marker is immutable after insertion; later checkpoint merges cannot upgrade an existing empty legacy intent. Source hashes include immutable policy/config and source content identities, excluding draw cursors, use counters, readiness timestamps and expiry.
- Freeze functions return existing resources before recomputation. Automatic resources need no per-space text/price settings. Unsupported policy is invalid response, never silently downgraded.
- New content is rendered only after final image selection. Existing frozen recipe always wins. Intentional refresh replaces applicable values; retain means preserve text and price.
- Updater active-round freeze is service-only, lease/attempt fenced and immutable for that attempt. No HTTP operation can set its own authority. Store one latest recipe/catalog, separate bounded scalar historical receipts.
- Bind the recipe to original update count, product count, settings snapshot and round/profile identity. Restore before image allocation, growth randomness, text draws or sharing; reject changed base. Never replace an earlier recipe while provider reconciliation is unresolved. Revalidate image authority before publication.
- Receipt scalars are `content_policy_version`, `planned_row_count`, `automatic_row_count` and `retained_row_count`. Counts refer to that frozen attempt, not later snapshots. A creation has no retained rows; an updater may have both. Unknown/malformed values remain null in diagnostics.
- `automatic_row_count` counts newly generated rows in this attempt, including zero when earlier automatic rows are retained. Enforce integer counts0–400, planned1–400 and automatic+retained=planned. The early policy marker alone is admission evidence; counts remain null until a validated recipe is frozen.

UI boundary:

- No supported `product-catalog` settings tab; legacy bookmarks normalize to the manager preserving workspace context.
- No reads/writes of catalog price/text settings merely to enable or confirm creation. Restitch configuration remains separate.
- Defer legacy image fallback admission to the authoritative generator rather than reading retired settings in the browser. Preserve exact readiness checks for admitted global/R2 image sources and genuine errors. Keep the restitch CTA with its restitch-specific label and update reused manager effect text.

Diagnostics:

- Expose only validated policy/count scalars, existing operation identifiers, closed stage/error codes and evidence quality. No generated content, image facts, prices, paths or provider URLs.
- `inspect` and `investigate` distinguish recipe persistence from result visibility. Missing or malformed scalars stay unknown. Historical updater proof comes from that attempt's receipt.
- Standalone inspect matches exact intent/operation id only, never an actor/team search result. Append view columns with existing order/ACL intact. New-policy audit treats text-schedule generation as retired while historical queries remain available.

- `content_receipt_status` is closed: `unavailable`, `policy_selected`, `frozen`, or `invalid`. Admission alone is `policy_selected`; only a validated complete frozen recipe/receipt is `frozen`.
- Text scheduling records `retired_since_content_policy_version: 1` with basis `source_policy`; historical coverage remains unknown unless observed. This does not claim that hosted workers are already upgraded.
