import type {
  CatalogMaterialItem,
  TeamAnalyticsStorage,
  TeamPermissions
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { spaceOf, type ActionContext, type MaterialRef } from '../materials/actions';
import { MaterialInlineActions } from '../materials/MaterialInlineActions';
import { useMaterialActionHost } from '../materials/MaterialActionHost';
import { useMaterialActionList } from '../materials/useMaterialActionList';
import type { FolderPickerClient } from './FolderPicker';

/**
 * A search result's actions — the same ones the file has anywhere else (024).
 *
 * A result used to carry five text buttons in a row (preview, edit metadata,
 * file history, show in folder, create task) and then a "…" for everything
 * else, while the same file in a folder offered a different eleven and on a
 * task a different six. The list is the registry's now, so the answer to "what
 * can I do with this?" stopped depending on how the file was found.
 */
export function SearchResultActions({
  material,
  permissions,
  storageKind,
  browseClient,
  destinationFolderId,
  canManageMetadata,
  onChanged,
  onPreview,
  onEditText,
  onProcess,
  onEditMetadata,
  onShowProvenance,
  onCreateTask,
  onReveal
}: {
  material: CatalogMaterialItem;
  permissions: TeamPermissions;
  storageKind: TeamAnalyticsStorage | null;
  browseClient: FolderPickerClient;
  destinationFolderId: string | null;
  canManageMetadata: boolean;
  onChanged: () => void;
  onPreview: (material: CatalogMaterialItem) => void;
  onEditText: (material: CatalogMaterialItem) => void;
  onProcess: (material: CatalogMaterialItem) => void;
  onEditMetadata: (material: CatalogMaterialItem) => void;
  onShowProvenance: (material: CatalogMaterialItem) => void;
  onCreateTask?: (material: CatalogMaterialItem) => void;
  onReveal?: (material: CatalogMaterialItem) => void;
}) {
  const { teams, activeTeam } = useTeam();
  const space = spaceOf(teams, activeTeam, material.teamId);
  const agent = useOptionalAgent();

  const lineage = material.lineage;
  const ref: MaterialRef = {
    id: material.id,
    teamId: material.teamId,
    name: material.name,
    kind: material.kind === 'folder' ? 'folder' : 'file',
    category: material.category,
    parentFolderId: material.parentFolderId ?? null,
    availability: 'ready',
    transcriptReady: material.transcriptIngestState === 'full',
    hasLineage: lineage.hasSource || lineage.hasDerivatives || lineage.isVersion
  };

  const context: ActionContext = {
    host: 'search-result',
    permissions,
    isOwner: space?.role === 'owner',
    currentFolderId: destinationFolderId,
    agentConnected: agent?.teamWorkspaceAvailable === true,
    storageConnected: space?.connectionState === 'connected',
    restitchConfigured: true,
    catalogSettingsReady: true
  };

  const host = useMaterialActionHost({
    teamId: material.teamId,
    material: ref,
    permissions,
    browseClient,
    storageKind,
    destinationFolderId,
    replaceMaterialId: material.id,
    onChanged
  });

  const list = useMaterialActionList(ref, context, {
    ...host.handlers,
    open: () => onPreview(material),
    showInFolder: onReveal ? () => onReveal(material) : undefined,
    provenance: () => onShowProvenance(material),
    editText: material.kind === 'file' ? () => onEditText(material) : undefined,
    process: () => onProcess(material),
    editMetadata: canManageMetadata ? () => onEditMetadata(material) : undefined,
    createTask: onCreateTask ? () => onCreateTask(material) : undefined
  });

  return (
    <div className="team-catalog-material-actions">
      <MaterialInlineActions list={list} name={material.name} />
      {host.dialogs}
    </div>
  );
}
