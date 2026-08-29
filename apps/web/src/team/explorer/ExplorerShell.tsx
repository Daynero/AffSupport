import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  CatalogMaterialItem,
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { TeamCatalog, type TeamCatalogClient } from '../catalog/TeamCatalog';
import { TrashView } from '../catalog/TrashView';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import {
  defaultMaterialActionsClient,
  uploadTeamFile,
  type MaterialActionsClient
} from '../catalog/material-actions-client';
import type { TeamRouteQuery, ExplorerView } from '../routes';
import { Breadcrumb } from './Breadcrumb';
import { ContentGrid, type ContentGridClient } from './ContentGrid';
import { ContentList } from './ContentList';
import { ExplorerProvider, useExplorer, type ExplorerClient } from './ExplorerProvider';
import { FolderTree } from './FolderTree';
import { KindFilterBar } from './KindFilterBar';
import { PreviewPane } from './PreviewPane';
import { MaterialProcessFlow } from '../processing/MaterialProcessFlow';
import type { RowActionsProps } from './RowActions';
import { useFolderPage } from './useFolderPage';

export type ExplorerShellClient = ExplorerClient &
  ContentGridClient &
  TeamCatalogClient &
  FolderPickerClient & {
    getConnectionStatus?: (teamId: string) => Promise<{ driveKind?: TeamAnalyticsStorage | null }>;
  };

export type { ExplorerView };

/**
 * The explorer (011, US3): one screen for everything the old Files, Landings
 * and Creatives tabs did. Tree on the left, the open folder (or a search, or
 * the trash) in the middle, the selected row on the right. Every piece of view
 * state lives in the address, so a refresh and a pasted link land on the same
 * screen.
 */
export function ExplorerShell({
  teamId,
  client,
  revision = 0,
  query,
  onQueryChange,
  onFolderChange,
  onSearched,
  onPreview,
  onCreateTask,
  onCreateTaskFromSelection,
  onProcessSelection,
  onChanged,
  actionsClient = defaultMaterialActionsClient,
  readOnly = false
}: {
  teamId: string;
  client: ExplorerShellClient;
  revision?: number;
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onFolderChange: (folderId: string | null) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: () => void;
  onChanged?: () => void;
  actionsClient?: MaterialActionsClient;
  /** Storage needs a person (011, FR-033): browse and preview only. */
  readOnly?: boolean;
}) {
  return (
    <ExplorerProvider
      teamId={teamId}
      client={client}
      revision={revision}
      folderId={query.folderId}
      onFolderChange={onFolderChange}
    >
      <ExplorerBody
        teamId={teamId}
        client={client}
        revision={revision}
        query={query}
        onQueryChange={onQueryChange}
        onSearched={onSearched}
        onPreview={onPreview}
        onCreateTask={onCreateTask}
        onCreateTaskFromSelection={onCreateTaskFromSelection}
        onProcessSelection={onProcessSelection}
        onChanged={onChanged}
        actionsClient={actionsClient}
        readOnly={readOnly}
      />
    </ExplorerProvider>
  );
}

