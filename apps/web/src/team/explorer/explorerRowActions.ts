import type {
  TeamAnalyticsStorage,
  TeamMaterialRow,
  TeamPermissions
} from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import type { MaterialActionsClient } from '../catalog/material-actions-client';
import type { ProcessOrigin } from '../processing/processScope';
import type { useExplorer } from './ExplorerProvider';
import type { ExplorerShellClient } from './ExplorerShell';
import type { RowActionsProps } from './RowActions';
import type { useExplorerClipboard } from './useExplorerClipboard';
import { summaryOf } from './summary';

/**
 * What a row's menu can do, for the reader the explorer has (070, FR-001, out of
 * `ExplorerShell`). Nothing for a reader with no permissions at all; otherwise the registry's
 * actions, each present only when the reader may take it.
 */
export function explorerRowActions({
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
  onCompressScope,
  onProcessScope
}: {
  teamId: string;
  permissions: TeamPermissions | null;
  clipboard: ReturnType<typeof useExplorerClipboard>;
  currentFolderId: string | null;
  openFolder: ReturnType<typeof useExplorer>['openFolder'];
  client: ExplorerShellClient;
  actionsClient: MaterialActionsClient;
  storageKind: TeamAnalyticsStorage | null;
  changed: () => void;
  preparedIds: ReadonlySet<string>;
  explorer: ReturnType<typeof useExplorer>;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  deliverRestitched: (rows: TeamMaterialRow[]) => Promise<void>;
  setCatalogFor: (row: TeamMaterialRow | null) => void;
  setProcessing: (processing: { row: TeamMaterialRow } | null) => void;
  /** The one compression dialog, opened on a file (070, T062). */
  onCompressScope: (origin: ProcessOrigin) => void;
  /** The one processing dialog, opened on a folder (070, T062). */
  onProcessScope?: (origin: ProcessOrigin) => void;
}): RowActionsProps | undefined {
  return permissions
    ? {
        teamId,
        clipboard: {
          take: (mode, row) =>
            clipboard.take(mode, [
              {
                id: row.id,
                name: row.name,
                kind: row.kind,
                category: row.category,
                sourceFolderId: row.parentFolderId ?? currentFolderId ?? null
              }
            ]),
          // Offered only when there is something to paste: an action the
          // registry cannot perform is an action the registry drops.
          pasteInto: clipboard.has()
            ? row => {
                openFolder(row.driveFileId);
                void clipboard.paste(row.driveFileId);
              }
            : undefined
        },
        permissions,
        browseClient: client,
        actionsClient,
        storageKind,
        onChanged: changed,
        preparedIds,
        onProductCatalog: (row: TeamMaterialRow) => setCatalogFor(row),
        onOpen: (row: TeamMaterialRow) => {
          if (row.kind === 'folder') explorer.openFolder(row.driveFileId);
          else onPreview?.(summaryOf(row));
        },
        ...(onCreateTaskFromSelection
          ? {
              onCreateTask: (row: TeamMaterialRow) =>
                onCreateTaskFromSelection([{ id: row.id, name: row.name }])
            }
          : {}),
        ...(permissions.download
          ? {
              onDownloadRestitched: (row: TeamMaterialRow) => void deliverRestitched([row])
            }
          : {}),
        ...(permissions.process
          ? {
              onProcess: (row: TeamMaterialRow) => setProcessing({ row }),
              onCompress: (row: TeamMaterialRow) =>
                onCompressScope({
                  intent: 'compress',
                  initial: 'selection',
                  selection: [
                    {
                      id: row.id,
                      name: row.name,
                      category: row.category,
                      parentFolderId: row.parentFolderId ?? currentFolderId ?? null
                    }
                  ],
                  folder: currentFolderId ? explorer.nodeOf(currentFolderId) : null
                }),
              onProcessFolder: (row: TeamMaterialRow) =>
                onProcessScope?.({ intent: 'process', initial: 'folder', folder: row, space: true })
            }
          : {})
      }
    : undefined;
}
