import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamMaterialTagColor,
  TeamPermissions
} from '@video-compressor/shared';
import type { DriveCatalogResyncResult, TeamMaterialSummary } from '../../api/team';
import { Eye, RotateCcw } from 'lucide-react';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { usePaneArrival } from './usePaneArrival';
import { crossfadePart } from '../../lib/auto-crossfade';
import { BeforeChange } from '../../lib/before-change';
import { moveFromPlaces, rememberPlaces } from '../../lib/layout-move';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { useOptionalAgent } from '../../AgentContext';
import type { TeamCatalogClient } from '../catalog/TeamCatalog';
import { TrashView } from '../catalog/TrashView';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import {
  defaultMaterialActionsClient,
  type MaterialActionsClient
} from '../catalog/material-actions-client';
import type { TeamRouteQuery, ExplorerView } from '../routes';
import { ContentGrid, type ContentGridClient } from './ContentGrid';
import { useCreativeRanks, type CreativeRanksClient } from '../ranks/useCreativeRanks';
import { carriesRank } from '../ranks/creativeRanks';
import { ContentList } from './ContentList';
import { ExplorerProvider, useExplorer, type ExplorerClient } from './ExplorerProvider';
import { FolderTree } from './FolderTree';
import { sortRows, readRememberedSort, rememberSort, type ExplorerSort } from './sort';
import { PreviewPane } from './PreviewPane';
import { useAgentQueue } from './useAgentQueue';
import { useOptionalSpaceAgentQueue } from '../processing/AgentQueueProvider';
import { useOptionalAddToTask } from '../tasks/AddToTask';
import { useExplorerClipboard } from './useExplorerClipboard';
import type { LibraryBatchScope } from '../library/ProcessLibraryDialog';
import type { FolderSubtreeClient } from './FolderScopeDialog';
import {
  compressJobs,
  type CompressPlan,
  type CompressPlanItem as CompressPlanItem_
} from './TeamCompressorDialog';
import { useCompanionFold } from './useCompanionFold';
import { useFolderPage } from './useFolderPage';
import { useVisibleRowAnchor } from './useVisibleRowAnchor';
import { useMarqueeSelection } from './useSelectionGestures';
import type { FolderResyncClient } from './useFolderResync';
import { SyncStatusPanel } from './SyncStatusPanel';
import { usePosterFrames } from './usePosterFrames';
import { useOptionalWorkspaceOperations } from './WorkspaceOperationsProvider';
import { useExplorerRestitch } from './useExplorerRestitch';
import { useExplorerResync } from './useExplorerResync';
import { useExplorerReveal } from './useExplorerReveal';
import { usePreparedIds, useStorageKind } from './useExplorerRowFacts';
import { useExplorerFileOps } from './useExplorerFileOps';
import { useExplorerUploads } from './useExplorerUploads';
import { useExplorerKeyboard } from './useExplorerKeyboard';
import { useExplorerMeasure } from './useExplorerMeasure';
import { explorerRowActions } from './explorerRowActions';
import { ExplorerResults } from './ExplorerResults';
import { ExplorerToolbar } from './ExplorerToolbar';
import { KindFilterMenu } from './KindFilterMenu';
import { KIND_LABEL } from './rowKinds';
import { SortMenu } from './SortMenu';
import { ExplorerSelection } from './ExplorerSelection';
import { ExplorerDropZone } from './ExplorerDropZone';
import { ExplorerProcessStack } from './ExplorerProcessStack';
import { ExplorerDialogs, type ExplorerFolderScope } from './ExplorerDialogs';

export type ExplorerShellClient = ExplorerClient &
  FolderResyncClient &
  CreativeRanksClient &
  ContentGridClient &
  TeamCatalogClient &
  FolderPickerClient &
  FolderSubtreeClient & {
    getConnectionStatus?: (teamId: string) => Promise<{ driveKind?: TeamAnalyticsStorage | null }>;
    resyncDrive?: (
      teamId: string,
      options?: { signal?: AbortSignal }
    ) => Promise<DriveCatalogResyncResult>;
    /** Only the space's owner may call this; the database is what enforces it. */
    setMaterialTag?: (input: {
      teamId: string;
      materialId: string;
      color: TeamMaterialTagColor | null;
    }) => Promise<TeamMaterialTagColor | null>;
  };

