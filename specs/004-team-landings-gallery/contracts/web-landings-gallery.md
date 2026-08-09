# Contract: Web — `teamApi`/client methods + gallery UI

Web calls go only through the typed wrappers (`apps/web/src/api/team.ts`,
`apps/web/src/api/client.ts`); Supabase via `getSupabaseClient()`; live state via the existing
Realtime refetch, no polling. `className` + CSS custom properties, no inline static styles;
i18n via `useI18n` with new compile-checked keys in both `en` and `uk`; tree stays `any`-free.

## `teamApi` additions (`apps/web/src/api/team.ts`)

```ts
// Read valid render pointers for the visible landing page (caller = view). Wraps list_landing_renders.
listLandingRenders(teamId: string, materialIds: string[], preset: string):
  Promise<LandingRenderPointer[]>

// Mint an opaque artifactToken + range URL to fetch a cached render segment (agent-less viewing).
landingRenderImageUrl(artifact: RenderArtifactRef, segment: number): string
```

The gallery **listing** itself reuses the existing `searchCatalog` wrapper with a fixed
`category = 'landing'` facet — no new list RPC (research §2).

## Agent client additions (`apps/web/src/api/client.ts`)

```ts
// Produce/refresh a shared render (requires paired compatible agent). Reuses the
// openTeamAgentPreview handshake: health + toolContractCompatible('teamWorkspace', …).
renderTeamLanding(input: TeamLandingRenderRequest): Promise<TeamLandingRenderResult>
// throws AGENT_UPDATE_REQUIRED / PAIRING_REQUIRED / CONNECTION_FAILED (mapped to i18n as today)

teamLandingEventUrl(): string  // SSE for render progress
```

## Hooks / components (`apps/web/src/team/landings/`)

- **`useTeamLandings.ts`** — layers on `useCatalogSearch` (fixed landing facet) +
  `listLandingRenders` + `useTeamRealtime`. Produces `LandingGalleryItem[]` with the derived
  `tile` state (data-model §3). Refetches render pointers on catalog realtime markers and on
  reconnect; never treats cached rows as authority.
- **`LandingGallery.tsx`** (US1) — lazy/paginated grid of tiles; empty state
  (`teamLandingsEmpty`); no filters shown for an empty space (reuses `CatalogFilters` reveal
  rule); team-isolated by construction (server query).
- **`LandingGalleryTile.tsx`** (US1) — thumbnail (from `render.artifact` segment 0, downscaled)
  or state chip: `candidate` / `rendering` / `needs_agent` / `agent_outdated` / `error(reason)`.
  Optional download/edit only when `canDownload`/`canEdit`. Keyboard-operable
  (`role="button"`, Enter/Space).
- **`LandingFullView.tsx`** (US2) — opens the existing `MaterialPreview` single-landing path
  (sandboxed navigable page + screenshot fallback) plus `LandingViewerControls`.
- **`LandingViewerControls.tsx`** (US2) — device / colour-scheme / zoom presets, persisted to
  `soty.landing-viewer.v1`; reuses the local previewer preset shape.

## Shell wiring (`apps/web/src/team/workspace/WorkspaceShell.tsx`)

Add a `landings` view mode alongside `content | search | settings` (FR-015): a labelled entry
that opens `LandingGallery`; progressive disclosure, not an always-on panel. Reachable in ≤2
actions from the workspace (SC-001).

## Local previewer surface (US3, P3) — `apps/web/src/landing-preview/LandingPreviewPage.tsx`

Add "open a connected team space" as a catalog source alongside the local-folder picker,
calling the agent’s team-space catalog source (agent contract). Same grid/zoom UX; identical
previews (FR-016).

## Error → i18n mapping (branch on code, not text)

| Code | Key |
| --- | --- |
| `PAIRING_REQUIRED` / `CONNECTION_FAILED` | `teamPreviewAgentRequired` (reused) |
| `AGENT_UPDATE_REQUIRED` | `teamPreviewAgentUpdateRequired` (reused) |
| `RENDER_FAILED` + reason `corrupt/protected/too_large/unsupported` | `teamLandingUnavailable*` (new) |
| `SOURCE_CHANGED` / `STALE_RENDER` | `teamLandingNeedsRerender` (new) |
| `OAUTH_APPROVAL_REQUIRED` | reused drive-gate copy |
| `PERMISSION_DENIED` | reused |
