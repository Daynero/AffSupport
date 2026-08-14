import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react';
import { Button, ProgressBar, Spinner } from '../components/ui';
import { useI18n } from '../i18n';
import { navigateTo } from '../lib/navigation';
import { droppedFilePaths } from '../components/DropZone';
import { emptyState } from './types';
import { readViewerPreferences, writeViewerPreferences } from './viewerPreferences';
import { useLandingViewport } from './useLandingViewport';
import type { UseLandingViewer } from './useLandingViewer';
import { GalleryIconButton } from './internal/GalleryIconButton';
import { GalleryEmpty } from './internal/GalleryEmpty';
import { phaseKey } from './internal/phaseKey';
import { LandingTree } from './LandingTree';
import { LandingGalleryGrid } from './LandingGalleryGrid';
import { GallerySettingsMenu } from './GallerySettingsMenu';
import { GalleryMoreMenu } from './GalleryMoreMenu';
import { LandingSourceSwitcher } from './LandingSourceSwitcher';
import { LandingRefreshControl } from './LandingRefreshControl';
import { LandingViewerWelcome } from './LandingViewerWelcome';

/**
 * The reusable landing viewer UI, composed from the headless {@link UseLandingViewer} container and
 * the data-agnostic viewport engine. All transport lives behind the container's source, so the same
 * component can be embedded elsewhere by handing it a differently-sourced viewer. The local page
 * supplies team-space extras (welcome sources, team re-import refresh, shared-render creation)
 * through the optional props below.
 */
