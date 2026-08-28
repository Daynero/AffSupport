import type {
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import { MaterialRowMenu } from '../catalog/MaterialRowMenu';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import type { MaterialActionsClient } from '../catalog/useMaterialActions';
import { useExplorer } from './ExplorerProvider';

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
  row
}: RowActionsProps & { row: TeamMaterialRow }) {
  const { currentFolderId } = useExplorer();
  return (
    <MaterialRowMenu
      teamId={teamId}
      material={{
        id: row.id,
        teamId: row.teamId,
        name: row.name,
        kind: row.kind === 'folder' ? 'folder' : row.kind === 'shortcut' ? 'shortcut' : 'file',
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
    />
  );
}
