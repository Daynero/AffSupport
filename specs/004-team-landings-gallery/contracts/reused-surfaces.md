# Reused surfaces (do NOT re-spec)

Everything here already exists and is consumed **unchanged**. The feature adds only §
shared-render persistence and the gallery UI on top.

## From 001 (team media workspace)

- **Catalog listing/search** — `searchCatalog`, `getCatalogVocabulary` RPCs +
  `apps/web/src/team/catalog/useCatalogSearch.ts`. The gallery is a `category = 'landing'`
  scoped query over these. Team isolation, pagination, freshness, and realtime refetch are
  already enforced.
- **Classifier** — `packages/shared/src/team/material-category.ts`: `landing` = HTML
  mime/extension, or archive promoted via `landingPackageValidated` matching the current
  `sourceVersion` + `fingerprint` (`hasVersionedLandingProof`). Candidate = archive not yet
  validated.
- **Single-landing preview (view-gated)** — `supabase/migrations/20260801101500_team_preview.sql`
  gates on `private.can(p_team,'view',auth.uid())`; `download`/`edit` are separate flags.
  `drive-transfer` returns `kind:'agent'` + a `preview_range` grant for landing/archive.
- **Agent preview path** — `apps/agent/src/team-bridge/preview.ts` (`previewLanding`: range
  download → inspect → extract → local origin) and `preview-origin.ts`
  (`sandbox='allow-scripts'`, CSP `connect-src 'none'`, navigation guard, Playwright
  screenshot fallback via `LandingPageRenderer`).
- **Web single preview** — `apps/web/src/team/preview/MaterialPreview.tsx` +
  `LandingPreviewFrame.tsx`; `commitLandingValidation` → `service_commit_landing_preview_validation`
  (promotes candidate → `category='landing'`, `preview_state='ready'`).
- **Agent handshake** — `apps/web/src/api/client.ts` `openTeamAgentPreview`:
  `/api/health` + `toolContractCompatible('teamWorkspace', …)` → `AGENT_UPDATE_REQUIRED`; POST
  `/api/team/preview/landing`; no agent → `PAIRING_REQUIRED`/`CONNECTION_FAILED`.
- **Cloud byte serving** — `drive-transfer` bounded, no-store Range forwarding for media
  (US4); reused to serve cached render WebP to agent-less viewers.
- **Sync/tombstone** — `catalog-sync` incremental change replay + tombstones (US3); extended
  to clean stale render artifacts.
- **Permissions/realtime** — `private.can`, `TeamContext`, `useTeamRealtime`.

## From 002 (guided flow)

- **Content-first shell** — `apps/web/src/team/workspace/WorkspaceShell.tsx` with
  `content | search | settings` views and on-demand disclosure. Add a `landings` view here
  (FR-015) rather than a competing always-on panel.
- **Entered-space model** — `TeamContext` entered-space selection; the gallery lives inside an
  entered space.

## From the local landing previewer (non-team)

- **Render engine** — `apps/agent/src/landing-preview/renderer.ts` `LandingPageRenderer`
  (Playwright `chromium`, viewport 1440×900, full-page WebP segments, blocks external requests).
  Reused as the single shared render engine (FR-016).
- **Preset model** — `LandingPreviewState`/preset shapes in `@video-compressor/shared`
  (device / colour scheme / zoom / grid). Reused by the team viewer controls.
- **Gallery UX reference** — `apps/web/src/landing-preview/LandingPreviewPage.tsx` (catalogs →
  landings grid, search, zoom). Its catalog source is extended in US3 (P3) to accept a
  connected team space; the team gallery itself is a new, permission/realtime-wired surface.