export type { ExplorerView };

/**
 * The explorer (011, US3): one screen for everything the old Files, Landings
 * and Creatives tabs did. Tree on the left, the open folder (or a search, or
 * the trash) in the middle, the selected row on the right. Every piece of view
 * state lives in the address, so a refresh and a pasted link land on the same
 * screen.
 */

export type ExplorerShellProps = {
  teamId: string;
  retryGroupId?: string | null;
  onRetryComplete?: () => void;
  client: ExplorerShellClient;
  revision?: number;
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onFolderChange: (folderId: string | null) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: (materialIds: string[], scope?: LibraryBatchScope) => void;
  onProcessLibrary?: () => void;
  onChanged?: () => void;
  onReset?: () => void;
  actionsClient?: MaterialActionsClient;
  /** Storage needs a person (011, FR-033): browse and preview only. */
  readOnly?: boolean;
  /**
   * Where leaving the trash goes, named, when that is not the files (024,
   * FR-046): a trash opened from Tasks returns to Tasks, and a button promising
   * "back to files" would be a small lie about where it goes.
   */
  trashReturnLabel?: string;
};

export function ExplorerShell(props: ExplorerShellProps) {
  const {
    teamId,
    client,
    revision = 0,
    query,
    onFolderChange,
    actionsClient = defaultMaterialActionsClient,
    readOnly = false
  } = props;
  return (
    <ExplorerProvider
      teamId={teamId}
      client={client}
      revision={revision}
      folderId={query.folderId}
      onFolderChange={onFolderChange}
    >
      <ExplorerBody
        {...props}
        revision={revision}
        actionsClient={actionsClient}
        readOnly={readOnly}
      />
    </ExplorerProvider>
  );
}

