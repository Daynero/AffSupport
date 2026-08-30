import type {
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import { MaterialRowMenu } from '../catalog/MaterialRowMenu';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import type { MaterialActionsClient } from '../catalog/useMaterialActions';
import { useExplorer } from './ExplorerProvider';
import { teamApi } from '../../api/team';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

/**
 * The per-row actions of the explorer (011, FR-025): the same menu the Files
 * rows already had — download, rename, move, trash, new version, edit text,
 * process — mounted only while open, with the open folder as the destination.
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
  row
}: RowActionsProps & { row: TeamMaterialRow }) {
  const { currentFolderId } = useExplorer();
  const { push } = useToasts();
  const { t } = useI18n();
  const regeneratePreview =
    row.kind === 'landing'
      ? async () => {
          try {
            await teamApi.regenerateLandingPreview(teamId, row.id);
            push({ tone: 'success', text: t('teamLandingRegenerateStarted') });
            onChanged();
          } catch (cause) {
            push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
          }
        }
      : undefined;
  return (
    <MaterialRowMenu
      teamId={teamId}
      material={{
        id: row.id,
        teamId: row.teamId,
        name: row.name,
        kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
        category: row.category,
        fileExtension: row.fileExtension,
        sizeBytes: row.sizeBytes
      }}
      permissions={permissions}
      client={actionsClient}
      browseClient={browseClient}
      onChanged={onChanged}
      storageKind={storageKind}
      destinationFolderId={currentFolderId}
      replaceMaterialId={row.id}
      onEditText={row.kind === 'transcript' && onEditText ? () => onEditText(row) : undefined}
      onProcess={onProcess ? () => onProcess(row) : undefined}
      onProcessFolder={
        row.kind === 'folder' && onProcessFolder ? () => onProcessFolder(row) : undefined
      }
      onRegeneratePreview={regeneratePreview}
      afterTrash={
        row.category === 'video' && onVideoTrashed ? () => onVideoTrashed(row.id) : undefined
      }
    />
  );
}
