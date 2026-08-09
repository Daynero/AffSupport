# Contract: `@video-compressor/shared/team` additions

Additive only. Existing team contract types are unchanged. All new types are string-literal
unions / discriminated results (Constitution I). Re-exported through
`packages/shared/src/team/index.ts` and the package root `types.ts`.

## Render states

```ts
export type LandingRenderState = 'rendering' | 'ready' | 'stale' | 'failed';

export type LandingRenderFailureReason =
  | 'corrupt' | 'protected' | 'too_large' | 'unsupported' | 'render_error';

// Per-tile view state (derived; see data-model §3)
export type LandingTileState =
  | 'ready' | 'candidate' | 'rendering' | 'needs_agent' | 'agent_outdated' | 'error';
```

## Viewer presets (shared with the local previewer model)

```ts
export type LandingDevicePreset = 'desktop' | 'tablet' | 'mobile'; // maps to renderer viewport
export type LandingColorScheme = 'light' | 'dark';

export interface LandingViewerPreset {
  device: LandingDevicePreset;
  colorScheme: LandingColorScheme;
  zoom: number; // clamped via a shared clampZoom(min,max); no inline magic bounds
}
```

## Render pointer & artifact reference

```ts
export interface RenderArtifactRef {
  materialId: string;
  sourceVersion: string;
  fingerprint: string;
  preset: string;         // 'default' for v1
  segmentCount: number;   // >= 1
  // opaque handle the browser passes to drive-transfer to fetch bytes; no raw Drive id/path
  artifactToken: string;
}

export interface LandingRenderPointer {
  materialId: string;
  state: LandingRenderState;
  failureReason?: LandingRenderFailureReason;
  sourceVersion: string;
  fingerprint: string;
  preset: string;
  artifact?: RenderArtifactRef; // present iff state === 'ready' and source identity matches
}
```

## Gallery transport (request/response)

```ts
// Request is the existing catalog search shape with a fixed category facet.
export interface LandingGalleryQuery {
  text?: string;
  facets?: CatalogFacetSelection; // reused
  page?: CatalogPageCursor;       // reused
}

export interface LandingGalleryItem {
  materialId: string;
  name: string;
  isCandidate: boolean;
  facets: MaterialFacetSummary;   // geo/offer/language/tags (reused)
  tile: LandingTileState;
  render?: LandingRenderPointer;
  unavailableReason?: LandingRenderFailureReason;
  canDownload: boolean;
  canEdit: boolean;
}

export interface LandingGalleryPage {
  items: LandingGalleryItem[];
  next?: CatalogPageCursor;
  total: number;
  freshness: CatalogFreshnessState; // reused: not_started|scanning|replaying|ready|failed|unavailable
}
```

## Agent render request/result (team-bridge payloads)

```ts
export interface TeamLandingRenderRequest {
  teamId: string;
  materialId: string;
  preset: LandingViewerPreset;
  // grant + operation come from drive-transfer, same as single preview
}

export type TeamLandingRenderResult =
  | { ok: true; pointer: LandingRenderPointer }
  | { ok: false; reason: LandingRenderFailureReason };
```

## Release / tool contract

- New agent routes register under the existing `teamWorkspace` tool contract in
  `packages/shared/src/release.ts`. Bump **only** that tool's contract version.
- `PRODUCT_VERSION` / `AGENT_API_VERSION` unchanged unless independently warranted.
- Old agents fail the new routes with `AGENT_UPDATE_REQUIRED`; existing tools keep working.

## Analytics event names (content-free) — added to `TeamAnalyticsEventName`

```ts
| 'team_landing_gallery_view'    // { teamAttemptId, itemCount, readyCount, durationMs }
| 'team_landing_open'            // { teamAttemptId, tileState, hadAgent, durationMs }
| 'team_landing_render'          // { teamAttemptId, outcome: 'ready'|'failed', reason?, durationMs }
```

No event carries material name, Drive id, path, query text, or landing content (FR-018).
