# Implementation Plan: Automatic catalog content

**Branch**: `055-automatic-catalog-content` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md)

## Summary

Render one of 2,000 shared indexed text variants for each selected image, with an exhaustive category price policy. New server-owned intents carry policy version 1; existing frozen inputs retain the legacy path. Keep final choices in durable creation and active updater-round recipes. Remove catalog setup UI and its server pool-generation lane. Integrate completed work into the isolated next-release branch.

## Technical Context

**Language/Version**: strict TypeScript/ESM, existing Node22/Deno and PostgreSQL stack.
**Primary Dependencies**: existing shared contract package, Edge catalog functions, React/HeroUI, PGlite/Vitest. No new package or external generation service.
**Storage**: existing catalog intent checkpoints and catalog snapshots; one protected latest updater recipe per catalog plus bounded scalar attempt receipts. Retain old settings/pool tables.
**Testing**: pure content tests, real full-chain SQL/Edge tests, updater recovery tests, UI/routes, SQL-to-read-only-CLI diagnostics, 100-sample benchmark and canonical gates.
**Target Platform**: existing hosted catalog workers and desktop web/macOS/Windows clients; no platform branching.
**Project Type**: existing monorepo feature.
**Performance Goals**: 200 image-to-content rows p95 ≤100ms over100 local samples; no per-row network/DB calls; fixed2,000-entry selection space.
**Constraints**: immutable retries, additive migration, legacy/rollback compatibility, no production actions, one heavy verifier at a time.
**Scale/Scope**: all32 classified garment categories,1–400 rows/catalog, bulk Launches, catalog growth/refresh and removed space setup.

## Constitution Check

Before research and after design: PASS. Typed pure domain policy lives in shared; unknown boundaries are narrowed. Existing auth, lease/fence, origin and publication authority remain intact. Service-only SQL uses empty search_path and revoked grants. No new transport, recurring browser poll, dependency, agent subprocess or release identity. UI removes controls using existing routes/components/tokens. Diagnostics expose only validated scalar policy/count evidence. All work remains in isolated branches; full release and shared-pool activation gates remain mandatory.

## Design

1. `packages/shared/src/team/catalog-content.ts`: exactly2,000 stable indexed variants from40×50 model-word combinations, neutral description templates and an exhaustive price map keyed by existing image garment vocabulary. `createCatalogContentDraw(random)` shuffles indices without rejection sampling and returns coherent text/price/variant metadata for known or unknown facts. Unknown/ambiguous legacy filenames use neutral wording. Price bounds remain versioned code, not saved per-space settings.
2. A server-owned insertion marker `checkpoint.contentPolicyVersion=1` identifies new standalone intents. Launch children inherit automatic policy only from accepted prefixed source versions. Existing intents and frozen resource checkpoints never acquire policy retroactively.
3. Preserve the prior source hash in a legacy helper. New Launch source hashes include automatic policy/image identity but exclude retired texts/prices. Resource-freeze functions retain parent-before-child lock order, permissions, source checks, lease/fence and existing image allocator. Automatic resources contain defaults and no per-space texts; old accepted resources retain legacy behavior.
4. Durable creation selects automatic vs legacy planning from the marker before settings reads. Automatic paths have no saved-settings prerequisite; retain any admitted legacy image fallback. Persist final row recipe, sheet rows and policy marker before provider publication. Parse metadata strictly and reuse it on retry.
5. Updater generation follows final image selection. Existing retained rows keep text and price; new rows and intentional text refresh use automatic content. Use stable attempt identity for growth count, then read/freeze one final active-round recipe before write, preserving it after a proved unchanged provider write. Bound storage to one latest recipe per catalog and record historical scalar counts on the attempt. Existing uncertain-write reconciliation remains authoritative. Frozen video-only publication paths remain untouched.
6. Stop invoking per-space text-schedule regeneration; keep historical data/RPC readers. Do not reinterpret retired schedules as active automated evidence.
7. Remove Catalog from space settings, its dirty guards, automatic price writes and settings-read blockers. Old catalog settings links normalize to the catalog manager. Keep restitch setup, R2 controls and per-catalog schedule/profile controls.
8. Extend existing diagnostics with content policy/counts and global-image errors. Standalone `inspect` must actually join catalog generation evidence. Updater receipts distinguish automatic and retained rows and do not read today's snapshot as historical evidence. Missing columns/signals remain explicit.

## Project Structure

Documentation: `specs/055-automatic-catalog-content/{spec,plan,research,data-model,quickstart,tasks}.md`, `contracts/content.md`, `checklists/requirements.md`, `reviews/`.

Source: `packages/shared/src/team/catalog-content.ts`; existing `supabase/functions/_shared/product-catalog.ts`, `catalog-image-rows.ts`, `drive-ops/catalog-durable.ts`, `drive-ops/product-catalog.ts`, `catalog-updater/{worker,index}.ts`; new additive `supabase/migrations/20261208120000_automatic_catalog_content.sql` and diagnostic migration `20261208121000_automatic_catalog_content_diagnostics.sql`; existing web workspace/creation/Launch/manager modules and central `tests/`; existing `scripts/analytics` projections/queries/registry.

## Execution and validation

The detailed invariants in [contracts/content.md](contracts/content.md) are authoritative: immutable policy marker and source identity; base-bound recipe restore before allocation; unresolved-write replacement refusal; exact per-attempt count sums and exact-id inspection. These close the second analysis findings A1–A5. Legacy browser image fallback is admitted by the server without reading text/price settings; global/R2 readiness remains exact.

Shared policy contract comes first. Backend/DB, UI retirement and diagnostic adapters can be edited independently after that contract is fixed; root coordinates integration and runs heavy checks serially. Spec Kit research used three read-only research agents. Implementation tasks may be delegated along these file boundaries; no two agents modify one file and no agent starts an independent heavy verifier.

Run two analysis/fix passes before implementation, then meaningful focused checks, canonical static/suite/build and isolated database checks. Record actual skips and release blockers. Use a desktop screenshot of remaining settings and representative generated rows; do not show mobile layouts. Merge the feature and newly completed independent fixes into the next-release branch only after checks; no main/beta/release mutation.