export function LandingViewer({
  viewer,
  teamSources,
  openingTeam = false,
  onRefreshActiveTeamSpace,
  onCreateTeamPreview,
  renderingTeamMaterialId = null
}: {
  viewer: UseLandingViewer;
  teamSources?: ReactNode;
  openingTeam?: boolean;
  onRefreshActiveTeamSpace?: (teamId: string) => void;
  onCreateTeamPreview?: () => void;
  renderingTeamMaterialId?: string | null;
}) {
  const { t } = useI18n();
  const {
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
    capabilities,
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
  } = viewer;

  const viewerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const preferences = useMemo(() => readViewerPreferences(), []);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const resetScrollRef = useRef<() => void>(() => {});
  const onStep = useCallback(
    (delta: -1 | 1) => {
      selectAt(selectedIndexRef.current + delta);
      resetScrollRef.current();
    },
    [selectAt]
  );

  const viewport = useLandingViewport({
    canvasRef,
    viewerRef,
    preview: selected ? { width: selected.previewWidth, height: selected.previewHeight } : null,
    onStep,
    panningDisabled: gridMode,
    initial: { zoomMode: preferences.zoomMode, customScale: preferences.customScale },
    remeasureKey: `${state.activeCatalogId ?? ''}:${loaded ? 1 : 0}`
  });
  resetScrollRef.current = viewport.resetScroll;
  const { scale, zoomMode } = viewport;

  useEffect(() => {
    writeViewerPreferences({ sidebarOpen, zoomMode, customScale: viewport.customScale });
  }, [sidebarOpen, viewport.customScale, zoomMode]);

  // Toolbar dropdowns are native <details>. Keep at most one open, and dismiss any open menu on an
  // outside click or Escape, so the settings / more / refresh / source menus never stack on top of
  // each other and don't linger when the user clicks away.
  useEffect(() => {
    const closeAll = (except?: Element | null) => {
      viewerRef.current?.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(node => {
        if (node !== except) node.open = false;
      });
    };
    const onToggle = (event: Event) => {
      const node = event.target;
      const root = viewerRef.current;
      if (!root || !(node instanceof HTMLDetailsElement) || !root.contains(node)) return;
      if (node.open) closeAll(node);
    };
    const onPointerDown = (event: Event) => {
      const root = viewerRef.current;
      if (!root) return;
      const target = event.target as Node;
      let insideOpen = false;
      root.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(node => {
        if (node.contains(target)) insideOpen = true;
      });
      if (!insideOpen) closeAll();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAll();
    };
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const dropEnabled = capabilities.openPaths;
  const onDragEnter = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
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
    openPaths([paths[0]]);
  };

  const selectAndScroll = (id: string) => {
    setSelectedId(id);
    viewport.resetScroll();
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
      <LandingViewerWelcome
        state={state}
        dragging={dragging}
        message={message}
        canChooseFolder={capabilities.chooseFolder}
        chooseFolder={chooseFolder}
        teamSources={teamSources}
        canRemove={capabilities.removeCatalog}
        activate={activate}
        remove={removeCatalog}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
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
      ref={viewerRef}
      className={`landing-gallery-viewer ${sidebarOpen ? '' : 'sidebar-collapsed'} ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={dropEnabled ? onDragEnter : undefined}
      onDragOver={dropEnabled ? event => event.preventDefault() : undefined}
      onDragLeave={dropEnabled ? onDragLeave : undefined}
      onDrop={dropEnabled ? handleDrop : undefined}
    >
      <header className="landing-gallery-toolbar">
        <div className="landing-gallery-toolbar-group is-leading">
          <GalleryIconButton label={t('landingGalleryBack')} onClick={() => navigateTo('/')}>
            ←
          </GalleryIconButton>
          <GalleryIconButton
            label={t('landingGalleryToggleSidebar')}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(value => !value)}
          >
            ☰
          </GalleryIconButton>
          <LandingSourceSwitcher
            catalogs={state.catalogs}
            activeCatalogId={state.activeCatalogId}
            activeCatalogName={state.activeCatalogName}
            landingCount={state.landings.length}
            disabled={state.running}
            canChooseFolder={capabilities.chooseFolder}
            onActivate={activate}
            onChooseFolder={chooseFolder}
          />
          <div className="landing-gallery-identity">
            <strong>{selected?.name ?? state.activeCatalogName}</strong>
            <span title={selected?.relativePath}>{selected?.relativePath ?? phaseLabel}</span>
          </div>
        </div>

        <div className="landing-gallery-toolbar-group is-navigation">
          <GalleryIconButton
            label={t('landingGalleryPrevious')}
            disabled={!state.landings.length}
            onClick={() => onStep(-1)}
          >
            ‹
          </GalleryIconButton>
          <span className="landing-gallery-counter numeric">
            {t('landingGalleryCounter', {
              current: selectedIndex >= 0 ? selectedIndex + 1 : 0,
              total: state.landings.length
            })}
          </span>
          <GalleryIconButton
            label={t('landingGalleryNext')}
            disabled={!state.landings.length}
            onClick={() => onStep(1)}
          >
            ›
          </GalleryIconButton>
        </div>

        <div className="landing-gallery-toolbar-group is-actions">
          <div className="landing-gallery-zoom">
            <GalleryIconButton label={t('landingGalleryZoomOut')} onClick={viewport.zoomOut}>
              −
            </GalleryIconButton>
            <button
              type="button"
              className="landing-gallery-delayed-tooltip"
              data-tooltip={t('landingGalleryActualSize')}
              aria-label={t('landingGalleryActualSize')}
              onClick={viewport.resetZoom}
            >
              {Math.round(scale * 100)}%
            </button>
            <GalleryIconButton label={t('landingGalleryZoomIn')} onClick={viewport.zoomIn}>
              +
            </GalleryIconButton>
          </div>
          <Button
            variant="ghost"
            className="landing-gallery-label-action"
            aria-pressed={zoomMode === 'fit-width'}
            onClick={() => viewport.setZoomMode('fit-width')}
          >
            {t('landingGalleryFitWidth')}
          </Button>
          <Button
            variant="ghost"
            className="landing-gallery-label-action"
            aria-pressed={zoomMode === 'fit-page'}
            onClick={() => viewport.setZoomMode('fit-page')}
          >
            {t('landingGalleryFitPage')}
          </Button>
          {capabilities.refresh && (
            <LandingRefreshControl
              running={state.running}
              openingTeam={openingTeam}
              isTeam={activeCatalog?.sourceKind === 'team'}
              hasSelection={Boolean(selected)}
              onRefreshFolder={() => {
                if (activeCatalog?.sourceKind === 'team' && activeCatalog.teamId) {
                  onRefreshActiveTeamSpace?.(activeCatalog.teamId);
                } else {
                  refresh('changed');
                }
              }}
              onRefreshCurrent={() => {
                if (selected) refresh('current', selected.id);
              }}
              onRebuildAll={() => refresh('all')}
            />
          )}
          {capabilities.reveal && (
            <GalleryIconButton
              label={t('landingGalleryReveal')}
              disabled={!selected || selected.sourceKind === 'team'}
              onClick={() => selected && reveal(selected.id)}
            >
              ⌂
            </GalleryIconButton>
          )}
          {selected?.sourceKind === 'zip' && capabilities.openExtracted && (
            <GalleryIconButton
              label={t('landingGalleryOpenExtracted')}
              disabled={!selected.extractedAvailable}
              onClick={() => openExtracted(selected.id)}
            >
              ▣
            </GalleryIconButton>
          )}
          <div
            className="landing-gallery-viewmode landing-gallery-segment"
            role="group"
            aria-label={t('landingGalleryGrid')}
          >
            <button type="button" aria-pressed={!gridMode} onClick={() => setGridMode(false)}>
              {t('landingGalleryViewSingle')}
            </button>
            <button
              type="button"
              aria-pressed={gridMode}
              disabled={!state.landings.length}
              onClick={() => setGridMode(true)}
            >
              {t('landingGalleryViewGrid')}
            </button>
          </div>
          <GalleryIconButton
            label={t('landingGalleryFullscreen')}
            aria-pressed={viewport.fullscreen}
            onClick={viewport.toggleFullscreen}
          >
            {viewport.fullscreen ? '×' : '⛶'}
          </GalleryIconButton>
          {capabilities.settings && (
            <GallerySettingsMenu
              settings={state.settings ?? emptyState.settings}
              disabled={state.running}
              onChange={updateSettings}
            />
          )}
          <GalleryMoreMenu
            running={state.running}
            hasActiveCatalog={Boolean(state.activeCatalogId)}
            capabilities={capabilities}
            onClearCache={clearCache}
            onRemoveActiveCatalog={() =>
              state.activeCatalogId && removeCatalog(state.activeCatalogId)
            }
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
            onChange={event => activate(event.target.value)}
          >
            {state.catalogs.map(catalog => (
              <option value={catalog.id} key={catalog.id}>
                {catalog.name} · {catalog.landingCount}
              </option>
            ))}
          </select>
          {capabilities.chooseFolder && (
            <button
              type="button"
              className="landing-gallery-source-add"
              disabled={state.running}
              onClick={chooseFolder}
            >
              ＋ {t('landingGalleryChooseAnother')}
            </button>
          )}
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
            onSelect={selectAndScroll}
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
        ref={canvasRef}
        className={`landing-gallery-canvas ${gridMode ? 'is-grid' : ''}`}
        onPointerDown={viewport.canvasHandlers.onPointerDown}
        onPointerMove={viewport.canvasHandlers.onPointerMove}
        onPointerUp={viewport.canvasHandlers.onPointerUp}
        onPointerCancel={viewport.canvasHandlers.onPointerCancel}
      >
        {gridMode ? (
          <LandingGalleryGrid
            landings={state.landings}
            selectedId={selectedId}
            imageUrl={source.imageUrl}
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
                  src={source.imageUrl(selected, index)}
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
            body={
              selected.sourceKind === 'team' && !selected.error
                ? t('landingGalleryTeamNeedsRender')
                : (selected.error ?? phaseLabel)
            }
            busy={
              selected.status === 'rendering' ||
              renderingTeamMaterialId === selected.sourceRelativePath
            }
            action={
              selected.sourceKind === 'team' && selected.status !== 'rendering' ? (
                <Button
                  variant="primary"
                  disabled={renderingTeamMaterialId !== null || openingTeam}
                  onClick={() => onCreateTeamPreview?.()}
                >
                  {t('teamLandingCreatePreview')}
                </Button>
              ) : undefined
            }
          />
        ) : state.running ? (
          <GalleryEmpty title={phaseLabel} busy />
        ) : (
          <GalleryEmpty
            title={t('landingGalleryEmptyTitle')}
            body={t('landingGalleryEmptyBody')}
            action={
              capabilities.refresh ? (
                <Button variant="primary" onClick={() => refresh('changed')}>
                  {t('landingGalleryRefreshFolder')}
                </Button>
              ) : capabilities.chooseFolder ? (
                <Button onClick={chooseFolder}>{t('landingGalleryChooseAnother')}</Button>
              ) : undefined
            }
          />
        )}
        {!gridMode && selectedIndex > 0 && (
          <button
            className="landing-gallery-edge-nav is-left"
            type="button"
            aria-label={t('landingGalleryPrevious')}
            onClick={() => onStep(-1)}
          >
            ‹
          </button>
        )}
        {!gridMode && selectedIndex >= 0 && selectedIndex < state.landings.length - 1 && (
          <button
            className="landing-gallery-edge-nav is-right"
            type="button"
            aria-label={t('landingGalleryNext')}
            onClick={() => onStep(1)}
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
              <Button variant="ghost" onClick={() => cancel()}>
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
