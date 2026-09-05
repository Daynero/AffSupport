import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react';
import {
  ArrowLeft,
  Ban,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Maximize,
  Minimize,
  Minus,
  MoveHorizontal,
  PanelLeft,
  Plus,
  Scan,
  Search,
  TriangleAlert
} from 'lucide-react';
import { Button, ProgressBar, Spinner } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { navigateTo } from '../lib/navigation';
import {
  droppedFilePaths,
  firstDroppedDirectory,
  sampleDroppedFolder
} from '../components/DropZone';
import { emptyState, type LandingPreviewItem, type LandingViewerSource } from './types';
import { readViewerPreferences, writeViewerPreferences } from './viewerPreferences';
import { useLandingViewport } from './useLandingViewport';
import type { UseLandingViewer } from './useLandingViewer';
import { GalleryIconButton } from './internal/GalleryIconButton';
import { GalleryEmpty } from './internal/GalleryEmpty';
import { MenuHeading, MenuItem, MenuSeparator } from './internal/ViewerMenu';
import { phaseKey } from './internal/phaseKey';
import { useToolbarStages } from './internal/useToolbarStages';
import { LandingTree } from './LandingTree';
import { LandingGalleryGrid } from './LandingGalleryGrid';
import { GallerySettingsMenu } from './GallerySettingsMenu';
import { GalleryMoreMenu } from './GalleryMoreMenu';
import { LandingSourceSwitcher } from './LandingSourceSwitcher';
import { LandingRefreshControl } from './LandingRefreshControl';
import { LandingViewerWelcome } from './LandingViewerWelcome';

