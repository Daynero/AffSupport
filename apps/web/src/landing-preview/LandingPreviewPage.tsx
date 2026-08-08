import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode
} from 'react';
import type {
  LandingPreviewDevice,
  LandingPreviewEvent,
  LandingPreviewItem,
  LandingPreviewPhase,
  LandingPreviewRenderSettings,
  LandingPreviewState
} from '@video-compressor/shared';
import {
  landingGalleryActivate,
  landingGalleryCancel,
  landingGalleryClearCache,
  landingGalleryEventUrl,
  landingGalleryImageUrl,
  landingGalleryOpen,
  landingGalleryOpenExtracted,
  landingGalleryRefresh,
  landingGalleryRemoveCatalog,
  landingGalleryReveal,
  landingGallerySelect,
  landingGallerySettings,
  request
} from '../api/client';
import { analytics } from '../analytics/service';
import { droppedFilePaths } from '../components/DropZone';
import { Button, IconButton, ProgressBar, Spinner } from '../components/ui';
import { useI18n, type TranslationKey } from '../i18n';
import { navigateTo } from '../lib/navigation';

const emptyState: LandingPreviewState = {
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

type ZoomMode = 'fit-width' | 'fit-page' | 'custom';
const VIEWER_PREFERENCES_KEY = 'wishly:landing-preview:viewer-preferences';
/** Skip the auto re-scan when the catalogue was refreshed within this window. */
const AUTO_RESCAN_STALE_MS = 60_000;

export default function LandingPreviewPage() {
  const { t } = useI18n();
  const [state, setState] = useState<LandingPreviewState>(emptyState);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => readViewerPreferences().sidebarOpen);
  const [search, setSearch] = useState('');
  const [zoomMode, setZoomMode] = useState<ZoomMode>(() => readViewerPreferences().zoomMode);
  const [customScale, setCustomScale] = useState(() => readViewerPreferences().customScale);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [gridMode, setGridMode] = useState(false);
  const viewer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    document.title = `${t('landingGallery')} — Soty`;
  }, [t]);

  useEffect(() => {
    analytics.track('tool_opened', { tool_identifier: 'landing-preview' });
    request<LandingPreviewState>('/api/landing-preview/state', 'GET')
      .then(next => {
        setState(next);
        setLoaded(true);
        const fresh = next.updatedAt !== null && Date.now() - next.updatedAt < AUTO_RESCAN_STALE_MS;
        if (next.activeCatalogId && !next.running && !fresh) {
          void landingGalleryActivate(next.activeCatalogId)
            .then(setState)
            .catch(() => {});
        }
      })
      .catch(() => {
        setMessage(t('landingGalleryActionFailed'));
        setLoaded(true);
      });
    const source = new EventSource(landingGalleryEventUrl());
    source.onmessage = event => {
      setConnectionLost(false);
      try {
        const update = JSON.parse(event.data) as LandingPreviewEvent;
        setState(update.state);
        setLoaded(true);
      } catch {
        // Ignore a malformed frame; the next snapshot restores the state.
      }
    };
    source.onopen = () => setConnectionLost(false);
    source.onerror = () => setConnectionLost(true);
    return () => source.close();
  }, []);

  useEffect(() => {
    writeViewerPreferences({ sidebarOpen, zoomMode, customScale });
  }, [customScale, sidebarOpen, zoomMode]);

  useEffect(() => {
    if (selectedId && state.landings.some(item => item.id === selectedId)) return;
    const preferred =
      state.landings.find(item => item.previewAvailable) ?? state.landings[0] ?? null;
    setSelectedId(preferred?.id ?? null);
  }, [selectedId, state.landings]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () =>
      setCanvasSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.activeCatalogId, loaded]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === viewer.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const selectedIndex = state.landings.findIndex(item => item.id === selectedId);
  const selected = selectedIndex >= 0 ? state.landings[selectedIndex] : null;
  const selectAt = useCallback(
    (index: number) => {
      if (!state.landings.length) return;
      const normalized = (index + state.landings.length) % state.landings.length;
      setSelectedId(state.landings[normalized].id);
      requestAnimationFrame(() => canvas.current?.scrollTo?.({ top: 0, left: 0 }));
    },
    [state.landings]
  );

  const scale = useMemo(() => {
    if (!selected?.previewWidth || !selected.previewHeight) return customScale;
    const availableWidth = Math.max(160, canvasSize.width - 80);
    const availableHeight = Math.max(160, canvasSize.height - 80);
    if (zoomMode === 'fit-width') return clamp(availableWidth / selected.previewWidth, 0.15, 3);
    if (zoomMode === 'fit-page')
      return clamp(
        Math.min(availableWidth / selected.previewWidth, availableHeight / selected.previewHeight),
        0.15,
        3
      );
    return customScale;
  }, [canvasSize, customScale, selected, zoomMode]);

  const setZoom = useCallback((next: number) => {
    setCustomScale(clamp(next, 0.25, 3));
    setZoomMode('custom');
  }, []);

  // Ctrl/⌘ + wheel zooms the preview. A native non-passive listener is required
  // because React's synthetic wheel handler cannot preventDefault the browser zoom.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom(scaleRef.current + (event.deltaY < 0 ? 0.1 : -0.1));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onCanvasPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, select'))
      return;
    const element = canvas.current;
    if (!element) return;
    pan.current = {
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop
    };
    element.classList.add('is-panning');
  };
  const onCanvasPointerMove = (event: PointerEvent<HTMLElement>) => {
    const element = canvas.current;
    const origin = pan.current;
    if (!element || !origin) return;
    element.scrollLeft = origin.left - (event.clientX - origin.x);
    element.scrollTop = origin.top - (event.clientY - origin.y);
  };
  const endPan = () => {
    pan.current = null;
    canvas.current?.classList.remove('is-panning');
  };

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, select, textarea, button, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectAt(selectedIndex - 1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectAt(selectedIndex + 1);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom(scale + 0.1);
      } else if (event.key === '-') {
        event.preventDefault();
        setZoom(scale - 0.1);
      } else if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [scale, selectAt, selectedIndex, setZoom]);

  const apply = async (operation: () => Promise<LandingPreviewState>) => {
    setMessage(null);
    try {
      setState(await operation());
    } catch {
      setMessage(t('landingGalleryActionFailed'));
    }
  };

  const chooseFolder = () => void apply(landingGallerySelect);
  const removeCatalog = (catalogId: string) => {
    if (window.confirm(t('landingGalleryRemoveCatalogConfirm'))) {
      void apply(() => landingGalleryRemoveCatalog(catalogId));
    }
  };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const paths = droppedFilePaths(event.dataTransfer);
    if (!paths.length) {
      setMessage(t('landingGalleryDropNeedsPicker'));
      return;
    }
    void apply(() => landingGalleryOpen([paths[0]]));
  };

  if (!loaded) {
    return (
      <main className="landing-gallery-loading" aria-label={t('loading')}>
        <Spinner />
      </main>
    );
  }

  if (!state.activeCatalogId) {
    return (
      <LandingGalleryWelcome
        state={state}
        dragging={dragging}
        message={message}
        chooseFolder={chooseFolder}
        activate={id => void apply(() => landingGalleryActivate(id))}
        remove={removeCatalog}
        onDragEnter={event => {
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragLeave={event => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={handleDrop}
      />
    );
  }

  const phaseLabel = t(phaseKey(state.progress.phase));
  const progress = state.progress.total
    ? Math.round((state.progress.completed / state.progress.total) * 100)
    : state.running
      ? null
      : 100;
  const previewNotes = selected
    ? (selected.warning ?? '')
        .split(',')
        .filter(Boolean)
        .map(code =>
          code === 'PAGE_SCRIPT_ERROR'
            ? t('landingGalleryPageErrorWarning')
            : code === 'PREVIEW_CROPPED'
              ? t('landingGalleryCroppedWarning')
              : code === 'PREVIEW_DOWNSCALED'
                ? t('landingGalleryDownscaledWarning')
                : code
        )
    : [];

  return (
    <div
      ref={viewer}
      className={`landing-gallery-viewer ${sidebarOpen ? '' : 'sidebar-collapsed'} ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={event => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <header className="landing-gallery-toolbar">
        <div className="landing-gallery-toolbar-group is-leading">
          <IconButton label={t('landingGalleryBack')} onClick={() => navigateTo('/')}>
            ←
          </IconButton>
          <IconButton
            label={t('landingGalleryToggleSidebar')}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(value => !value)}
          >
            ☰
          </IconButton>
          <div className="landing-gallery-identity">
            <strong>{selected?.name ?? state.activeCatalogName}</strong>
            <span title={selected?.relativePath}>{selected?.relativePath ?? phaseLabel}</span>
          </div>
        </div>

        <div className="landing-gallery-toolbar-group is-navigation">
          <IconButton
            label={t('landingGalleryPrevious')}
            disabled={!state.landings.length}
            onClick={() => selectAt(selectedIndex - 1)}
          >
            ‹
          </IconButton>
          <span className="landing-gallery-counter numeric">
            {t('landingGalleryCounter', {
              current: selectedIndex >= 0 ? selectedIndex + 1 : 0,
              total: state.landings.length
            })}
          </span>
          <IconButton
            label={t('landingGalleryNext')}
            disabled={!state.landings.length}
            onClick={() => selectAt(selectedIndex + 1)}
          >
            ›
          </IconButton>
        </div>

        <div className="landing-gallery-toolbar-group is-actions">
          <div className="landing-gallery-zoom">
            <IconButton label={t('landingGalleryZoomOut')} onClick={() => setZoom(scale - 0.1)}>
              −
            </IconButton>
            <button type="button" onClick={() => setZoom(1)} title={t('landingGalleryActualSize')}>
              {Math.round(scale * 100)}%
            </button>
            <IconButton label={t('landingGalleryZoomIn')} onClick={() => setZoom(scale + 0.1)}>
              +
            </IconButton>
          </div>
          <Button
            variant="ghost"
            className="landing-gallery-label-action"
            aria-pressed={zoomMode === 'fit-width'}
            onClick={() => setZoomMode('fit-width')}
          >
            {t('landingGalleryFitWidth')}
          </Button>
          <Button
            variant="ghost"
            className="landing-gallery-label-action"
            aria-pressed={zoomMode === 'fit-page'}
            onClick={() => setZoomMode('fit-page')}
          >
            {t('landingGalleryFitPage')}
          </Button>
          <IconButton
            label={t('landingGalleryRefreshCurrent')}
            disabled={!selected || state.running}
            onClick={() =>
              selected && void apply(() => landingGalleryRefresh('current', selected.id))
            }
          >
            ↻
          </IconButton>
          <IconButton
            label={t('landingGalleryReveal')}
            disabled={!selected}
            onClick={() => selected && void apply(() => landingGalleryReveal(selected.id))}
          >
            ⌂
          </IconButton>
          {selected?.sourceKind === 'zip' && (
            <IconButton
              label={t('landingGalleryOpenExtracted')}
              disabled={!selected.extractedAvailable}
              onClick={() => void apply(() => landingGalleryOpenExtracted(selected.id))}
            >
              ▣
            </IconButton>
          )}
          <IconButton
            label={t('landingGalleryGrid')}
            aria-pressed={gridMode}
            disabled={!state.landings.length}
            onClick={() => setGridMode(value => !value)}
          >
            ▦
          </IconButton>
          <IconButton
            label={t('landingGalleryFullscreen')}
            aria-pressed={fullscreen}
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void viewer.current?.requestFullscreen();
            }}
          >
            {fullscreen ? '×' : '⛶'}
          </IconButton>
          <GallerySettingsMenu
            settings={state.settings ?? emptyState.settings}
            disabled={state.running}
            onChange={partial => void apply(() => landingGallerySettings(partial))}
          />
          <GalleryMoreMenu
            state={state}
            apply={apply}
            chooseFolder={chooseFolder}
            removeCatalog={removeCatalog}
          />
        </div>
      </header>

      <aside className="landing-gallery-sidebar" inert={!sidebarOpen}>
        <div className="landing-gallery-source-select">
          <label htmlFor="landing-gallery-catalog">{t('landingGalleryRecent')}</label>
          <select
            id="landing-gallery-catalog"
            value={state.activeCatalogId ?? ''}
            disabled={state.running}
            onChange={event => void apply(() => landingGalleryActivate(event.target.value))}
          >
            {state.catalogs.map(catalog => (
              <option value={catalog.id} key={catalog.id}>
                {catalog.name} · {catalog.landingCount}
              </option>
            ))}
          </select>
        </div>
        <div className="landing-gallery-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('landingGallerySearch')}
            aria-label={t('landingGallerySearch')}
          />
        </div>
        <div className="landing-gallery-tree-scroll">
          <LandingTree
            landings={state.landings}
            selectedId={selectedId}
            search={search}
            onSelect={id => {
              setSelectedId(id);
              requestAnimationFrame(() => canvas.current?.scrollTo?.({ top: 0, left: 0 }));
            }}
          />
        </div>
        {state.warnings.length > 0 && (
          <details className="landing-gallery-warnings">
            <summary>{t('landingGalleryWarnings')}</summary>
            {state.warnings.map((warning, index) => (
              <p key={`${warning}-${index}`}>{warning}</p>
            ))}
          </details>
        )}
      </aside>

      <main
        ref={canvas}
        className={`landing-gallery-canvas ${gridMode ? 'is-grid' : ''}`}
        onPointerDown={gridMode ? undefined : onCanvasPointerDown}
        onPointerMove={gridMode ? undefined : onCanvasPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {gridMode ? (
          <GalleryGrid
            landings={state.landings}
            selectedId={selectedId}
            onSelect={id => {
              setSelectedId(id);
              setGridMode(false);
            }}
          />
        ) : !state.renderer.available ? (
          <GalleryEmpty
            title={t('landingGalleryRendererMissing')}
            body={t('landingGalleryRendererMissingBody')}
          />
        ) : selected?.previewAvailable ? (
          <div
            className="landing-gallery-image-stage"
            style={{
              width: selected.previewWidth ? selected.previewWidth * scale : undefined,
              minHeight: selected.previewHeight ? selected.previewHeight * scale : undefined
            }}
          >
            <div className="landing-gallery-image-stack">
              {Array.from({ length: Math.max(1, selected.previewSegments ?? 1) }, (_, index) => (
                <img
                  key={`${selected.id}-${selected.renderedAt}-${index}`}
                  src={landingGalleryImageUrl(selected.id, selected.renderedAt, index)}
                  alt={index === 0 ? selected.name : ''}
                  aria-hidden={index > 0 ? true : undefined}
                  draggable={false}
                  style={{
                    width: selected.previewWidth ? selected.previewWidth * scale : undefined
                  }}
                />
              ))}
            </div>
            {selected.stale && (
              <div className="landing-gallery-stale-note">{t('landingGalleryOldPreview')}</div>
            )}
            {previewNotes.length > 0 && (
              <div className="landing-gallery-render-note" role="status">
                {previewNotes.map(note => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            )}
          </div>
        ) : selected ? (
          <GalleryEmpty
            title={
              selected.status === 'failed'
                ? t('landingGalleryStatusFailed')
                : t('landingGalleryNoPreview')
            }
            body={selected.error ?? phaseLabel}
            busy={selected.status === 'rendering' || selected.status === 'queued'}
          />
        ) : state.running ? (
          <GalleryEmpty title={phaseLabel} busy />
        ) : (
          <GalleryEmpty
            title={t('landingGalleryEmptyTitle')}
            body={t('landingGalleryEmptyBody')}
            action={<Button onClick={chooseFolder}>{t('landingGalleryChooseAnother')}</Button>}
          />
        )}
        {!gridMode && selectedIndex > 0 && (
          <button
            className="landing-gallery-edge-nav is-left"
            type="button"
            aria-label={t('landingGalleryPrevious')}
            onClick={() => selectAt(selectedIndex - 1)}
          >
            ‹
          </button>
        )}
        {!gridMode && selectedIndex >= 0 && selectedIndex < state.landings.length - 1 && (
          <button
            className="landing-gallery-edge-nav is-right"
            type="button"
            aria-label={t('landingGalleryNext')}
            onClick={() => selectAt(selectedIndex + 1)}
          >
            ›
          </button>
        )}
      </main>

      {(state.running || state.error || message || connectionLost) && (
        <footer
          className={`landing-gallery-progress ${state.error || message || connectionLost ? 'is-error' : ''}`}
        >
          <div>
            <strong>
              {state.error ||
                message ||
                (connectionLost ? t('landingGalleryConnectionLost') : phaseLabel)}
            </strong>
            {state.running && state.progress.total > 0 && (
              <span>
                {t('landingGalleryProgress', {
                  done: state.progress.completed,
                  total: state.progress.total
                })}
              </span>
            )}
          </div>
          {state.running && (
            <>
              <ProgressBar value={progress} label={phaseLabel} active />
              <Button variant="ghost" onClick={() => void apply(landingGalleryCancel)}>
                {t('landingGalleryCancel')}
              </Button>
            </>
          )}
        </footer>
      )}
      {dragging && (
        <div className="landing-gallery-drop-overlay">
          <strong>{t('landingGalleryDropActive')}</strong>
          <span>{t('landingGalleryDropHint')}</span>
        </div>
      )}
    </div>
  );
}

function LandingGalleryWelcome({
  state,
  dragging,
  message,
  chooseFolder,
  activate,
  remove,
  onDragEnter,
  onDragLeave,
  onDrop
}: {
  state: LandingPreviewState;
  dragging: boolean;
  message: string | null;
  chooseFolder: () => void;
  activate: (id: string) => void;
  remove: (id: string) => void;
  onDragEnter: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <main className="landing-gallery-welcome">
      <button
        className="landing-gallery-welcome-back"
        type="button"
        onClick={() => navigateTo('/')}
      >
        ← {t('landingGalleryBack')}
      </button>
      <section
        className={`landing-gallery-drop-zone ${dragging ? 'is-dragging' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={event => event.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="landing-gallery-welcome-icon" aria-hidden="true">
          ▱
        </span>
        <h1>{t('landingGalleryDropTitle')}</h1>
        <p>{t('landingGalleryDropHint')}</p>
        <Button variant="primary" onClick={chooseFolder}>
          {t('landingGalleryOpenFolder')}
        </Button>
        <small>{t('landingGalleryLocalNote')}</small>
      </section>
      {message && (
        <p className="landing-gallery-welcome-error" role="alert">
          {message}
        </p>
      )}
      {state.catalogs.length > 0 && (
        <section className="landing-gallery-recent-list">
          <h2>{t('landingGalleryRecent')}</h2>
          {state.catalogs.map(catalog => (
            <div
              key={catalog.id}
              className={`landing-gallery-recent-row ${catalog.sourceAvailable ? '' : 'is-unavailable'}`}
            >
              <button type="button" onClick={() => activate(catalog.id)}>
                <span>
                  <strong>{catalog.name}</strong>
                  <small>
                    {catalog.sourceAvailable
                      ? t('landingGalleryCount', { count: catalog.landingCount })
                      : t('landingGalleryUnavailable')}
                  </small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
              <IconButton
                label={t('landingGalleryRemoveCatalog')}
                onClick={() => remove(catalog.id)}
              >
                🗑
              </IconButton>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function GalleryMoreMenu({
  state,
  apply,
  chooseFolder,
  removeCatalog
}: {
  state: LandingPreviewState;
  apply: (operation: () => Promise<LandingPreviewState>) => Promise<void>;
  chooseFolder: () => void;
  removeCatalog: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <details className="landing-gallery-more">
      <summary aria-label={t('landingGalleryMoreActions')}>•••</summary>
      <div>
        <button type="button" onClick={chooseFolder}>
          {t('landingGalleryChooseAnother')}
        </button>
        <button
          type="button"
          disabled={state.running}
          onClick={() => void apply(() => landingGalleryRefresh('changed'))}
        >
          {t('landingGalleryRefreshChanged')}
        </button>
        <button
          type="button"
          disabled={state.running}
          onClick={() => void apply(() => landingGalleryRefresh('all'))}
        >
          {t('landingGalleryRebuildAll')}
        </button>
        <button
          type="button"
          disabled={state.running}
          onClick={() => {
            if (window.confirm(t('landingGalleryClearConfirm'))) {
              void apply(landingGalleryClearCache);
            }
          }}
        >
          {t('landingGalleryClearCache')}
        </button>
        <button
          type="button"
          className="is-danger"
          disabled={state.running || !state.activeCatalogId}
          onClick={() => state.activeCatalogId && removeCatalog(state.activeCatalogId)}
        >
          {t('landingGalleryRemoveActiveCatalog')}
        </button>
      </div>
    </details>
  );
}

const DEVICE_OPTIONS: Array<{ value: LandingPreviewDevice; key: TranslationKey }> = [
  { value: 'desktop', key: 'landingGalleryDeviceDesktop' },
  { value: 'tablet', key: 'landingGalleryDeviceTablet' },
  { value: 'mobile', key: 'landingGalleryDeviceMobile' }
];

function GallerySettingsMenu({
  settings,
  disabled,
  onChange
}: {
  settings: LandingPreviewRenderSettings;
  disabled: boolean;
  onChange: (partial: Partial<LandingPreviewRenderSettings>) => void;
}) {
  const { t } = useI18n();
  return (
    <details className="landing-gallery-settings">
      <summary aria-label={t('landingGalleryDeviceLabel')}>⚙</summary>
      <div>
        <fieldset disabled={disabled}>
          <legend>{t('landingGalleryDeviceLabel')}</legend>
          <div className="landing-gallery-segment">
            {DEVICE_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={settings.device === option.value}
                onClick={() => onChange({ device: option.value })}
              >
                {t(option.key)}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>{t('landingGalleryColorSchemeLabel')}</legend>
          <div className="landing-gallery-segment">
            <button
              type="button"
              aria-pressed={settings.colorScheme === 'light'}
              onClick={() => onChange({ colorScheme: 'light' })}
            >
              {t('landingGalleryColorSchemeLight')}
            </button>
            <button
              type="button"
              aria-pressed={settings.colorScheme === 'dark'}
              onClick={() => onChange({ colorScheme: 'dark' })}
            >
              {t('landingGalleryColorSchemeDark')}
            </button>
          </div>
        </fieldset>
      </div>
    </details>
  );
}

function GalleryGrid({
  landings,
  selectedId,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="landing-gallery-grid">
      {landings.map(item => (
        <button
          key={item.id}
          type="button"
          className={`landing-gallery-grid-tile ${item.id === selectedId ? 'is-selected' : ''} ${item.stale ? 'is-stale' : ''}`}
          onClick={() => onSelect(item.id)}
          title={item.relativePath}
        >
          <span className="landing-gallery-grid-thumb">
            {item.previewAvailable ? (
              <img
                src={landingGalleryImageUrl(item.id, item.renderedAt, 0)}
                alt=""
                loading="lazy"
                draggable={false}
              />
            ) : item.status === 'failed' ? (
              <em>{t('landingGalleryStatusFailed')}</em>
            ) : (
              <Spinner />
            )}
          </span>
          <span className="landing-gallery-grid-name">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

interface TreeNode {
  key: string;
  name: string;
  children: TreeNode[];
  landing: LandingPreviewItem | null;
}

function LandingTree({
  landings,
  selectedId,
  search,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  search: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const normalized = search.trim().toLocaleLowerCase();
  const visible = normalized
    ? landings.filter(item =>
        `${item.name} ${item.relativePath}`.toLocaleLowerCase().includes(normalized)
      )
    : landings;
  const tree = useMemo(() => buildTree(visible), [visible]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (!visible.length)
    return <p className="landing-gallery-tree-empty">{t('landingGallerySearchEmpty')}</p>;
  return (
    <div className="landing-gallery-tree" role="tree">
      {tree.children.map(node => (
        <TreeBranch
          key={node.key}
          node={node}
          depth={0}
          collapsed={collapsed}
          toggle={key =>
            setCollapsed(current => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeBranch({
  node,
  depth,
  collapsed,
  toggle,
  selectedId,
  onSelect
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  if (node.landing) {
    const item = node.landing;
    const status = item.stale
      ? t('landingGalleryStatusStale')
      : item.status === 'rendering'
        ? t('landingGalleryStatusRendering')
        : item.status === 'failed'
          ? t('landingGalleryStatusFailed')
          : item.status === 'queued'
            ? t('landingGalleryStatusQueued')
            : '';
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={selectedId === item.id}
        className={`landing-gallery-tree-landing is-${item.status} ${item.stale ? 'is-stale' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onSelect(item.id)}
        title={item.relativePath}
      >
        <span className="landing-gallery-tree-icon" aria-hidden="true">
          {item.sourceKind === 'zip' ? 'Z' : '⌑'}
        </span>
        <span className="landing-gallery-tree-copy">
          <strong>{node.name}</strong>
          {status && <small>{status}</small>}
        </span>
        {item.previewAvailable && <i aria-hidden="true" />}
      </button>
    );
  }
  const closed = collapsed.has(node.key);
  return (
    <div role="group">
      <button
        type="button"
        role="treeitem"
        aria-expanded={!closed}
        className="landing-gallery-tree-folder"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => toggle(node.key)}
      >
        <span aria-hidden="true">{closed ? '›' : '⌄'}</span>
        <strong>{node.name}</strong>
      </button>
      {!closed &&
        node.children.map(child => (
          <TreeBranch
            key={child.key}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            toggle={toggle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function buildTree(landings: LandingPreviewItem[]): TreeNode {
  const root: TreeNode = { key: 'root', name: '', children: [], landing: null };
  for (const landing of landings) {
    const segments = landing.relativePath.split('/').filter(Boolean);
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      const last = index === segments.length - 1;
      const key = `${parent.key}/${name}`;
      let child = parent.children.find(item => item.key === key);
      if (!child) {
        child = { key, name, children: [], landing: null };
        parent.children.push(child);
      }
      if (last) child.landing = landing;
      parent = child;
    }
  }
  const sort = (node: TreeNode) => {
    node.children.sort((left, right) => {
      if (Boolean(left.landing) !== Boolean(right.landing)) return left.landing ? 1 : -1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

function GalleryEmpty({
  title,
  body,
  busy = false,
  action
}: {
  title: string;
  body?: string | null;
  busy?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="landing-gallery-empty">
      {busy ? <Spinner /> : <span aria-hidden="true">▱</span>}
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

function phaseKey(phase: LandingPreviewPhase): TranslationKey {
  const keys: Record<LandingPreviewPhase, TranslationKey> = {
    idle: 'landingGalleryPhaseIdle',
    scanning: 'landingGalleryPhaseScanning',
    downloading: 'landingGalleryPhaseDownloading',
    inspecting: 'landingGalleryPhaseInspecting',
    extracting: 'landingGalleryPhaseExtracting',
    rendering: 'landingGalleryPhaseRendering',
    completed: 'landingGalleryPhaseCompleted',
    cancelled: 'landingGalleryPhaseCancelled',
    failed: 'landingGalleryPhaseFailed'
  };
  return keys[phase];
}

function readViewerPreferences(): {
  sidebarOpen: boolean;
  zoomMode: ZoomMode;
  customScale: number;
} {
  const fallback = { sidebarOpen: true, zoomMode: 'fit-width' as ZoomMode, customScale: 1 };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const stored = JSON.parse(localStorage.getItem(VIEWER_PREFERENCES_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    return {
      sidebarOpen: typeof stored.sidebarOpen === 'boolean' ? stored.sidebarOpen : true,
      zoomMode: ['fit-width', 'fit-page', 'custom'].includes(String(stored.zoomMode))
        ? (stored.zoomMode as ZoomMode)
        : 'fit-width',
      customScale:
        typeof stored.customScale === 'number' && Number.isFinite(stored.customScale)
          ? clamp(stored.customScale, 0.25, 3)
          : 1
    };
  } catch {
    return fallback;
  }
}

function writeViewerPreferences(preferences: {
  sidebarOpen: boolean;
  zoomMode: ZoomMode;
  customScale: number;
}) {
  try {
    localStorage.setItem(VIEWER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The viewer still works when browser storage is disabled.
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
