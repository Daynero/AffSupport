import type { TeamPermissions } from '@video-compressor/shared';
import type { CatalogRegistryRow } from '../../api/team';
import { teamApi } from '../../api/team';
import { useOptionalAgent } from '../../AgentContext';
import { useTeam } from '../TeamContext';
import { spaceOf, type ActionContext, type MaterialRef } from '../materials/actions';
import { MaterialInlineActions } from '../materials/MaterialInlineActions';
import { useMaterialActionHost } from '../materials/MaterialActionHost';
import { useMaterialActionList } from '../materials/useMaterialActionList';

/**
 * A catalog in the updater's list is a file like any other (024).
 *
 * The row carried exactly two affordances — an anchor to the sheet and a copy
 * button — hand-written here, so the catalog you are looking at in the updater
 * could not be renamed, moved, put on a task or found in its folder, while the
 * same sheet one screen away could be. `catalog_material_id` says what it
 * always was: a material. It gets the material's vocabulary.
 *
 * Two things differ from a row in the explorer, and both are about being
 * inside a dialog that owns the address:
 *
 * - **Open** goes to the Google sheet in a new tab, not to a preview. That is
 *   what somebody in the updater means by opening a catalog, and it is what
 *   the anchor did before.
 * - **Details** does not apply: `showInFolder` would already answer "where
 *   does this live", and offering two ways out of a full-screen dialog is the
 *   chaos this feature exists to remove.
 *
 * `showInFolder` closes the updater and opens the sheet's folder with the sheet selected (024).
 */
export function UpdaterRowActions({
  row,
  teamId,
  permissions,
  onChanged,
  onReveal
}: {
  row: CatalogRegistryRow;
  teamId: string;
  permissions: TeamPermissions;
  onChanged: () => void;
  /** Close the dialog and show the sheet where it lives. */
  onReveal?: (row: CatalogRegistryRow) => void;
}) {
  const { teams, activeTeam } = useTeam();
  const space = spaceOf(teams, activeTeam, teamId);
  const agent = useOptionalAgent();

  const ref: MaterialRef = {
    id: row.catalogId,
    teamId,
    name: row.name,
    kind: 'file',
    category: 'other',
    availability: 'ready'
  };

  const context: ActionContext = {
    host: 'updater-row',
    permissions,
    isOwner: space?.role === 'owner',
    agentConnected: agent?.teamWorkspaceAvailable === true,
    storageConnected: space?.connectionState === 'connected',
    restitchConfigured: true,
    catalogSettingsReady: true
  };

  const host = useMaterialActionHost({
    teamId,
    material: ref,
    permissions,
    browseClient: teamApi,
    replaceMaterialId: row.catalogId,
    onChanged
  });

  const list = useMaterialActionList(
    ref,
    context,
    {
      ...host.handlers,
      open: () => window.open(row.sheetUrl, '_blank', 'noopener,noreferrer'),
      showInFolder: onReveal ? () => onReveal(row) : undefined
      // One inline — open the sheet — and the rest named in "…" (024, T131):
      // four unlabelled icons on every row of a list of catalogs was a toolbar
      // repeated forty times.
    },
    { maxInline: 1 }
  );

  return (
    <div className="team-updater-row-actions">
      <MaterialInlineActions list={list} name={row.name} />
      {host.dialogs}
    </div>
  );
}
