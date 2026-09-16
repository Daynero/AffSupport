import type { TeamMaterialRow } from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { useState } from 'react';
import {
  spaceOf,
  type ActionContext,
  type MaterialCompanions,
  type MaterialRef
} from '../materials/actions';
import { ProductCatalogMenuDialog } from '../product-catalog/ProductCatalogMenuDialog';
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
  onTranscribe,
  browseClient,
  onChanged,
  companions
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
  onTranscribe?: () => void;
  /** Read once by the pane and handed down, so it is not read twice. */
  companions?: MaterialCompanions;
}) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const { teams, activeTeam } = useTeam();
  const space = spaceOf(teams, activeTeam, teamId);
  const agent = useOptionalAgent();

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
    trash: onDelete,
    transcribe: onTranscribe,
    // Deliberately not `copyText`: the pane carries the text surface itself,
    // which can choose between the original and a translation. One press that
    // guesses which one you meant belongs where there is no room to ask.
    // The catalog dialog opens over the explorer and knows how to offer the
    // one that exists as well as how to make a new one, so both readings of
    // "Product catalog" land in the same place.
    productCatalog: () => setCatalogOpen(true)
  });

  return (
    <>
      <MaterialInlineActions list={list} name={row.name} className="team-explorer-pane-icons" />
      {host.dialogs}
      {catalogOpen && (
        <ProductCatalogMenuDialog
          teamId={teamId}
          video={{ id: row.id, name: row.name }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </>
  );
}