function ExplorerBody({
  teamId,
  retryGroupId,
  onRetryComplete,
  client,
  revision,
  query,
  onQueryChange,
  onSearched,
  onPreview,
  onCreateTask,
  onCreateTaskFromSelection,
  onProcessSelection,
  onProcessLibrary,
  onChanged,
  onReset,
  actionsClient,
  readOnly,
  trashReturnLabel
}: ExplorerShellProps & {
  revision: number;
  actionsClient: MaterialActionsClient;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  /* 015 — one running re-stitched delivery per material, held here rather than in the row:
     a delivery outlives the menu that started it and the row that scrolled past. */
  const { restitch, deliveringMaterial, deliverRestitched } = useExplorerRestitch(
    teamId,
    query?.settings === true
  );
  const {
    permissions: loadedPermissions,
    activeTeam,
    notifyStateChanged,
    ranksRevision = 0
  } = useTeam();
  // Every write goes dark while storage needs a person (FR-033); nothing is lost.
  const permissions = readOnly ? null : loadedPermissions;
  const explorer = useExplorer();
  const {
    currentFolderId,
    openFolder,
    selectedId,
    select,
    selectedRows: selectedRowsMap,
    clearSelection,
    pathTo,
    nodeOf
  } = explorer;
  const [treeOpen, setTreeOpen] = useState(false);
  const [processing, setProcessing] = useState<{ row: TeamMaterialRow } | null>(null);
  const [catalogFor, setCatalogFor] = useState<TeamMaterialRow | null>(null);
  /*
   * The card's live transcription progress used to have a second source: a
   * `tool` on this state that nothing ever set, so the branch that read it, the
   * state it wrote and its setter were all unreachable. The queue below is the
   * one source now — it is what actually runs a transcription here.
   */
  // One transcription queue for the whole explorer (owner, 2026-08-30): the
  // card's Transcribe enqueues, the folder batch enqueues, and everything runs
  // in the background one after another — a corner panel shows the progress,
  // nothing blocks the screen.
  const agentCtx = useOptionalAgent();
  /* A row from the list or the folder that is open — the batch needs a name
     and a drive id, and both kinds of thing carry those. */
  /* Reading a folder's subtree, and what the answer is for. All three of the
     folder-wide commands need the same walk, so they share one window. */
  const [folderScope, setFolderScope] = useState<ExplorerFolderScope | null>(null);
  const [compressing, setCompressing] = useState<CompressPlanItem_[] | null>(null);
  const workspaceOperations = useOptionalWorkspaceOperations();
  const addMenuAnchor = useRef<HTMLButtonElement | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const closeCreateFolder = useCallback(() => setCreatingFolder(false), []);
  const view: ExplorerView = query.view ?? readRememberedView();
  const [sort, setSortState] = useState<ExplorerSort>(() => readRememberedSort());
  const setSort = (next: ExplorerSort) => {
    rememberSort(next);
    setSortState(next);
  };
  const changeSort = (next: ExplorerSort) => {
    // Another order is the same folder: only the list dissolves (058).
    crossfadePart(mainRef.current);
    setSort(next);
  };
  /*
   * A tag is a shared judgement about a file, so it is the space owner's to
   * make and everyone else's to read (011). The database refuses anyone else
   * outright; this is what keeps the dot from looking pressable to them.
   */
  const canTag = !readOnly && activeTeam?.role === 'owner' && Boolean(client.setMaterialTag);
  const searching = query.q.length > 0 || query.scope !== 'folder';
  const contentRef = useRef<HTMLDivElement>(null);
  const explorerSurfaceRef = useRef<HTMLDivElement>(null);
  const explorerHeaderRef = useRef<HTMLDivElement>(null);
  const explorerListHeaderRef = useRef<HTMLDivElement>(null);
  useExplorerMeasure(explorerSurfaceRef, explorerHeaderRef, explorerListHeaderRef);
  const captureAnchorRef = useRef<() => void>(() => {});
  const { canResync, folderResync, syncScopeName, uploadingThisFolder } = useExplorerResync({
    teamId,
    client,
    currentFolderId,
    pathTo,
    nodeOf,
    readOnly,
    role: activeTeam?.role,
    workspaceOperations,
    notifyStateChanged,
    onComplete: async () => {
      await Promise.all([page.reloadStrict(), explorer.refreshStrict()]);
    }
  });
  const unindexedFolder = Boolean(currentFolderId && nodeOf(currentFolderId)?.indexedAt === null);
  const contentsPending = folderResync.running || uploadingThisFolder || unindexedFolder;
  const emptyState = uploadingThisFolder
    ? 'uploading'
    : folderResync.running
      ? 'syncing'
      : unindexedFolder
        ? 'unchecked'
        : undefined;
  const page = useFolderPage({
    teamId,
    client,
    parentFolderId: currentFolderId,
    kinds: query.kinds,
    revision,
    preserveOnEmpty: contentsPending,
    beforeRowsReplace: () => captureAnchorRef.current()
  });
  // 059 — the honey leagues of the videos and images on this page: one read, again when a rank
  // changes; the sort by rank reads them too.
  const rankedIds = useMemo(() => page.rows.filter(carriesRank).map(row => row.id), [page.rows]);
  const ranks = useCreativeRanks(teamId, rankedIds, ranksRevision, client);
  const allRows = useMemo(
    () => sortRows(page.rows, sort, ranks.ranks, kind => t(KIND_LABEL[kind])),
    [page.rows, sort, ranks.ranks, t]
  );
  const { folded, openedCompanions, toggleCompanions } = useCompanionFold(
    allRows,
    view,
    currentFolderId
  );
  const sortedRows = folded.rows;
  const rowIds = useMemo(() => sortedRows.map(row => row.id), [sortedRows]);
  captureAnchorRef.current = useVisibleRowAnchor(
    contentRef,
    rowIds,
    `${teamId}|${currentFolderId ?? ''}|${view}|${query.kinds.join(',')}`
  );
  /* Drag a rectangle over empty space to check what it touches (Finder's rubber band). */
  const marquee = useMarqueeSelection({
    containerRef: contentRef,
    zoneRef: explorerSurfaceRef,
    rows: sortedRows,
    resetKey: `${teamId}|${currentFolderId ?? ''}|${view}|${query.kinds.join(',')}`
  });

  const { revealMaterial, pathFor } = useExplorerReveal({
    query,
    searching,
    explorer,
    currentFolderId,
    page,
    onPreview,
    onQueryChange
  });
  const preparedIds = usePreparedIds(teamId, page.rows);
  // Drive has no picture for some videos and never will. The paired app makes
  // one, for what is on screen, one at a time.
  usePosterFrames({
    teamId,
    rows: page.rows,
    enabled: agentCtx?.teamWorkspaceAvailable === true && !readOnly,
    onRendered: () => void page.reload()
  });

  const storageKind = useStorageKind(client, teamId);

  const changed = useCallback(() => {
    onChanged?.();
    void page.reload();
  }, [onChanged, page]);

  /*
   * One queue for the work that runs on the local app: the card's Transcribe
   * enqueues, the folder batch enqueues, and everything runs one after another
   * while a corner panel shows the progress. It lives in its own file now
   * (024, FR-095) — 250 lines of it were in here, between the upload zone and
   * the keyboard handler.
   */
  const localQueue = useAgentQueue({ teamId, actionsClient, onChanged: changed });
  // The space owns the queue (024, FR-077); a Files shell mounted on its own —
  // a test, a preview — keeps one of its own, idle unless it is the one used.
  const space = useOptionalSpaceAgentQueue();
  const addToTask = useOptionalAddToTask();
  const queue = space?.queue ?? localQueue;

  const { tailClient, dropMaterials, downloadOriginal, trashRows, tagging } = useExplorerFileOps({
    teamId,
    actionsClient,
    page,
    currentFolderId,
    permissions,
    workspaceOperations,
    changed,
    clearSelection,
    select,
    nodeOf,
    pathTo,
    client,
    canTag
  });

  /* Copy, cut and paste, in their own file for the same reason (024). */
  const clipboard = useExplorerClipboard({
    teamId,
    currentFolderId: currentFolderId ?? null,
    permissions,
    tailClient,
    onChanged: changed,
    clearSelection
  });

  const setView = (next: ExplorerView) => {
    rememberView(next);
    onQueryChange({ view: next });
  };

  const { upload, uploadDrop, pickFolder, createFolder, uploading, conflict } = useExplorerUploads({
    teamId,
    client,
    currentFolderId,
    nodeOf,
    explorer,
    page,
    permissions,
    workspaceOperations,
    retryGroupId,
    onRetryComplete,
    onChanged,
    changed,
    onFolderCreated: closeCreateFolder
  });

  const actions = explorerRowActions({
    teamId,
    permissions,
    clipboard,
    currentFolderId,
    openFolder,
    client,
    actionsClient,
    storageKind,
    changed,
    preparedIds,
    explorer,
    onPreview,
    onCreateTaskFromSelection,
    deliverRestitched,
    setCatalogFor,
    setProcessing,
    setCompressing,
    setFolderScope
  });

  // The batch spans folders, so it comes from the accumulated selection map
  // rather than only the rows on the current page.
  const selectedRows = useMemo(() => Array.from(selectedRowsMap.values()), [selectedRowsMap]);
  const focused = page.rows.find(row => row.id === selectedId) ?? null;
  const mainRef = useRef<HTMLDivElement | null>(null);
  const paneShown = usePaneArrival(!query.trash && !searching && focused !== null);
  // The pane narrows the list by a third, and the read-only note above it wraps to a second
  // line: every tile and row is somewhere else in the next frame. They travel there (058) —
  // the list used to dissolve and come back lower, and the eye lost the file it was on.
  const rememberListPlaces = useCallback(() => rememberPlaces(mainRef.current, LIST_MOVERS), []);
  useLayoutEffect(() => {
    moveFromPlaces(mainRef.current);
  }, [paneShown]);

  const runCompressPlan = (plan: CompressPlan) => queue.enqueue(compressJobs(plan));

  const trash = query.trash;
  /*
   * An empty folder is resolved by putting something in it, so the empty state
   * offers the same control the toolbar does rather than describing it. A
   * member who may not upload gets the sentence without a door, which is the
   * permission rule: absent or explained, never present and dead.
   */
  const emptyUploadAction =
    permissions?.upload && !trash ? (
      <Button
        type="button"
        variant="secondary"
        onClick={event => {
          addMenuAnchor.current = event.currentTarget;
          setAddMenuOpen(true);
        }}
      >
        {t('teamExplorerUpload')}
      </Button>
    ) : undefined;

  const onContentKeyDown = useExplorerKeyboard({
    surfaceRef: explorerSurfaceRef,
    sortedRows,
    selectedId,
    select,
    clearSelection,
    focused,
    view,
    explorer,
    onPreview,
    selectedRows,
    permissions,
    trashRows,
    searching,
    trash,
    readOnly,
    onQueryChange,
    clipboard,
    currentFolderId
  });

  return (
    /* `team-panel`, like Accounts and Tasks: this was the one tab in the space
       with no card under it, so the marketing honeycomb showed through every
       gutter — and then a card appeared out of nowhere the moment somebody
       pressed Search, because that view brought its own. One card now, and the
       views inside it no longer carry their own. */
    <div
      ref={explorerSurfaceRef}
      /* A rectangle starts anywhere in the panel's empty space — the gutters around the tiles
         and below them are where people start one, not the few pixels between two tiles. */
      onPointerDown={marquee.onPointerDown}
      /*
       * The selected-file pane belongs to a folder listing. In a search or the
       * trash nothing feeds it, so it stood there saying "Оберіть файл, щоб
       * побачити його тут." and took three hundred and forty pixels of the one
       * column that needed them — the search results were folding their actions
       * under every hit for want of that width.
       */
      /* The detail pane arrives with a selection (024, FR-091). At rest it was a
         third of the width saying "choose a file to see it here", and the list
         cut its own last column to make room for that sentence. */
      className={`team-panel team-explorer${paneShown ? ' has-pane' : ''}${
        treeOpen ? ' is-tree-open' : ''
      }`}
    >
      <FolderTree
        elsewhere={trash || searching}
        onDropMaterials={dropMaterials}
        onReset={onReset}
      />
      <BeforeChange of={paneShown} run={rememberListPlaces} />
      <div ref={explorerHeaderRef} className="team-explorer-header">
        <ExplorerToolbar
          teamId={teamId}
          treeAsDrawer
          treeOpen={treeOpen}
          onToggleTree={() => setTreeOpen(open => !open)}
          trash={trash}
          trashReturnLabel={trashReturnLabel}
          onLeaveTrash={() => onQueryChange({ trash: false })}
          backToTask={query.back}
          searching={searching}
          onOpenSearch={text => onQueryChange({ q: text, scope: 'space' })}
          onCloseSearch={() => onQueryChange({ q: '', scope: 'folder', filters: undefined })}
          canUpload={Boolean(permissions?.upload)}
          onPickFiles={files => void uploadDrop(files.map(file => ({ kind: 'file', file })))}
          onPickFolder={() => void pickFolder()}
          onCreateFolder={() => setCreatingFolder(true)}
          addMenuOpen={addMenuOpen}
          addMenuAnchor={addMenuAnchor}
          onOpenAddMenu={anchor => {
            addMenuAnchor.current = anchor;
            setAddMenuOpen(true);
          }}
          onCloseAddMenu={() => setAddMenuOpen(false)}
          resync={
            canResync &&
            client.getFolderSyncStatus &&
            (currentFolderId ? client.resyncFolder : client.resyncDrive)
              ? {
                  busy: folderResync.running || uploadingThisFolder,
                  inFolder: Boolean(currentFolderId),
                  onStart: () => void folderResync.start()
                }
              : null
          }
          process={
            permissions?.process
              ? {
                  folder: currentFolderId ? explorer.nodeOf(currentFolderId) : null,
                  onFolder: folder => setFolderScope({ folder, intent: 'process' }),
                  onCompressFolder: permissions?.upload
                    ? folder => setFolderScope({ folder, intent: 'compress' })
                    : undefined,
                  onSpace: onProcessLibrary
                }
              : null
          }
          onOpenTrash={() => onQueryChange({ trash: true })}
          view={view}
          onViewChange={setView}
        >
          {!trash && (
            <ExplorerSelection
              selectedRows={selectedRows}
              selectedIds={selectedRowsMap}
              rows={page.rows}
              sortedRows={sortedRows}
              currentFolderId={currentFolderId}
              permissions={permissions}
              onClear={clearSelection}
              onSelectAll={() => explorer.selectRows(sortedRows)}
              onCreateTaskFromSelection={onCreateTaskFromSelection}
              onProcessSelection={onProcessSelection}
              trashRows={trashRows}
              addToTask={addToTask}
              onCompress={setCompressing}
              deliverRestitched={deliverRestitched}
            />
          )}
        </ExplorerToolbar>
        {folderResync.status && (
          <SyncStatusPanel
            status={folderResync.status}
            scopeName={syncScopeName}
            onCancel={canResync ? () => void folderResync.cancel() : undefined}
            onRetry={canResync ? () => void folderResync.start() : undefined}
            onDismiss={folderResync.dismiss}
          />
        )}
      </div>
      <ExplorerDropZone
        zoneRef={mainRef}
        uploading={uploading}
        canUpload={Boolean(permissions?.upload)}
        onDropSources={workspaceOperations ? sources => void uploadDrop(sources) : undefined}
        onDropFiles={files => void upload(files)}
      >
        {/* What is true about this folder right now, said as the inventory says it, over the
            list (070, FR-009): «Лише перегляд» was a paragraph in an empty header row, and the
            retry notice a bare `role="status"` with a Close beside it. */}
        <div ref={explorerListHeaderRef} className="team-explorer-list-header">
          {readOnly && (
            <Alert
              color="warning"
              icon={<Eye size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              title={t('teamExplorerReadOnlyTitle')}
            >
              {t('teamStorageReadOnly')}
            </Alert>
          )}
          {retryGroupId && (
            <Alert
              color="info"
              icon={<RotateCcw size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              title={t('teamExplorerRetryTitle')}
              action={
                <div className="team-explorer-alert-actions">
                  {/* The door the notice asks for: the same choice of files or a folder. */}
                  {permissions?.upload && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-haspopup="menu"
                      aria-expanded={addMenuOpen}
                      onClick={event => {
                        addMenuAnchor.current = event.currentTarget;
                        setAddMenuOpen(true);
                      }}
                    >
                      {t('teamExplorerRetryChoose')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={onRetryComplete}>
                    {t('teamOperationClose')}
                  </Button>
                </div>
              }
            >
              {t('teamWorkspaceReselect')}
            </Alert>
          )}
        </div>
        {/* What arranges the list sits on the list (070, FR-002), as Drive's filter chips do:
            in the toolbar they were two more controls on a row that already wrapped. */}
        {!trash && !searching && (
          <div className="team-explorer-list-controls">
            <KindFilterMenu kinds={query.kinds} onChange={kinds => onQueryChange({ kinds })} />
            {/* Re-sorting is one move, not a reshuffle in a single frame (058). */}
            {/* The grid has no headers, so its order is the menu's; the list's headers sort it,
                and the menu stays there only for an order no column shows (tag, rank). */}
            {(view === 'grid' || sort.key === 'tag' || sort.key === 'rank') && (
              <SortMenu sort={sort} onChange={changeSort} />
            )}
          </div>
        )}
        {trash ? (
          <TrashView key={`trash:${teamId}`} teamId={teamId} />
        ) : searching ? (
          <ExplorerResults
            key={`search:${teamId}`}
            teamId={teamId}
            client={client}
            query={query}
            currentFolderId={currentFolderId}
            onCreateTask={onCreateTask}
            onReveal={revealMaterial}
            onSearched={onSearched}
            onQueryChange={onQueryChange}
            pathFor={pathFor}
            canTag={canTag}
            onPatchRow={page.patchRow}
          />
        ) : (
          <div
            ref={contentRef}
            className="team-explorer-content-keys"
            tabIndex={0}
            role="presentation"
            data-rows={page.rows.length}
            data-selected={selectedId ?? ''}
            onKeyDown={onContentKeyDown}
          >
            {view === 'grid' ? (
              <ContentGrid
                onDropMaterials={dropMaterials}
                client={client}
                page={page}
                onPreview={onPreview}
                actions={actions}
                rows={sortedRows}
                companionRows={folded.children}
                ranks={ranks}
                tagging={tagging}
                emptyAction={emptyUploadAction}
                emptyState={emptyState}
              />
            ) : (
              <ContentList
                onDropMaterials={dropMaterials}
                page={page}
                onPreview={onPreview}
                actions={actions}
                rows={sortedRows}
                companionCounts={folded.counts}
                openedCompanions={openedCompanions}
                onToggleCompanions={toggleCompanions}
                ranks={ranks}
                tagging={tagging}
                emptyAction={emptyUploadAction}
                emptyState={emptyState}
                sort={sort}
                onSortChange={changeSort}
              />
            )}
          </div>
        )}
      </ExplorerDropZone>
      {paneShown && focused && (
        <PreviewPane
          row={focused}
          client={client}
          browseClient={client}
          onChanged={changed}
          revision={revision}
          onOpen={onPreview}
          onDownload={permissions?.download ? row => void downloadOriginal(row) : undefined}
          onDownloadRestitched={
            permissions?.download && focused?.kind === 'video'
              ? row => void deliverRestitched([row])
              : undefined
          }
          onDelete={permissions?.delete ? row => void trashRows([row]) : undefined}
          onTranscribe={
            permissions?.process
              ? (row, options) =>
                  queue.enqueueTranscriptions([
                    {
                      id: row.id,
                      name: row.name,
                      folderId: row.parentFolderId ?? currentFolderId ?? null,
                      ...(options?.fresh ? { fresh: true } : {})
                    }
                  ])
              : undefined
          }
          transcribing={
            queue.active?.tool === 'transcription'
              ? { videoId: queue.active.id, progress: queue.activeProgress }
              : null
          }
          onCreateTask={onCreateTask}
        />
      )}
      {/* One corner, one stack: both panels are reachable from the same
          selection, and pinned to the same pixel the second hid the first. */}
      <ExplorerProcessStack
        stack={space?.stack}
        bulkTrash={workspaceOperations?.bulkTrash}
        rows={page.rows}
        canDelete={Boolean(permissions?.delete)}
        tailClient={tailClient}
        onChanged={changed}
        showQueue={!space}
        queue={queue}
        delivering={deliveringMaterial}
        onCancelDelivery={materialId => restitch.cancel(materialId)}
      />
      <ExplorerDialogs
        teamId={teamId}
        client={client}
        query={query}
        currentFolderId={currentFolderId}
        compressing={compressing}
        onCompressing={setCompressing}
        onRunCompress={runCompressPlan}
        folderScope={folderScope}
        onFolderScope={setFolderScope}
        onProcessSelection={onProcessSelection}
        conflict={conflict}
        creatingFolder={creatingFolder}
        onCreateFolder={createFolder}
        onCloseCreateFolder={closeCreateFolder}
        restitchStates={restitch.states}
        catalogFor={catalogFor}
        onCloseCatalog={() => setCatalogFor(null)}
        onChanged={changed}
        processing={processing}
        onCloseProcessing={() => {
          setProcessing(null);
          changed();
        }}
      />
    </div>
  );
}

const VIEW_KEY = 'soty.team.explorer.view';
/**
 * What in the list a change of its width or of the note above it moves (058): the block of
 * files as a whole, each tile within it, and each cell of a row — a row keeps its place and
 * its columns close up.
 */
const LIST_MOVERS =
  '.team-explorer-content, .team-explorer-tile, .team-explorer-rows :is(.ui-table-cell, .ui-table-header-cell)';

function readRememberedView(): ExplorerView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function rememberView(view: ExplorerView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A browser that refuses storage still gets the address.
  }
}

// Keeps the unused-permissions typing honest for callers that pass a partial set.
export type ExplorerPermissions = TeamPermissions;
