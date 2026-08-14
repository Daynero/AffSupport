import { useCallback, useEffect, useState } from 'react';
import type { LandingPreviewRenderSettings, LandingPreviewState } from '@video-compressor/shared';
import { useI18n } from '../i18n';
import { emptyState, type LandingViewerSource } from './types';
import { readViewerPreferences } from './viewerPreferences';

/** Skip the auto re-scan when the catalogue was refreshed within this window. */
const AUTO_RESCAN_STALE_MS = 60_000;

export interface UseLandingViewerInput {
  source: LandingViewerSource;
}

/**
 * Headless container for the landing viewer: owns the `LandingPreviewState`, the live subscription,
 * the current selection/search/layout flags, and the capability-guarded actions. Every mutating
 * action returns a full state that simply replaces the current one — the hook never patches state
 * locally. It is transport-agnostic: give it any {@link LandingViewerSource}.
 */
export function useLandingViewer({ source }: UseLandingViewerInput) {
  const { t } = useI18n();
  const [state, setState] = useState<LandingPreviewState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(() => readViewerPreferences().sidebarOpen);
  const [gridMode, setGridMode] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    source
      .fetchState()
      .then(next => {
        setState(next);
        setLoaded(true);
        const fresh = next.updatedAt !== null && Date.now() - next.updatedAt < AUTO_RESCAN_STALE_MS;
        if (next.activeCatalogId && !next.running && !fresh) {
          void source
            .activate(next.activeCatalogId)
            .then(setState)
            .catch(() => {});
        }
      })
      .catch(() => {
        setMessage(t('landingGalleryActionFailed'));
        setLoaded(true);
      });
    return source.subscribe({
      onState: next => {
        setState(next);
        setLoaded(true);
      },
      onStatus: status => setConnectionLost(status === 'lost')
    });
    // `source` is stable (memoised by the caller); `t` is captured once, as in the original.
  }, [source]);

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