function ExplorerBody({
  teamId,
  client,
  revision,
  query,
  onQueryChange,
  onSearched,
  onPreview,
  onCreateTask,
  onCreateTaskFromSelection,
  onProcessSelection,
  onChanged,
  actionsClient,
  readOnly
}: {
  teamId: string;
  client: ExplorerShellClient;
  revision: number;
  query: TeamRouteQuery;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: () => void;
  onChanged?: () => void;
  actionsClient: MaterialActionsClient;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { permissions: loadedPermissions } = useTeam();
  // Every write goes dark while storage needs a person (FR-033); nothing is lost.
  const permissions = readOnly ? null : loadedPermissions;
  const explorer = useExplorer();
  const { currentFolderId, selectedId, select, selectedIds, clearSelection, pathTo, nodeOf } =
    explorer;
  const [treeOpen, setTreeOpen] = useState(false);
  const [processing, setProcessing] = useState<TeamMaterialRow | null>(null);
  const [dropping, setDropping] = useState(false);
  const [storageKind, setStorageKind] = useState<TeamAnalyticsStorage | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const view: ExplorerView = query.view ?? readRememberedView();
  const searching = query.q.length > 0 || query.scope === 'space';
  const page = useFolderPage({
    teamId,
    client,
    parentFolderId: currentFolderId,
    kinds: query.kinds,
    revision
  });

  useEffect(() => {
    let active = true;
    if (!client.getConnectionStatus) return;
    void client
      .getConnectionStatus(teamId)
      .then(status => {
        if (active) setStorageKind(status.driveKind ?? null);
      })
      .catch(() => {
        if (active) setStorageKind(null);
      });
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const changed = useCallback(() => {
    onChanged?.();
    void page.reload();
  }, [onChanged, page]);

  const setView = (next: ExplorerView) => {
    rememberView(next);
    onQueryChange({ view: next });
  };

  /** Root-relative path for a search result, from the cached tree. */
  const pathFor = useCallback(
    (item: CatalogMaterialItem) => {
      const parent = item.parentFolderId ?? null;
      if (!parent || !nodeOf(parent)) return t('teamExplorerRootLabel');
      return [t('teamExplorerRootLabel'), ...pathTo(parent).map(node => node.name)].join(' / ');
    },
    [nodeOf, pathTo, t]
  );

  /** A drag onto a folder in the tree: move, and offer the way back (FR-026). */
  const moveTo = useCallback(
    async (folderDriveId: string, materialIds: string[]) => {
      if (!permissions?.edit) return;
      const previous = currentFolderId ?? null;
      for (const materialId of materialIds) {
        try {
          await actionsClient.moveMaterial({
            teamId,
            materialId,
            destinationFolderId: folderDriveId,
            conflictMode: 'keep_both',
            idempotencyKey: crypto.randomUUID()
          });
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          changed();
          return;
        }
      }
      changed();
      clearSelection();
      const target = nodeOf(folderDriveId)?.name ?? t('teamExplorerRootLabel');
      push({
        tone: 'success',
        text: `${t('teamToastMoved')} → ${target}`,
        ...(previous !== null
          ? {
              action: {
                label: t('teamExplorerMovedUndo'),
                run: () => void moveTo(previous, materialIds)
              }
            }
          : {})
      });
    },
    [
      actionsClient,
      changed,
      clearSelection,
      currentFolderId,
      nodeOf,
      permissions?.edit,
      push,
      t,
      teamId
    ]
  );

  /** Files dropped on the content area, or picked from the "Add files" input. */
  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0 || !permissions?.upload) return;
      // No folder open means the space root, which the server resolves from the
      // connection. Inferring it from the first top-level folder refused every
      // upload into an empty space — with a message about Drive being
      // unavailable, which it was not.
      const destination = currentFolderId;
      let done = 0;
      for (const file of list) {
        try {
          await uploadTeamFile({
            teamId,
            destinationFolderId: destination,
            file,
            conflictMode: 'keep_both',
            replaceMaterialId: null,
            versionOfMaterialId: null
          });
          done += 1;
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        }
      }
      if (done > 0) push({ tone: 'success', text: t('teamExplorerUploadDone', { count: done }) });
      changed();
    },
    [changed, currentFolderId, explorer, permissions?.upload, push, t, teamId]
  );

  const actions: RowActionsProps | undefined = permissions
    ? {
        teamId,
        permissions,
        browseClient: client,
        actionsClient,
        storageKind,
        onChanged: changed,
        ...(permissions.process ? { onProcess: (row: TeamMaterialRow) => setProcessing(row) } : {})
      }
    : undefined;

  const selectedRows = useMemo(
    () => page.rows.filter(row => selectedIds.has(row.id)),
    [page.rows, selectedIds]
  );
  const focused = page.rows.find(row => row.id === selectedId) ?? null;

  /** Rows going to the trash from the keyboard or the selection bar, with the way back. */
  const trashRows = useCallback(
    async (rows: TeamMaterialRow[]) => {
      if (!permissions?.delete) return;
      const trashed: string[] = [];
      for (const row of rows) {
        if (row.kind === 'folder') continue;
        try {
          await actionsClient.trashMaterial({
            teamId,
            materialId: row.id,
            idempotencyKey: crypto.randomUUID()
          });
          trashed.push(row.id);
        } catch (cause) {
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          break;
        }
      }
      if (trashed.length === 0) return;
      select(null);
      clearSelection();
      changed();
      const restore = async () => {
        for (const materialId of trashed) {
          try {
            await actionsClient.restoreMaterial({
              teamId,
              materialId,
              idempotencyKey: crypto.randomUUID()
            });
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
            break;
          }
        }
        changed();
        push({ tone: 'success', text: t('teamToastRestored') });
      };
      push({
        tone: 'success',
        text:
          trashed.length === 1
            ? t('teamToastTrashed')
            : t('teamExplorerTrashedCount', { count: trashed.length }),
        action: { label: t('teamUndo'), run: () => void restore() }
      });
    },
    [actionsClient, changed, clearSelection, permissions?.delete, push, select, t, teamId]
  );

  /**
   * Keyboard on the content area (FR-027): arrows move, Enter opens, Escape
   * clears, Delete trashes with undo. Keys typed into a field — the rename
   * form inside a row menu, most of all — are that field's; letting them
   * through here opened a preview on Enter and toggled the selection on every
   * space in the new name.
   */
  const onContentKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (page.rows.length === 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditableTarget(target) || target?.closest('.team-row-menu')) return;
    const index = page.rows.findIndex(row => row.id === selectedId);
    const step = view === 'grid' ? gridColumns(event.currentTarget) : 1;
    let next: TeamMaterialRow | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = page.rows[Math.min(page.rows.length - 1, index < 0 ? 0 : index + step)];
        break;
      case 'ArrowUp':
        next = page.rows[Math.max(0, index - step)];
        break;
      case 'ArrowRight':
        if (view !== 'grid') return;
        next = page.rows[Math.min(page.rows.length - 1, index + 1)];
        break;
      case 'ArrowLeft':
        if (view !== 'grid') return;
        next = page.rows[Math.max(0, index - 1)];
        break;
      case 'Enter':
        if (!focused) return;
        if (focused.kind === 'folder') explorer.openFolder(focused.driveFileId);
        else onPreview?.(summaryOf(focused));
        break;
      case 'Escape':
        select(null);
        clearSelection();
        break;
      case ' ':
        if (focused) explorer.toggleSelected(focused.id);
        break;
      case 'Delete':
      case 'Backspace': {
        const rows = selectedRows.length > 0 ? selectedRows : focused ? [focused] : [];
        if (rows.length === 0 || !permissions?.delete) return;
        void trashRows(rows);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next) select(next.id);
  };

  const trash = query.trash;

  // `/` opens the search from anywhere on the folder screen (FR-027). The
  // search bar binds the same key once it is mounted; before that there was
  // nothing listening, so the shortcut only worked when it was not needed.
  useEffect(() => {
    if (searching || trash) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      event.preventDefault();
      onQueryChange({ scope: 'space' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onQueryChange, searching, trash]);

  return (
    <div className={`team-explorer has-pane${treeOpen ? ' is-tree-open' : ''}`}>
      <FolderTree onDropMaterials={(folder, ids) => void moveTo(folder, ids)} />
      <div
        className={`team-explorer-main team-explorer-dropzone${dropping ? ' is-over' : ''}`}
        onDragOver={event => {
          if (!permissions?.upload || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDropping(false);
          void upload(event.dataTransfer.files);
        }}
      >
        {readOnly && (
          <p className="team-explorer-readonly" role="status">
            {t('teamStorageReadOnly')}
          </p>
        )}
        <div className="team-explorer-toolbar">
          <Button
            type="button"
            variant="ghost"
            className="team-explorer-folders-toggle"
            aria-pressed={treeOpen}
            onClick={() => setTreeOpen(open => !open)}
          >
            {t('teamExplorerFoldersToggle')}
          </Button>
          {trash ? (
            <Button type="button" variant="ghost" onClick={() => onQueryChange({ trash: false })}>
              ← {t('teamExplorerBackToFiles')}
            </Button>
          ) : (
            <Breadcrumb />
          )}
          <div className="team-explorer-toolbar-actions">
            {!trash && (
              <Button
                type="button"
                variant="secondary"
                aria-pressed={searching}
                onClick={() =>
                  searching
                    ? onQueryChange({ q: '', scope: 'folder', filters: undefined })
                    : onQueryChange({ scope: 'space' })
                }
              >
                {searching ? t('teamExplorerSearchClose') : t('teamExplorerSearchOpen')}
              </Button>
            )}
            {permissions?.upload && !trash && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={event => {
                    if (event.target.files) void upload(event.target.files);
                    event.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileInput.current?.click()}
                >
                  {t('teamExplorerAddFiles')}
                </Button>
              </>
            )}
            {!trash && (
              <div
                className="team-explorer-view-toggle"
                role="group"
                aria-label={t('teamExplorerViewLabel')}
              >
                <button
                  type="button"
                  aria-pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                >
                  {t('teamExplorerViewGrid')}
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  {t('teamExplorerViewList')}
                </button>
              </div>
            )}
          </div>
        </div>
        {!trash && !searching && (
          <KindFilterBar kinds={query.kinds} onChange={kinds => onQueryChange({ kinds })} />
        )}
        {selectedRows.length > 0 && !trash && (
          <div
            className="team-explorer-selection-bar"
            role="region"
            aria-label={t('teamExplorerSelectedCount', { count: selectedRows.length })}
          >
            <span>{t('teamExplorerSelectedCount', { count: selectedRows.length })}</span>
            {onCreateTaskFromSelection && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  onCreateTaskFromSelection(
                    selectedRows.map(row => ({ id: row.id, name: row.name }))
                  )
                }
              >
                {t('teamExplorerCreateTaskFromSelection')}
              </Button>
            )}
            {onProcessSelection && permissions?.process && (
              <Button type="button" variant="secondary" onClick={onProcessSelection}>
                {t('teamExplorerProcessSelection')}
              </Button>
            )}
            {permissions?.delete && (
              <Button type="button" variant="danger" onClick={() => void trashRows(selectedRows)}>
                {t('teamFileTrash')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={clearSelection}>
              {t('teamExplorerClearSelection')}
            </Button>
          </div>
        )}
        {trash ? (
          <TrashView key={`trash:${teamId}`} teamId={teamId} />
        ) : searching ? (
          <TeamCatalog
            key={`search:${teamId}`}
            teamId={teamId}
            client={client}
            onCreateTask={onCreateTask}
            initialQuery={query.q}
            initialFilters={query.filters}
            onSearched={onSearched}
            autoFocusSearch
            scopeFolderId={currentFolderId}
            scope={query.scope}
            onScopeChange={scope => onQueryChange({ scope })}
            kinds={query.kinds}
            pathFor={pathFor}
          />
        ) : (
          <div
            className="team-explorer-content-keys"
            tabIndex={0}
            role="presentation"
            data-rows={page.rows.length}
            data-selected={selectedId ?? ''}
            onKeyDown={onContentKeyDown}
          >
            {view === 'grid' ? (
              <ContentGrid
                client={client}
                revision={revision}
                kinds={query.kinds}
                onPreview={onPreview}
                actions={actions}
              />
            ) : (
              <ContentList
                client={client}
                revision={revision}
                kinds={query.kinds}
                onPreview={onPreview}
                actions={actions}
              />
            )}
          </div>
        )}
        {dropping && <p className="team-explorer-muted">{t('teamExplorerDropHint')}</p>}
      </div>
      <PreviewPane row={trash || searching ? null : focused} client={client} onOpen={onPreview} />
      {processing && (
        <MaterialProcessFlow
          teamId={teamId}
          material={{ id: processing.id, name: processing.name, category: processing.category }}
          destinationFolderId={processing.parentFolderId ?? currentFolderId ?? null}
          browseClient={client}
          onClose={() => {
            setProcessing(null);
            changed();
          }}
        />
      )}
    </div>
  );
}

const VIEW_KEY = 'soty.team.explorer.view';

/** Someone typing owns their keys; the explorer's shortcuts never apply there. */
function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

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

function gridColumns(element: HTMLElement): number {
  const grid = element.querySelector<HTMLElement>('.team-explorer-grid');
  if (!grid) return 1;
  const tiles = grid.querySelectorAll<HTMLElement>('.team-explorer-tile');
  if (tiles.length < 2) return 1;
  const firstTop = tiles[0]!.offsetTop;
  let columns = 1;
  for (let index = 1; index < tiles.length; index += 1) {
    if (tiles[index]!.offsetTop !== firstTop) break;
    columns += 1;
  }
  return Math.max(1, columns);
}

function summaryOf(row: TeamMaterialRow): TeamMaterialSummary {
  return {
    id: row.id,
    teamId: row.teamId,
    providerId: row.driveFileId,
    parentFolderId: row.parentFolderId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
    category: row.category,
    mimeType: row.mimeType,
    fileExtension: row.fileExtension,
    sizeBytes: row.sizeBytes,
    modifiedAt: row.modifiedAt,
    previewState: row.previewState
  };
}

// Keeps the unused-permissions typing honest for callers that pass a partial set.
export type ExplorerPermissions = TeamPermissions;
