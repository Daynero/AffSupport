import { useRef } from 'react';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useFolderResync } from './useFolderResync';
import type { useOptionalWorkspaceOperations } from './WorkspaceOperationsProvider';
import type { useExplorer } from './ExplorerProvider';
import type { ExplorerShellClient } from './ExplorerShell';
import { useOptionalTeam } from '../TeamContext';
import { spaceOnR2 } from '../storage/spaceSignals';

/** A progress tick refreshes the visible folder at most this often (028). */
const PROGRESS_REFRESH_MIN_MS = 5_000;

/**
 * The open folder's Drive scan (028), out of `ExplorerShell` (070, FR-001): who may ask for
 * one, the scan itself with what it says when it ends, the name of the scope it covers, and
 * whether an upload into this folder is still landing — the two reasons the folder's contents
 * are not yet the whole story.
 */
export function useExplorerResync({
  teamId,
  client,
  currentFolderId,
  pathTo,
  nodeOf,
  readOnly,
  role,
  workspaceOperations,
  notifyStateChanged,
  onComplete,
  onR2: onR2Override
}: {
  teamId: string;
  client: ExplorerShellClient;
  currentFolderId: string | null;
  pathTo: ReturnType<typeof useExplorer>['pathTo'];
  nodeOf: ReturnType<typeof useExplorer>['nodeOf'];
  readOnly: boolean;
  role: string | undefined;
  workspaceOperations: ReturnType<typeof useOptionalWorkspaceOperations>;
  notifyStateChanged: () => void;
  onComplete: () => Promise<void>;
  /** 057 (FR-040): an R2 space has no Drive scan — no button, no panel, no polling. */
  onR2?: boolean;
}) {
  const { t } = useI18n();
  const team = useOptionalTeam();
  const onR2 =
    onR2Override ?? spaceOnR2(teamId, team?.teams.find(space => space.id === teamId) ?? null);
  const { push } = useToasts();
  const lastProgressRefresh = useRef(0);
  const activeFolderIds = currentFolderId
    ? pathTo(currentFolderId).map(node => node.driveFileId)
    : [];
  if (currentFolderId && !activeFolderIds.includes(currentFolderId))
    activeFolderIds.push(currentFolderId);
  /*
   * The request RPCs admit the space's owner and admins only; the button
   * says the same, so nobody sees a control the server will refuse (028).
   */
  const canResync = !onR2 && !readOnly && (role === 'owner' || role === 'admin');
  const folderResync = useFolderResync({
    enabled: !onR2,
    teamId,
    folderId: currentFolderId ?? '__root__',
    // The whole-space scan is an ancestor of every folder: inside a child it
    // shows as running, and no second request is started under it.
    scopeFolderIds: currentFolderId ? ['__root__', ...activeFolderIds] : ['__root__'],
    client: {
      resyncFolder: (id, folder, options) =>
        folder === '__root__'
          ? client.resyncDrive!(id, options)
          : client.resyncFolder!(id, folder, options),
      getFolderSyncStatus: client.getFolderSyncStatus,
      findFolderSyncRequest: client.findFolderSyncRequest,
      findFolderSyncRequestByKey: client.findFolderSyncRequestByKey,
      cancelFolderSync: client.cancelFolderSync
    },
    onComplete,
    /*
     * Files land in the catalog page by page while the scan runs. Realtime
     * normally says so; when it is down, the status the person is already
     * polling says so instead — at most once every five seconds, and only
     * while the person is watching this scan (028, release C).
     */
    onProgress: () => {
      const now = Date.now();
      if (now - lastProgressRefresh.current < PROGRESS_REFRESH_MIN_MS) return;
      lastProgressRefresh.current = now;
      notifyStateChanged();
    },
    onOutcome: outcome =>
      push({
        tone: outcome === 'succeeded' ? 'success' : outcome === 'failed' ? 'error' : 'info',
        text: t(
          outcome === 'succeeded'
            ? 'teamFolderResyncDone'
            : outcome === 'unreachable'
              ? 'teamFolderResyncUnreachable'
              : outcome === 'disconnected'
                ? 'teamFolderResyncDisconnected'
                : outcome === 'stalled'
                  ? 'teamFolderResyncStalled'
                  : outcome === 'blocked'
                    ? 'teamFolderResyncBlocked'
                    : outcome === 'canceled'
                      ? 'teamFolderResyncCanceled'
                      : outcome === 'detached'
                        ? 'teamFolderResyncDetached'
                        : 'teamFolderResyncFailed'
        )
      })
  });
  // The panel names the job's own scope: inside a child of a syncing folder
  // it says the folder, inside any folder of a syncing space it says the space.
  const syncScopeId = folderResync.status?.scopeFolderId ?? currentFolderId ?? '__root__';
  const syncScopeName =
    syncScopeId === '__root__'
      ? t('teamSyncScopeSpace')
      : (nodeOf(syncScopeId)?.name ?? syncScopeId);
  const uploadingThisFolder = Boolean(
    currentFolderId &&
    workspaceOperations?.groups.some(
      group =>
        group.teamId === teamId &&
        (group.state === 'preparing' || group.state === 'running') &&
        (activeFolderIds.includes(group.destination.driveFolderId ?? '') ||
          group.items.some(item => activeFolderIds.includes(item.resultFolderId ?? '')))
    )
  );
  return { canResync, folderResync, syncScopeName, uploadingThisFolder };
}