const icon = { size: ICON_SIZE, strokeWidth: ICON_STROKE, 'aria-hidden': true } as const;
const menuIcon = { size: ICON_SIZE - 2, strokeWidth: ICON_STROKE, 'aria-hidden': true } as const;

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
    narrow,
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
  const toolbar = useToolbarStages();

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
    zoomDisabled: gridMode,
    initial: { zoomMode: preferences.zoomMode, customScale: preferences.customScale },
    remeasureKey: `${state.activeCatalogId ?? ''}:${loaded ? 1 : 0}`,
    // The shortcuts belong to the stage; on the welcome page they only stole "-" and "+".
    keyboardEnabled: loaded && Boolean(state.activeCatalogId)
  });
  resetScrollRef.current = viewport.resetScroll;
  const { scale, zoomMode } = viewport;

  useEffect(() => {
    writeViewerPreferences({
      // On a phone the tree is closed by default and closes on every pick; remembering that
      // would greet the next desktop session with the tree hidden.
      sidebarOpen: narrow ? preferences.sidebarOpen : sidebarOpen,
      zoomMode,
      customScale: viewport.customScale
    });
  }, [narrow, preferences.sidebarOpen, sidebarOpen, viewport.customScale, zoomMode]);

  // The neighbours' first slice is fetched ahead, so an arrow press shows a page instead of a
  // blank stage. The browser caches by URL and the ticket is per landing, so this is one small
  // request each way and nothing when the images are already there.
  const neighbours = [state.landings[selectedIndex - 1], state.landings[selectedIndex + 1]];
  // Keyed on what would change the pictures, so a progress frame does not refetch them.
  const neighbourKey = neighbours
    .map(item => (item?.previewAvailable ? `${item.id}:${item.renderedAt}` : ''))
    .join('|');
  useEffect(() => {
    if (gridMode || selectedIndex < 0 || typeof Image === 'undefined') return;
    let active = true;
    for (const neighbour of neighbours) {
      if (!neighbour?.previewAvailable) continue;
      void Promise.resolve(source.imageUrl(neighbour, 0)).then(url => {
        if (active && url) new Image().src = url;
      });
    }
    return () => {
      active = false;
    };
  }, [gridMode, neighbourKey, source]);

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
  // Resolve a dropped folder the browser wouldn't give us a path for: read a sample file from it and
  // let the agent match it back to disk, then open it exactly like the picker. Falls back to the
  // picker only when the folder genuinely can't be located.
  const openDroppedFolder = useCallback(
    async (dir: FileSystemDirectoryEntry | null) => {
      if (!dir || !source.resolveDroppedFolder) {
        setMessage(t('landingGalleryDropNeedsPicker'));
        return;
      }
      try {
        const sample = await sampleDroppedFolder(dir);
        const resolved = sample ? await source.resolveDroppedFolder(sample) : null;
        if (resolved) openPaths([resolved]);
        else setMessage(t('landingGalleryDropNeedsPicker'));
      } catch {
        setMessage(t('landingGalleryDropNeedsPicker'));
      }
    },
    [source, openPaths, setMessage, t]
  );

  const openDropData = (data: DataTransfer) => {
    // Fast path: some contexts expose the OS path directly via the URI list.
    const paths = droppedFilePaths(data);
    if (paths.length) {
      openPaths([paths[0]]);
      return;
    }
    // Otherwise grab the directory entry synchronously (only valid during the event) and recover its
    // path on the agent.
    void openDroppedFolder(firstDroppedDirectory(data));
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    openDropData(event.dataTransfer);
  };

  useEffect(() => {
    if (!sidebarOpen || !narrow) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [narrow, sidebarOpen, setSidebarOpen]);

  const selectAndScroll = (id: string) => {
    setSelectedId(id);
    viewport.resetScroll();
    if (narrow) setSidebarOpen(false);
  };

  if (!loaded) {
    return (
      <main className="lv-loading" aria-label={t('loading')}>
        <Spinner />
      </main>
    );
  }

  if (!state.activeCatalogId) {
    return (
      <LandingViewerWelcome
        state={state}
        message={message}
        canChooseFolder={capabilities.chooseFolder}
        chooseFolder={chooseFolder}
        onDropData={openDropData}
        teamSources={teamSources}
        canRemove={capabilities.removeCatalog}
        activate={activate}
        remove={removeCatalog}
      />
    );
  }

  const phaseLabel = t(phaseKey(state.progress.phase));
  const progress = state.progress.total
    ? Math.round((state.progress.completed / state.progress.total) * 100)
    : state.running
      ? null
      : 100;
  // What the preview cannot promise. Blocked requests and a failing script are facts about
  // the landing and read as information; a cropped or downscaled page is our own limit.
  const previewNotes: Array<{ key: string; text: string; tone: 'info' | 'warning' }> = [];
  if (selected) {
    if (selected.blockedExternalRequests > 0) {
      previewNotes.push({
        key: 'blocked',
        text: t('landingGalleryBlockedRequests', { count: selected.blockedExternalRequests }),
        tone: 'info'
      });
    }
    for (const code of (selected.warning ?? '').split(',').filter(Boolean)) {
      previewNotes.push(
        code === 'PAGE_SCRIPT_ERROR'
          ? { key: code, text: t('landingGalleryPageErrorWarning'), tone: 'info' }
          : code === 'PREVIEW_CROPPED'
            ? { key: code, text: t('landingGalleryCroppedWarning'), tone: 'warning' }
            : code === 'PREVIEW_DOWNSCALED'
              ? { key: code, text: t('landingGalleryDownscaledWarning'), tone: 'warning' }
              : { key: code, text: code, tone: 'warning' }
      );
    }
  }
  const counts = landingCounts(state.landings);
  const canReveal = capabilities.reveal && Boolean(selected) && selected?.sourceKind !== 'team';
  const canOpenExtracted =
    capabilities.openExtracted && selected?.sourceKind === 'zip' && selected.extractedAvailable;

  return (
    <div
      ref={viewerRef}
      className={`lv-viewer ${sidebarOpen ? '' : 'sidebar-collapsed'} ${dragging ? 'is-dragging' : ''} ${gridMode ? 'is-grid-mode' : ''}`.trim()}
      onDragEnter={dropEnabled ? onDragEnter : undefined}
      onDragOver={dropEnabled ? event => event.preventDefault() : undefined}
      onDragLeave={dropEnabled ? onDragLeave : undefined}
      onDrop={dropEnabled ? handleDrop : undefined}
    >
      <header className="lv-toolbar" ref={toolbar.ref}>
        <div className="lv-group is-leading">
          <GalleryIconButton label={t('landingGalleryBack')} onClick={() => navigateTo('/')}>
            <ArrowLeft {...icon} />
          </GalleryIconButton>
          <GalleryIconButton
            label={t('landingGalleryToggleSidebar')}
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(value => !value)}
          >
            <PanelLeft {...icon} />
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
          {selected && (
            <div className="lv-identity" data-flexible="">
              <strong>{selected.name}</strong>
              {selected.relativePath !== selected.name && <span>{selected.relativePath}</span>}
            </div>
          )}
        </div>

        <div className="lv-group is-navigation">
          <GalleryIconButton
            label={t('landingGalleryPrevious')}
            disabled={!state.landings.length}
            onClick={() => onStep(-1)}
          >
            <ChevronLeft {...icon} />
          </GalleryIconButton>
          <span className="lv-counter">
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
            <ChevronRight {...icon} />
          </GalleryIconButton>
        </div>

        <div className="lv-group is-actions">
          <div className="lv-cluster lv-zoom" role="group" aria-label={t('landingGalleryZoom')}>
            <GalleryIconButton
              className="lv-zoom-step"
              label={t('landingGalleryZoomOut')}
              onClick={viewport.zoomOut}
            >
              <Minus {...icon} />
            </GalleryIconButton>
            <GalleryIconButton
              className="lv-zoom-value"
              label={t('landingGalleryActualSize')}
              onClick={viewport.resetZoom}
            >
              {Math.round(scale * 100)}%
            </GalleryIconButton>
            <GalleryIconButton
              className="lv-zoom-step"
              label={t('landingGalleryZoomIn')}
              onClick={viewport.zoomIn}
            >
              <Plus {...icon} />
            </GalleryIconButton>
          </div>
          <div
            className="lv-cluster is-captioned lv-fit"
            role="group"
            aria-label={t('landingGalleryFitWidth')}
          >
            {/* The chosen mode says its name; the other stays an icon, as in the compressor. */}
            <GalleryIconButton
              label={t('landingGalleryFitWidth')}
              className="has-label"
              aria-pressed={zoomMode === 'fit-width'}
              onClick={() => viewport.setZoomMode('fit-width')}
            >
              <MoveHorizontal {...icon} />
              <span className="action-label">{t('landingGalleryFitWidthShort')}</span>
            </GalleryIconButton>
            <GalleryIconButton
              label={t('landingGalleryFitPage')}
              className="has-label"
              aria-pressed={zoomMode === 'fit-page'}
              onClick={() => viewport.setZoomMode('fit-page')}
            >
              <Scan {...icon} />
              <span className="action-label">{t('landingGalleryFitPageShort')}</span>
            </GalleryIconButton>
          </div>
          {capabilities.settings && (
            <GallerySettingsMenu
              settings={state.settings ?? emptyState.settings}
              disabled={state.running}
              onChange={updateSettings}
            />
          )}
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
          <div
            className="lv-cluster is-captioned lv-viewmode"
            role="group"
            aria-label={t('landingGalleryGrid')}
          >
            <GalleryIconButton
              label={t('landingGalleryViewSingle')}
              className="has-label"
              aria-pressed={!gridMode}
              onClick={() => setGridMode(false)}
            >
              <ImageIcon {...icon} />
              <span className="action-label">{t('landingGalleryViewSingle')}</span>
            </GalleryIconButton>
            <GalleryIconButton
              label={t('landingGalleryViewGrid')}
              className="has-label"
              aria-pressed={gridMode}
              disabled={!state.landings.length}
              onClick={() => setGridMode(true)}
            >
              <LayoutGrid {...icon} />
              <span className="action-label">{t('landingGalleryViewGrid')}</span>
            </GalleryIconButton>
          </div>
          <GalleryIconButton
            className="lv-fullscreen"
            label={t('landingGalleryFullscreen')}
            aria-pressed={viewport.fullscreen}
            onClick={viewport.toggleFullscreen}
          >
            {viewport.fullscreen ? <Minimize {...icon} /> : <Maximize {...icon} />}
          </GalleryIconButton>
          <GalleryMoreMenu
            running={state.running}
            hasActiveCatalog={Boolean(state.activeCatalogId)}
            capabilities={capabilities}
            leading={close => (
              <>
                {/* The page counter has no room in the toolbar on a phone; it lives here. */}
                {narrow && state.landings.length > 0 && (
                  <MenuHeading>
                    {t('landingGalleryCounter', {
                      current: selectedIndex >= 0 ? selectedIndex + 1 : 0,
                      total: state.landings.length
                    })}
                  </MenuHeading>
                )}
                {!gridMode && (
                  <>
                    <MenuItem
                      icon={<MoveHorizontal {...menuIcon} />}
                      checked={zoomMode === 'fit-width'}
                      onClick={() => {
                        close();
                        viewport.setZoomMode('fit-width');
                      }}
                    >
                      {t('landingGalleryFitWidth')}
                    </MenuItem>
                    <MenuItem
                      icon={<Scan {...menuIcon} />}
                      checked={zoomMode === 'fit-page'}
                      onClick={() => {
                        close();
                        viewport.setZoomMode('fit-page');
                      }}
                    >
                      {t('landingGalleryFitPage')}
                    </MenuItem>
                    <MenuItem
                      icon={<ImageIcon {...menuIcon} />}
                      checked={zoomMode === 'custom' && Math.round(scale * 100) === 100}
                      onClick={() => {
                        close();
                        viewport.resetZoom();
                      }}
                    >
                      {t('landingGalleryActualSize')}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                <MenuItem
                  icon={<LayoutGrid {...menuIcon} />}
                  checked={gridMode}
                  disabled={!state.landings.length}
                  onClick={() => {
                    close();
                    setGridMode(value => !value);
                  }}
                >
                  {t('landingGalleryViewGrid')}
                </MenuItem>
                <MenuItem
                  icon={
                    viewport.fullscreen ? <Minimize {...menuIcon} /> : <Maximize {...menuIcon} />
                  }
                  checked={viewport.fullscreen}
                  onClick={() => {
                    close();
                    viewport.toggleFullscreen();
                  }}
                >
                  {t('landingGalleryFullscreen')}
                </MenuItem>
                {(capabilities.reveal || capabilities.openExtracted) && <MenuSeparator />}
                {capabilities.reveal && (
                  <MenuItem
                    icon={<FolderSearch {...menuIcon} />}
                    disabled={!canReveal}
                    onClick={() => {
                      close();
                      if (selected) reveal(selected.id);
                    }}
                  >
                    {t('landingGalleryReveal')}
                  </MenuItem>
                )}
                {capabilities.openExtracted && (
                  <MenuItem
                    icon={<FolderOpen {...menuIcon} />}
                    disabled={!canOpenExtracted}
                    onClick={() => {
                      close();
                      if (selected) openExtracted(selected.id);
                    }}
                  >
                    {t('landingGalleryOpenExtracted')}
                  </MenuItem>
                )}
              </>
            )}
            onClearCache={clearCache}
            onRemoveActiveCatalog={() =>
              state.activeCatalogId && removeCatalog(state.activeCatalogId)
            }
          />
        </div>
      </header>

      {/* A tap on the dimmed page closes the sheet; the toolbar button is the one AT sees. */}
      <button
        type="button"
        className="lv-scrim"
        aria-hidden="true"
        tabIndex={-1}
        onClick={() => setSidebarOpen(false)}
      />
      <aside className="lv-sidebar" inert={!sidebarOpen} aria-label={t('landingGalleryTree')}>
        <label className="lv-search">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('landingGallerySearch')}
            aria-label={t('landingGallerySearch')}
          />
        </label>
        <div className="lv-tree-scroll">
          <LandingTree
            landings={state.landings}
            selectedId={selectedId}
            search={search}
            onSelect={selectAndScroll}
          />
        </div>
        <footer className="lv-sidebar-foot">
          <span>
            <span>{t('landingGalleryReadyCount', { count: counts.ready })}</span>
            {counts.rendering > 0 && (
              <span>{t('landingGalleryRenderingCount', { count: counts.rendering })}</span>
            )}
            {counts.stale > 0 && (
              <span>{t('landingGalleryStaleCount', { count: counts.stale })}</span>
            )}
            {counts.failed > 0 && (
              <span>{t('landingGalleryFailedCount', { count: counts.failed })}</span>
            )}
          </span>
          {state.warnings.length > 0 && (
            <details className="lv-warnings">
              <summary>
                <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
                {t('landingGalleryWarnings')}
              </summary>
              <div>
                {state.warnings.map((warning, index) => (
                  <p key={`${warning}-${index}`}>{warning}</p>
                ))}
              </div>
            </details>
          )}
        </footer>
      </aside>

      <main
        ref={canvasRef}
        className={`lv-canvas ${gridMode ? 'is-grid' : ''}`.trim()}
        // The scroll container itself takes focus, so a keyboard scrolls a tall page.
        tabIndex={0}
        aria-label={selected?.name ?? t('landingGallery')}
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
            thumbnailUrl={source.thumbnailUrl}
            onSelect={id => {
              setSelectedId(id);
              setGridMode(false);
            }}
          />
        ) : !state.renderer.available ? (
          <GalleryEmpty
            icon={<TriangleAlert {...icon} />}
            title={t('landingGalleryRendererMissing')}
            body={t('landingGalleryRendererMissingBody')}
          />
        ) : selected?.previewAvailable ? (
          <>
            {(selected.stale || previewNotes.length > 0) && (
              <div className="lv-notes">
                {selected.stale && (
                  <span className="lv-note is-info">
                    <Info size={14} strokeWidth={2} aria-hidden="true" />
                    {t('landingGalleryOldPreview')}
                  </span>
                )}
                {previewNotes.map(note => (
                  <span
                    key={note.key}
                    className={`lv-note ${note.tone === 'info' ? 'is-info' : ''}`.trim()}
                  >
                    {note.tone === 'info' ? (
                      <Info size={14} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
                    )}
                    {note.text}
                  </span>
                ))}
              </div>
            )}
            <div
              className="lv-stage"
              style={{
                width: selected.previewWidth ? selected.previewWidth * scale : undefined,
                minHeight: selected.previewHeight ? selected.previewHeight * scale : undefined
              }}
            >
              <div className="lv-stage-stack">
                {Array.from({ length: Math.max(1, selected.previewSegments ?? 1) }, (_, index) => (
                  <SegmentImage
                    key={`${selected.id}-${selected.renderedAt}-${index}`}
                    source={source}
                    item={selected}
                    segment={index}
                    alt={index === 0 ? selected.name : ''}
                    scale={scale}
                  />
                ))}
              </div>
            </div>
          </>
        ) : selected ? (
          <>
            {selected.status !== 'failed' && (
              <div className="lv-stage is-skeleton" aria-hidden="true" />
            )}
            <GalleryEmpty
              icon={
                selected.status === 'failed' ? <TriangleAlert {...icon} /> : <ImageIcon {...icon} />
              }
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
          </>
        ) : state.running ? (
          <GalleryEmpty title={phaseLabel} busy />
        ) : (
          <GalleryEmpty
            icon={<FolderSearch {...icon} />}
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
            className="lv-edge-nav is-left"
            type="button"
            aria-label={t('landingGalleryPrevious')}
            onClick={() => onStep(-1)}
          >
            <ChevronLeft size={24} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
        {!gridMode && selectedIndex >= 0 && selectedIndex < state.landings.length - 1 && (
          <button
            className="lv-edge-nav is-right"
            type="button"
            aria-label={t('landingGalleryNext')}
            onClick={() => onStep(1)}
          >
            <ChevronRight size={24} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
      </main>

      {(state.running || state.error || message || connectionLost) && (
        <footer
          className={`lv-progress ${state.error || message || connectionLost ? 'is-error' : ''}`.trim()}
        >
          {/* Only the words are announced; the bar and the button beside them are not. */}
          <div role="status">
            {state.error || message || connectionLost ? (
              <TriangleAlert size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
            ) : (
              <Spinner small />
            )}
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
                <Ban size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('landingGalleryCancel')}
              </Button>
            </>
          )}
        </footer>
      )}
      {dragging && (
        <div className="lv-drop-overlay">
          <strong>{t('landingGalleryDropActive')}</strong>
          <span>{t('landingGalleryDropHint')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One segment of a rendered landing, resolved through the source.
 *
 * The agent-backed source mints a capability ticket per landing, so a tall page
 * split into sixty segments costs one request, not sixty — the ticket is
 * scoped to the path, and every segment shares it.
 */
function SegmentImage({
  source,
  item,
  segment,
  alt,
  scale
}: {
  source: LandingViewerSource;
  item: Parameters<LandingViewerSource['imageUrl']>[0];
  segment: number;
  alt: string;
  scale: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const revision = `${item.id}:${item.renderedAt}`;
  useEffect(() => {
    let active = true;
    void Promise.resolve(source.imageUrl(item, segment)).then(next => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
    // The item object is replaced by every pushed state; the picture changes with its revision.
  }, [source, revision, segment]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={alt}
      aria-hidden={segment > 0 ? true : undefined}
      draggable={false}
      decoding="async"
      // The first slice is the page; the rest of a sixty-slice landing arrive as it is scrolled,
      // rather than all at once through the six sockets the local app gets.
      loading={segment === 0 ? 'eager' : 'lazy'}
      fetchPriority={segment === 0 ? 'high' : 'auto'}
      style={{ width: item.previewWidth ? item.previewWidth * scale : undefined }}
    />
  );
}

function landingCounts(landings: LandingPreviewItem[]) {
  const counts = { ready: 0, rendering: 0, failed: 0, stale: 0 };
  for (const item of landings) {
    if (item.previewAvailable && !item.stale) counts.ready += 1;
    if (item.status === 'rendering') counts.rendering += 1;
    if (item.status === 'failed') counts.failed += 1;
    // A landing already being re-rendered is counted there, not twice.
    if (item.stale && item.status !== 'rendering') counts.stale += 1;
  }
  return counts;
}
