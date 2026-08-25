import type {
  LandingPreviewItem,
  LandingPreviewRenderSettings,
  LandingPreviewState
} from '@video-compressor/shared';
import type { DroppedFolderSample } from '../components/DropZone';

export type {
  LandingPreviewCatalogSummary,
  LandingPreviewDevice,
  LandingPreviewColorScheme,
  LandingPreviewEvent,
  LandingPreviewItem,
  LandingPreviewPhase,
  LandingPreviewRenderSettings,
  LandingPreviewSourceKind,
  LandingPreviewState,
  TeamLandingPreviewCatalogRequest
} from '@video-compressor/shared';

/** How the preview canvas fits the rendered landing image. */
export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

/**
 * Which capability-gated actions a {@link LandingViewerSource} supports, so the presentational
 * layer can hide controls a source cannot service. The agent source enables everything; a future
 * team/Supabase source turns off the OS-only ones (folder picker, drop, Finder reveal, cache).
 */
export interface LandingViewerSourceCapabilities {
  chooseFolder: boolean;
  openPaths: boolean;
  refresh: boolean;
  cancel: boolean;
  reveal: boolean;
  openExtracted: boolean;
  clearCache: boolean;
  removeCatalog: boolean;
  settings: boolean;
}

/**
 * The transport seam that makes the landing viewer reusable. Every action and every pushed frame
 * yields a complete {@link LandingPreviewState}; the engine never mutates state locally, it swaps
 * in whatever the source returns. Only three things are transport-specific — obtaining/mutating
 * state, subscribing to updates, and resolving an item's image URL — and this interface abstracts
 * exactly those. Capability-gated methods are present iff the matching {@link
 * LandingViewerSourceCapabilities} flag is `true`.
 */
export interface LandingViewerSource {
  readonly capabilities: LandingViewerSourceCapabilities;

  /** Initial full snapshot. */
  fetchState(signal?: AbortSignal): Promise<LandingPreviewState>;

  /** Live updates; returns an unsubscribe fn. `onStatus` drives the "connection lost" banner. */
  subscribe(handlers: {
    onState: (state: LandingPreviewState) => void;
    onStatus?: (status: 'open' | 'lost') => void;
  }): () => void;

  /** Resolve the image URL for a landing + segment (agent token URL vs. signed URL). */
  /**
   * The image for one tile.
   *
   * May be a promise, because the agent-backed source mints a capability ticket
   * for it: the session token must not travel in an `<img src>`, which is
   * copied into referrers, logs and proxy caches. A source that already knows
   * the URL — a bundled fixture, a hosted gallery — returns the string, and
   * callers resolve either shape.
   */
  imageUrl(item: LandingPreviewItem, segment: number): string | Promise<string | null> | null;

  /** Switch active catalogue — the one action every source supports. */
  activate(catalogId: string): Promise<LandingPreviewState>;

  // ---- capability-gated (present iff the matching capability flag is true) ----
  chooseFolder?(): Promise<LandingPreviewState>;
  openPaths?(paths: string[]): Promise<LandingPreviewState>;
  /**
   * Recover a dropped folder's local path from a sample file inside it (browsers hide the path), so
   * drag-and-drop can open the same folder the picker would via {@link openPaths}. Resolves to
   * `null` when the folder can't be located, letting the UI fall back to the picker. Present iff
   * {@link LandingViewerSourceCapabilities.openPaths} is `true`.
   */
  resolveDroppedFolder?(sample: DroppedFolderSample): Promise<string | null>;
  refresh?(mode: 'changed' | 'all' | 'current', landingId?: string): Promise<LandingPreviewState>;
  cancel?(): Promise<LandingPreviewState>;
  reveal?(landingId: string): Promise<LandingPreviewState>;
  openExtracted?(landingId: string): Promise<LandingPreviewState>;
  clearCache?(): Promise<LandingPreviewState>;
  removeCatalog?(catalogId: string): Promise<LandingPreviewState>;
  updateSettings?(partial: Partial<LandingPreviewRenderSettings>): Promise<LandingPreviewState>;
}

/** The viewer's resting state before any source data arrives. Shared so defaults can't drift. */
export const emptyState: LandingPreviewState = {
  catalogs: [],
  activeCatalogId: null,
  activeCatalogName: null,
  landings: [],
  running: false,
  progress: { phase: 'idle', completed: 0, total: 0, currentLandingId: null },
  renderer: { available: true, error: null },
  settings: { device: 'desktop', colorScheme: 'light' },
  warnings: [],
  error: null,
  updatedAt: null
};
