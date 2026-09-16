import type {
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import type { MaterialActionsClient } from '../catalog/useMaterialActions';
import { useExplorer } from './ExplorerProvider';
import { teamApi } from '../../api/team';
import { useOptionalAgent } from '../../AgentContext';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { MaterialActionMenu } from '../materials/MaterialActionMenu';
import { useMaterialActionHost } from '../materials/MaterialActionHost';
import { useMaterialActionList } from '../materials/useMaterialActionList';
import type { ActionContext, MaterialRef } from '../materials/actions';

/**
 * The per-row actions of the explorer (011 FR-025, on the shared surface in 024).
 *
 * It used to be its own menu, with its own wording and its own order, and the
 * same file wore a different set of them in the search results and a third on a
 * task. Now the row renders the one registry, so a video offers the same things
 * in the same order wherever it is met — and the rename form and the folder
 * picker live in the host rather than inside a menu that unmounts under them.
 */
export interface RowActionsProps {
  teamId: string;
  permissions: TeamPermissions;
  browseClient: FolderPickerClient;
  actionsClient?: MaterialActionsClient;
  storageKind: TeamAnalyticsStorage | null;
  onChanged: () => void;
  onEditText?: (row: TeamMaterialRow) => void;
  onProcess?: (row: TeamMaterialRow) => void;
  onProcessFolder?: (row: TeamMaterialRow) => void;
  /**
   * A video that was trashed — the shell decides what to do with its transcript
   * companion (012, T012). Kept out of this per-row component because it
   * unmounts the instant the row leaves the list, which would take its own
   * dialog with it.
   */
  onVideoTrashed?: (videoId: string) => void;
  /**
   * 015 — offered on videos only. The shell owns the running delivery, because a delivery
   * outlives the menu that started it and the row that scrolled past.
   */
  onDownloadRestitched?: (row: TeamMaterialRow) => void;
  /**
   * 015 — the videos this space has already looked at, read once for the whole page. A row
   * that is in here downloads re-stitched in seconds; one that is not still works, it just
   * pays for the looking first.
   */
  preparedIds?: ReadonlySet<string>;
  /**
   * 022 — a video's product catalog. Like the transcript prompt, its dialog belongs to the shell:
   * this component unmounts with its menu.
   */
  onProductCatalog?: (row: TeamMaterialRow) => void;
  /** Open the row: a folder is entered, a file is previewed. */
  onOpen?: (row: TeamMaterialRow) => void;
  /** Start a task pointing at this file. */
  onCreateTask?: (row: TeamMaterialRow) => void;
}

export function RowActions({
  teamId,
  permissions,
  browseClient,
  actionsClient,
  storageKind,
  onChanged,
  onEditText,
  onProcess,
  onProcessFolder,
  onVideoTrashed,
  onDownloadRestitched,
  onProductCatalog,
  onOpen,
  onCreateTask,
  row
}: RowActionsProps & { row: TeamMaterialRow }) {
  const { currentFolderId } = useExplorer();
  const { push } = useToasts();
  const { t } = useI18n();
  const { activeTeam } = useTeam();
  const agent = useOptionalAgent();

  const material: MaterialRef = {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
    category: row.category,
    parentFolderId: currentFolderId,
    trashed: false,
    availability: 'ready'
  };

  const context: ActionContext = {
    host: 'explorer-row',
    permissions,
    isOwner: activeTeam?.role === 'owner',
    currentFolderId,
    agentConnected: agent?.teamWorkspaceAvailable === true,
    storageConnected: activeTeam?.connectionState === 'connected',
    restitchConfigured: true,
    catalogSettingsReady: true
  };

  const host = useMaterialActionHost({
    teamId,
    material,
    permissions,
    browseClient,
    actionsClient,
    storageKind,
    destinationFolderId: row.kind === 'folder' ? row.id : currentFolderId,
    replaceMaterialId: row.id,
    onChanged,
    onTrashed: row.category === 'video' && onVideoTrashed ? () => onVideoTrashed(row.id) : undefined
  });

  const list = useMaterialActionList(material, context, {
    ...host.handlers,
    open: onOpen ? () => onOpen(row) : undefined,
    createTask: onCreateTask ? () => onCreateTask(row) : undefined,
    editText: row.kind === 'transcript' && onEditText ? () => onEditText(row) : undefined,
    process: onProcess ? () => onProcess(row) : undefined,
    processInside:
      row.kind === 'folder' && onProcessFolder ? () => onProcessFolder(row) : undefined,
    downloadRestitched:
      row.kind === 'video' && onDownloadRestitched ? () => onDownloadRestitched(row) : undefined,
    productCatalog:
      row.category === 'video' && onProductCatalog ? () => onProductCatalog(row) : undefined,
    regeneratePreview:
      row.kind === 'landing'
        ? () => {
            void teamApi
              .regenerateLandingPreview(teamId, row.id)
              .then(() => {
                push({ tone: 'success', text: t('teamLandingRegenerateStarted') });
                onChanged();
              })
              .catch((cause: unknown) => {
                push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
              });
          }
        : undefined
  });

  return (
    <>
      <MaterialActionMenu list={list} label={t('materialActionsFor', { name: row.name })} />
      {host.dialogs}
    </>
  );
}
