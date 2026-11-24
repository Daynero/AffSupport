import type { TeamMaterialRow, TeamPermissions } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import type { useAgentQueue } from './useAgentQueue';
import type { ExplorerShellClient } from './ExplorerShell';
import { PreviewPane } from './PreviewPane';

/**
 * The open folder's details pane, wired to what outlives a row (070, out of `ExplorerShell` to
 * keep it under its 800 lines): the download, the re-stitched copy, the bin and the queue the
 * transcription runs in.
 */
export function ExplorerFolderPane({
  row,
  client,
  revision,
  permissions,
  currentFolderId,
  queue,
  onChanged,
  onPreview,
  onCreateTask,
  onDownload,
  onDeliverRestitched,
  onTrash
}: {
  row: TeamMaterialRow;
  client: ExplorerShellClient;
  revision: number;
  permissions: TeamPermissions | null;
  currentFolderId: string | null;
  queue: Pick<
    ReturnType<typeof useAgentQueue>,
    'enqueueTranscriptions' | 'active' | 'activeProgress'
  >;
  onChanged: () => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onDownload: (row: TeamMaterialRow) => void;
  onDeliverRestitched: (rows: TeamMaterialRow[]) => void;
  onTrash: (rows: TeamMaterialRow[]) => void;
}) {
  return (
    <PreviewPane
      row={row}
      client={client}
      browseClient={client}
      onChanged={onChanged}
      revision={revision}
      onOpen={onPreview}
      onDownload={permissions?.download ? onDownload : undefined}
      onDownloadRestitched={
        permissions?.download && row.kind === 'video'
          ? current => onDeliverRestitched([current])
          : undefined
      }
      onDelete={permissions?.delete ? current => onTrash([current]) : undefined}
      onTranscribe={
        permissions?.process
          ? (current, options) =>
              queue.enqueueTranscriptions([
                {
                  id: current.id,
                  name: current.name,
                  folderId: current.parentFolderId ?? currentFolderId ?? null,
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
  );
}
