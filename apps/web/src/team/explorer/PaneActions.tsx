import type { TeamMaterialRow } from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { spaceOf, type ActionContext, type MaterialRef } from '../materials/actions';
import { useMaterialCompanions } from '../materials/useMaterialCompanions';
import { MaterialInlineActions } from '../materials/MaterialInlineActions';
import { useMaterialActionHost } from '../materials/MaterialActionHost';
import { useMaterialActionList } from '../materials/useMaterialActionList';
import type { FolderPickerClient } from '../catalog/FolderPicker';

/**
 * The detail pane's actions, from the one registry (024).
 *
 * The pane carried three hand-drawn icon buttons and two worded ones beneath
 * them, all of which the row above it also offered under different names: the
 * download was "the original" here and "Download" there, the bin was an icon in
 * one place and "Move to trash" in the other.
 *
 * The pane is inside the explorer, so it does not offer "show in folder" — it
 * is the folder — and the shell keeps the operations that outlive a row, which
 * is why they arrive as callbacks rather than from the host.
 */
export function PaneActions({
  row,
  teamId,
  onOpen,
  onCreateTask,
  onDownload,
  onDownloadRestitched,
  onDelete,
  browseClient,
  onChanged
}: {
  row: TeamMaterialRow;
  teamId: string;
  /** Reads the folder tree for the move picker the host owns. */
  browseClient: FolderPickerClient;
  onChanged: () => void;
  /* Bound by the caller: the pane already knows how to turn its row into the
     shape the viewer wants, and that conversion belongs where it is written. */
  onOpen?: () => void;
  onCreateTask?: () => void;
  onDownload?: () => void;
  onDownloadRestitched?: () => void;
  onDelete?: () => void;
}) {
  const { teams, activeTeam } = useTeam();
  const space = spaceOf(teams, activeTeam, teamId);
  const agent = useOptionalAgent();

  // One file is in focus here, so what lives beside it is worth two requests:
  // a video whose transcript is ready offers its text, and one that already has
  // a catalog offers to open it instead of making a second.
  const companions = useMaterialCompanions({
    id: row.id,
    teamId: row.teamId,
    kind: row.kind === 'folder' ? 'folder' : 'file',
    category: row.category
  });

  const material: MaterialRef = {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    kind: row.kind === 'folder' ? 'folder' : 'file',
    category: row.category,
    sizeBytes: row.sizeBytes,
    fileExtension: row.fileExtension,
    availability: 'ready',
    companions
  };

  const context: ActionContext = {
    host: 'explorer-detail',
    permissions: space?.permissions ?? null,
    isOwner: space?.role === 'owner',
    agentConnected: agent?.teamWorkspaceAvailable === true,
    storageConnected: space?.connectionState === 'connected',
    restitchConfigured: true,
    catalogSettingsReady: true
  };

  const host = useMaterialActionHost({
    teamId,
    material,
    permissions: context.permissions ?? ({} as never),
    browseClient,
    onChanged
  });

  const list = useMaterialActionList(material, context, {
    ...host.handlers,
    open: onOpen,
    download: onDownload,
    downloadRestitched: onDownloadRestitched,
    createTask: onCreateTask,
    trash: onDelete
  });

  return (
    <>
      <MaterialInlineActions list={list} name={row.name} className="team-explorer-pane-icons" />
      {host.dialogs}
    </>
  );
}
