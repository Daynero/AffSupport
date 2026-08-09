# Research: Спільна галерея лендінгів командного простору

**Feature**: `004-team-landings-gallery` | **Date**: 2026-08-09

All Technical Context unknowns are resolved below. No `NEEDS CLARIFICATION` remains.

---

## 1. Where do shared renders live? (the central decision)

**Decision**: Persist rendered landing previews as **WebP segment files in a hidden subtree of
the connected Drive root** — `.soty/landing-previews/<materialId>/<sourceVersion>-<fingerprint>/<preset>/<segment>.webp` —
and record a small pointer row per (material, sourceVersion, fingerprint, preset) in a new
`landing_renders` table. Serve those bytes to the browser through the existing `drive-transfer`
cloud byte path (no agent needed to *view*); require a paired agent only to *produce* a render.

**Rationale**:
- **Satisfies FR-007 / SC-003 / SC-004** — an agent-less member fetches a render another member
  already produced, because the bytes live in shared Drive and stream via `drive-transfer` (the
  same bounded, no-store Range path already used for team media preview in US4).
- **Honours the spec assumption "no new cloud storage or auth"** — reuses the one shared Drive
  connection and its service-side credential path; no new bucket, provider, or token.
- **Self-invalidating** — the artifact path is keyed by the material's immutable
  `sourceVersion` + `fingerprint`. A replaced landing gets a new source identity, so its old
  render no longer matches (`hasVersionedLandingProof` semantics) and is treated as stale
  (FR-006, SC-007). Cleanup rides the existing `catalog-sync` tombstone pass, which already
  reconciles removed/replaced source files.
- **Reuses the audited security path** — artifacts are written service-side / via a scoped
  transfer grant with the shared account (as US5 process-output upload does), never a broad
  browser token; served bytes are inert WebP, never executed.

**Alternatives considered**:
- *Agent-only, ephemeral (no persistence)* — simplest, but fails SC-003 outright: a member
  without a running agent would see an empty gallery. Rejected.
- *Supabase Storage bucket* — clean separation, but is a new cloud-storage surface needing its
  own bucket RLS, signed-URL policy, retention, and cleanup, and contradicts the "no new cloud
  storage" assumption. Rejected for the first release; revisitable if Drive write pollution
  becomes a problem.
- *Postgres blob (bytea) in the catalog* — full-page landing screenshots are large; storing
  them in-row bloats the table and the realtime change payloads members subscribe to. Rejected;
  only small pointer rows go in the DB.

**Mitigations for Drive write pollution**: a single hidden `.soty/` namespace, excluded from
the catalog listing/classifier, documented in `TEAM_WORKSPACE_OPERATIONS.md`, and removed with
the source by the tombstone pass.

---

## 2. How does the gallery list landings? Reuse vs. add

**Decision**: The gallery is a **`category = 'landing'`-scoped view over the existing
`searchCatalog` RPC** and the `useCatalogSearch` hook, wrapped by a thin `useTeamLandings`
hook. Facets (GEO / offer / language / tags) come from the existing `getCatalogVocabulary`.

**Rationale**: Landings are already first-class catalog materials
(`packages/shared/src/team/material-category.ts` classifies HTML by mime/extension and archives
via landing-promotion). No new listing/search/RLS path is needed — team isolation, pagination,
freshness state, and realtime refetch already hold (001 US3). Adding a category filter to the
existing search is strictly less surface than a parallel listing.

**Alternatives considered**: a dedicated `list_team_landings` RPC — rejected as duplicative of
`searchCatalog` with a fixed facet; it would re-implement isolation and pagination for no gain.

---

## 3. What is "works together with the local previewer"? (FR-016)

**Decision**: Two concrete, verifiable couplings, both reuse-first:
1. **Shared render engine + preset model** — the team gallery renders through the *same*
   `apps/agent/src/landing-preview/renderer.ts` (`LandingPageRenderer`) already used for the
   team single-preview fallback, and reuses the local previewer's viewer-preset model (device
   size / colour scheme / zoom / grid) from the shared `LandingPreviewState` types. Identical
   engine ⇒ identical previews (SC-…/acceptance US3-4).
2. **Open the space as a catalog in the standalone previewer** — extend the local previewer's
   catalog source (`apps/agent/src/landing-preview/catalog.ts` + `scanner.ts`) so, in addition
   to a local folder, it can take a **connected team space** as a source: it enumerates the
   space's landings via the team catalog and renders/serves them through the same team-bridge
   range-download the single preview already uses. This is the P3 slice of US3.

**Rationale**: "Works together" is ambiguous; these are the two readings that add real value
and both maximise reuse. Coupling #1 is the load-bearing one (it makes the two experiences
consistent and is needed for US1/US2 anyway); coupling #2 is additive and isolated to the
non-team previewer surface, so it can ship last without touching the team gallery.

**Alternatives considered**: a shared UI component rendered in both places — rejected; the team
gallery needs team permission/realtime/Drive wiring the local previewer must not have, so
sharing the *engine + preset model* (not the component) is the correct seam.

