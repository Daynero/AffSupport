# Feature Specification: Automatic catalog content

**Feature Branch**: `055-automatic-catalog-content`

**Created**: 2026-11-13

**Status**: Ready for planning

**Input**: Automatically pair every catalog image with a name, description and sensible random category-based price. Use one shared pool of 2,000 text variants. Remove Catalog from space settings so users need no setup. Include this work in the next release integration without affecting the current release.

## User Scenarios & Testing

### User Story 1 — Create a catalog without setup (Priority: P1)

A member creates one catalog or a batch of Launches in a new or existing space. Each image receives matching text and a plausible price automatically.

**Why this priority**: Pool generation and price configuration must no longer block the main workflow.

**Independent Test**: Create a catalog in a space with no saved catalog settings or text pool; inspect the delivered rows.

**Acceptance Scenarios**:

1. Given a new space and available shared images, when a catalog is generated, every delivered row contains a valid image, matching title and description, and a price within its category range.
2. Given a black T-shirt and a coral dress, when rows are assembled, their names and descriptions identify the respective garment and color; the dress price range is above the T-shirt range.
3. Given multiple simultaneous Launches, when one fails, the others receive complete paired rows and continue independently.
4. Given a replacement for an old catalog generation, when new rows are added, they receive automatic content without requiring legacy pool/settings setup.

### User Story 2 — Recover and update consistently (Priority: P1)

A member can leave the app, retry an interrupted operation or allow scheduled updates without having text and prices change accidentally.

**Why this priority**: Stable results and recoverability are part of the product promise.

**Independent Test**: Lose an acknowledgment, restart a worker, and resume the same catalog operation; compare all frozen row values before and after.

**Acceptance Scenarios**:

1. Given a persisted generation, when it is retried or observed again, its image/text/price combinations remain identical.
2. Given an intentional scheduled image-and-text refresh, when new rows are selected, their new texts and prices form valid category-matched combinations.
3. Given existing manually edited or retained rows, when only unrelated fields are updated, their text and prices remain unchanged.
4. Given an unclassified legacy image, when automatic content is required, safe neutral text and a bounded fallback price are used without invented garment/color claims.
5. Given a provider outage or canceled generation, when recovery runs, unconfirmed side effects are reconciled using existing operation identities and independent jobs keep progressing.

### User Story 3 — Remove configuration work (Priority: P2)

Space settings contain no Catalog section or controls to generate text pools, set catalog prices, or schedule pool generation. Creation and catalog management stay accessible in their existing product locations.

**Why this priority**: Users should not need to discover or maintain hidden prerequisites.

**Independent Test**: Open settings for a new and an existing space, then create and manage a catalog through their normal entry points.

**Acceptance Scenarios**:

1. Given any member role, when settings are opened, no Catalog section or obsolete pool/price setup prompt appears.
2. Given old configured pools and schedules, when the new workflow is used, old data is retained for compatibility but does not block automatic catalog creation or trigger pointless regeneration.
3. Given a failure unrelated to text setup, when it is shown, the user receives the actual recovery action rather than a link to removed settings.

### Edge Cases

- Empty space; no legacy settings; empty/exhausted legacy text pool; disabled legacy generation schedule.
- Exactly 2,000 variants; draw larger than pool; concurrent calls; deterministic retry across process restart; future pool versions.
- Repeated image, different image with same category/color, rare or unknown category, malformed stored classification.
- Missing image, no healthy shared pool, permission loss, cancellation, lease expiry, missing or delayed commit acknowledgment.
- Restitch variants, direct catalog creation, queued durable Launches, R2 and Drive publication, scheduled growth and refresh, explicit retention of existing text.
- Migrating existing catalogs and saved manual edits; old clients and rollback-compatible schema; no destructive cleanup during integration.
- Telemetry disabled or delayed; diagnostics must not expose names, descriptions, prices, URLs or provider payloads.

## Requirements

### Functional Requirements

