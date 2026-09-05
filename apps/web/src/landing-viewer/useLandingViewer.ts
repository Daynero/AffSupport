import { useCallback, useEffect, useState } from 'react';
import type { LandingPreviewRenderSettings, LandingPreviewState } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { emptyState, type LandingViewerSource } from './types';
import { readViewerPreferences } from './viewerPreferences';

const NARROW_QUERY = '(max-width: 820px)';

/** Below this width the tree overlays the page instead of sitting beside it (see the CSS). */
export function narrowViewport() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}

/** Skip the auto re-scan when the catalogue was refreshed within this window. */
const AUTO_RESCAN_STALE_MS = 60_000;

export interface UseLandingViewerInput {
  source: LandingViewerSource;
  /**
   * Whether the source can be asked yet. The local page passes the agent connection: asking
   * before pairing finished produced a failed first fetch, a red banner that outlived the
   * retry, and a live stream opened without a token.
   */
  enabled?: boolean;
}

/**
 * Headless container for the landing viewer: owns the `LandingPreviewState`, the live subscription,
 * the current selection/search/layout flags, and the capability-guarded actions. Every mutating
 * action returns a full state that simply replaces the current one — the hook never patches state
 * locally. It is transport-agnostic: give it any {@link LandingViewerSource}.
 */
export function useLandingViewer({ source, enabled = true }: UseLandingViewerInput) {
  const { t } = useI18n();
  const [state, setState] = useState<LandingPreviewState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // On a phone the tree is an overlay over the page, so it starts closed there whatever the
  // preference says, and closes again once a landing is picked from it.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => readViewerPreferences().sidebarOpen && !narrowViewport()
  );
  const [gridMode, setGridMode] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [narrow, setNarrow] = useState(narrowViewport);

  // A window shrunk under the threshold turns the tree into a sheet over the page; it must
  // not stay open across that crossing, and the toolbar wants to know which side it is on.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setNarrow(query.matches);
      if (query.matches) setSidebarOpen(false);
    };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    source
      .fetchState()
      .then(next => {
        if (!active) return;
        setState(next);
        setLoaded(true);
        // A failure from an earlier source (the page opened before pairing) is over.
        setMessage(null);
        const fresh = next.updatedAt !== null && Date.now() - next.updatedAt < AUTO_RESCAN_STALE_MS;
        if (next.activeCatalogId && !next.running && !fresh) {
          void source
            .activate(next.activeCatalogId)
            .then(state => {
              if (active) setState(state);
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!active) return;
        setMessage(t('landingGalleryActionFailed'));
        setLoaded(true);
      });
    const unsubscribe = source.subscribe({
      onState: next => {
        setState(next);
        setLoaded(true);
      },
      onStatus: status => setConnectionLost(status === 'lost')
    });
    return () => {
      active = false;
      unsubscribe();
    };
    // `source` is stable (memoised by the caller); `t` is captured once, as in the original.
  }, [source, enabled]);

  useEffect(() => {
    if (selectedId && state.landings.some(item => item.id === selectedId)) return;
    const preferred =
      state.landings.find(item => item.previewAvailable) ?? state.landings[0] ?? null;
    setSelectedId(preferred?.id ?? null);
  }, [selectedId, state.landings]);

  const selectedIndex = state.landings.findIndex(item => item.id === selectedId);
  const selected = selectedIndex >= 0 ? state.landings[selectedIndex] : null;
  const activeCatalog = state.catalogs.find(item => item.id === state.activeCatalogId) ?? null;

  const selectAt = useCallback(
    (index: number) => {
      if (!state.landings.length) return;
      const normalized = (index + state.landings.length) % state.landings.length;
      setSelectedId(state.landings[normalized].id);
    },
    [state.landings]
  );

  const apply = useCallback(
    async (operation: () => Promise<LandingPreviewState>) => {
      setMessage(null);
      try {
        setState(await operation());
      } catch {
        setMessage(t('landingGalleryActionFailed'));
      }
    },
    [t]
  );

  /**
   * Replace the current state with one an external producer already obtained. Used by the local
   * page's team-import bridge, which fetches a snapshot itself (with its own error copy) and pushes
   * the resulting state through the same channel.
   */
  const pushState = useCallback((next: LandingPreviewState) => setState(next), []);

  const activate = useCallback(
    (id: string) => void apply(() => source.activate(id)),
    [apply, source]
  );
  const chooseFolder = useCallback(() => {
    if (source.chooseFolder) void apply(() => source.chooseFolder!());
  }, [apply, source]);
  const openPaths = useCallback(
    (paths: string[]) => {
      if (source.openPaths) void apply(() => source.openPaths!(paths));
    },
    [apply, source]
  );
  const refresh = useCallback(
    (mode: 'changed' | 'all' | 'current', landingId?: string) => {
      if (source.refresh) void apply(() => source.refresh!(mode, landingId));
    },
    [apply, source]
  );
  const cancel = useCallback(async () => {
    if (!source.cancel) return;
    setMessage(null);
    try {
      setState(await source.cancel());
    } catch {
      // The agent may have nothing to cancel (e.g. the scan already finished) and reject the call.
      // Reconcile with the real state instead of leaving a phantom progress bar running forever.
      try {
        setState(await source.fetchState());
      } catch {
        setMessage(t('landingGalleryActionFailed'));
      }
    }
  }, [source, t]);
  const reveal = useCallback(
    (id: string) => {
      if (source.reveal) void apply(() => source.reveal!(id));
    },
    [apply, source]
  );
  const openExtracted = useCallback(
    (id: string) => {
      if (source.openExtracted) void apply(() => source.openExtracted!(id));
    },
    [apply, source]
  );
  const clearCache = useCallback(() => {
    if (source.clearCache && window.confirm(t('landingGalleryClearConfirm'))) {
      void apply(() => source.clearCache!());
    }
  }, [apply, source, t]);
  const removeCatalog = useCallback(
    (id: string) => {
      if (source.removeCatalog && window.confirm(t('landingGalleryRemoveCatalogConfirm'))) {
        void apply(() => source.removeCatalog!(id));
      }
    },
    [apply, source, t]
  );
  const updateSettings = useCallback(
    (partial: Partial<LandingPreviewRenderSettings>) => {
      if (source.updateSettings) void apply(() => source.updateSettings!(partial));
    },
    [apply, source]
  );

  return {
    state,
    loaded,
    message,
    setMessage,
    connectionLost,
    selected,
    selectedIndex,
    activeCatalog,
    selectedId,
    setSelectedId,
    selectAt,
    search,
    setSearch,
    gridMode,
    setGridMode,
    sidebarOpen,
    setSidebarOpen,
    narrow,
    source,
    capabilities: source.capabilities,
    apply,
    pushState,
    activate,
    chooseFolder,
    openPaths,
    refresh,
    cancel,
    reveal,
    openExtracted,
    clearCache,
    removeCatalog,
    updateSettings
  };
}

export type UseLandingViewer = ReturnType<typeof useLandingViewer>;