---

## 4. Agent-required lifecycle & truthful states (FR-008, SC-004)

**Decision**: Reuse the existing agent-compatibility handshake — `openTeamAgentPreview` already
checks `/api/health` + `toolContractCompatible('teamWorkspace', …)` and surfaces
`PAIRING_REQUIRED`/`CONNECTION_FAILED` → `teamPreviewAgentRequired` and `AGENT_UPDATE_REQUIRED`
→ `teamPreviewAgentUpdateRequired`. The gallery tile carries an explicit render-state union
(`ready | candidate | rendering | needs_agent | agent_outdated | error`) derived from: whether a
matching shared render exists (view without agent), whether a paired compatible agent is present
(can produce one), and typed unavailable reasons from `preview.ts` classification
(`corrupt | protected | too_large | unsupported | agent_required`).

**Rationale**: A tile must never claim "ready" without a fetchable render. Separating "a shared
render exists" (server fact) from "I can produce one now" (agent presence) makes SC-004's
zero-false-ready property structural, not a UI guess.

---

## 5. Thumbnail format, sizing, and gallery performance (FR-017, SC-005)

**Decision**: Thumbnails are the first WebP full-page segment produced by `LandingPageRenderer`
(viewport 1440×900), downscaled for the grid; full segments are fetched only on open (US2).
The grid loads lazily (viewport-based) and the catalog query paginates as it does today, so the
first visible page renders from already-available render pointers without waiting for the whole
set.

**Rationale**: Reuses the renderer's existing WebP output (no new encode path), and lazy +
paginated loading meets ≥300 landings / first page < 2 s p95 (SC-005) with the same envelope as
the existing catalog result grid.

**Alternatives considered**: pre-generating a separate small thumbnail artifact — deferred; the
first segment downscaled is sufficient for v1 and avoids a second artifact class.

---

## 6. Invalidation & cleanup keying (FR-006, SC-007)

**Decision**: A `landing_renders` row is valid iff its `source_version` + `fingerprint` equal
the material's current immutable values (the exact predicate `hasVersionedLandingProof` already
uses to gate landing-promotion). `catalog-sync` already detects source change/removal and writes
tombstones; extend that pass to (a) mark superseded render rows stale and (b) delete their hidden
`.soty/landing-previews/…/<old-source>/` artifacts. Reading a stale/absent render yields
`needs_agent` (re-render) rather than a stale image.

**Rationale**: One invalidation rule, already trusted for classification, now also governs
renders — no second notion of freshness to keep in sync.

---

## 7. Contract versioning & backward compatibility (Constitution II)

**Decision**: New agent routes (`/api/team/landings/*`) register under the existing
`teamWorkspace` tool contract in `packages/shared/src/release.ts`; bump only that tool's
contract version. Old agents fail the new routes with `AGENT_UPDATE_REQUIRED` and keep serving
all existing tools. `PRODUCT_VERSION` and `AGENT_API_VERSION` change only if independently
warranted. `scripts/real-agent-check.mjs` and `tests/release.test.ts` extend to cover the new
routes (mirrors 001 T121).

**Rationale**: Same discipline 001 used to add team routes without breaking the compressor /
transcription / landing tools; a single source of truth for the contract.

---

## 8. Security model reuse (Constitution III, FR-010, FR-011)

**Decision**: Preview and gallery listing gate on `view` (a plain viewer sees and opens
landings); `download`/`edit` stay separate capability flags shown only when granted. Render
artifact **writes** use a service/scoped-grant path with the shared account (no browser Drive
token). New SQL functions are `security definer`, `search_path=''`, fully-qualified,
`revoke all` → narrow `grant`, with caller (view) vs service (write/commit) separation. The
sandbox (`sandbox='allow-scripts'`), CSP (`connect-src 'none'`), and navigation guard are reused
unchanged; served render bytes are inert.

**Rationale**: New surface inherits the existing posture rather than opening a hole beside it;
the only new authority is "write a render artifact with the shared account", scoped exactly like
US5 process output.

---

## Summary of decisions

| # | Topic | Decision |
| --- | --- | --- |
| 1 | Render storage | Hidden Drive subtree `.soty/landing-previews/`, pointer rows in `landing_renders`, served via `drive-transfer` |
| 2 | Listing | `category=landing` over existing `searchCatalog` + `useCatalogSearch` |
| 3 | Local-previewer interop | Shared render engine + preset model (P1/P2); open space as previewer catalog (P3) |
| 4 | Agent lifecycle | Reuse handshake; explicit tile render-state union; zero false "ready" |
| 5 | Thumbnails/perf | First WebP segment downscaled; lazy + paginated grid |
| 6 | Invalidation | `source_version`+`fingerprint` match; tombstone pass cleans stale artifacts |
| 7 | Contract | New routes under `teamWorkspace` tool contract; old agents → `AGENT_UPDATE_REQUIRED` |
| 8 | Security | View to read, service/scoped-grant to write; sandbox/CSP/nav-guard reused |