- **FR-001**: Provide exactly 2,000 shared text variants, available without per-space generation, paid AI calls or an external text service.
- **FR-002**: Choose content for each selected image as one coherent row. Known garment and color must agree in image metadata, title, description and derived product attributes.
- **FR-003**: Maintain predefined inclusive integer USD price ranges by garment category. Choose the price when assembling the row; T-shirts/basic tops must have lower ranges than dresses and jackets. Unknown categories use a documented neutral range.
- **FR-004**: Prevent duplicate generated titles within one catalog while unused compatible variants remain. Exhaustion must cycle safely without hanging or failing the batch; global uniqueness across all catalogs is not promised.
- **FR-005**: New catalogs, new rows and intentional content refreshes must work without any saved catalog settings or per-space text pool.
- **FR-006**: Reuse persisted choices for the same operation and retry. A reread, rerender, reconnection, lease handoff or lost acknowledgment must not reroll content or prices.
- **FR-007**: Existing rows, manual edits, frozen in-flight generations and explicit retention choices must remain intact until an intentional applicable refresh.
- **FR-008**: Remove the entire Catalog section from space settings and redirect or remove obsolete setup instructions. Keep catalog creation and management available.
- **FR-009**: Stop unnecessary per-space text-pool regeneration for this automatic workflow without deleting existing pools, history or schedules needed by compatible historical clients.
- **FR-010**: Preserve existing authentication, permissions, cancellation, bounded retry, resource freezing and independent batch failure behavior.
- **FR-011**: Ship on an isolated feature branch then integrate into the next-release branch; no production publication, pool activation, cleanup or version change is authorized by this task.
- **FR-012**: Describe only image facts supported by classification. Do not invent material composition, sizes, care instructions or other factual product attributes from an image filename.

### Analytics & Diagnostic Coverage

- Reuse catalog/Launch creation and updater operation/attempt correlation. Evidence must distinguish resource selection, frozen automatic content, publication, completion, cancellation and delivered result.
- Record bounded content-policy/version and row-count evidence where existing protected diagnostic records cannot identify automatic content; never collect row text, prices, image names, raw paths, URLs or provider responses in telemetry.
- Extend read-only `inspect`/`investigate` coverage and capability inventory as needed so diagnostics can distinguish missing images, invalid classification, uncommitted content, provider failure and missing result visibility. Existing stable codes remain preferred.
- Verify a healthy creation, retained/retried snapshot, canceled or failed operation and missing/delayed evidence from production seam to CLI mapping. An event alone does not prove user-visible delivery.
- Retired pool-generation controls must not remain a falsely required capability. Historical evidence remains readable and missing collection remains unknown.

### Key Entities

- **Shared text variant**: stable identity and version; garment/color slots and neutral descriptive wording.
- **Category price policy**: garment category, inclusive lower/upper USD bounds and policy version.
- **Frozen catalog row**: selected image, final text, price, source policy identity and existing operation identity.
- **Historical catalog configuration**: retained previous values and pool records, no longer a prerequisite for new automatic rows.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All tested first-time creation paths succeed with zero catalog setup actions when their image/provider prerequisites are healthy.
- **SC-002**: All classified test rows match their image's garment/color and category price range, including every supported garment category.
- **SC-003**: Exactly 2,000 shared variants are available; 2,000 compatible selections avoid repeated titles and an oversized request terminates safely.
- **SC-004**: All injected retry/restart/acknowledgment-loss cases preserve the originally frozen row values. Retained historical/manual rows remain byte-identical.
- **SC-005**: Generating text and prices for 200 already selected images adds at most 100 ms at p95 in a documented local 100-sample benchmark, excluding provider I/O; no text-provider request or per-row storage round trip occurs.
- **SC-006**: No catalog settings or dead setup links remain in the supported desktop flow. Regression, type, design, migration and applicable release build gates are recorded with their actual outcomes.
- **SC-007**: Diagnostics explain all injected failures with available evidence and explicitly identify missing evidence without leaking product content.

## Assumptions

- “2,000 names and descriptions” means 2,000 shared variants rendered for each image's known facts, not 2,000 copies per space or per image. This preserves category coverage as images change.
- Text remains English and prices remain whole USD, matching the existing feed. Price bands are generated catalog values, not live market prices.
- Images reuse the existing shared pool and its explicit activation requirements. This task does not activate the pool in production.
- Safe defaults apply to new rows. Existing completed/frozen data and manual edits are not retroactively rewritten.
- UI review is desktop only as requested. Existing background workflows and transports remain in place.
