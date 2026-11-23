import type { CatalogMaterialItem } from '@video-compressor/shared';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { TeamCatalog } from '../catalog/TeamCatalog';
import type { TeamRouteQuery } from '../routes';
import type { ExplorerShellClient } from './ExplorerShell';
import type { useFolderPage } from './useFolderPage';

/**
 * A search of the space, in the list's place (070, FR-001, out of `ExplorerShell`). Today it
 * is the catalogue's own search with its own field; US3 (T021) puts the field in the toolbar
 * and leaves this the results alone.
 */
export function ExplorerResults({
  teamId,
  client,
  query,
  currentFolderId,
  onCreateTask,
  onReveal,
  onSearched,
  onQueryChange,
  pathFor,
  canTag,
  onPatchRow
}: {
  teamId: string;
  client: ExplorerShellClient;
  query: TeamRouteQuery;
  currentFolderId: string | null;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onReveal: (item: { id: string; parentFolderId?: string | null }) => void;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  pathFor: (item: CatalogMaterialItem) => string;
  canTag: boolean;
  /** A tag painted on a result is painted on the folder's row too, if it is loaded. */
  onPatchRow: ReturnType<typeof useFolderPage>['patchRow'];
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  return (
    <TeamCatalog
      teamId={teamId}
      client={client}
      onCreateTask={onCreateTask}
      onReveal={onReveal}
      initialQuery={query.q}
      initialFilters={query.filters}
      onSearched={onSearched}
      autoFocusSearch
      scopeFolderId={currentFolderId}
      scope={query.scope}
      kinds={query.kinds}
      onScopeChange={next =>
        onQueryChange({ scope: next.scope, ...(next.kinds ? { kinds: next.kinds } : {}) })
      }
      onClose={() => onQueryChange({ q: '', scope: 'folder', filters: undefined })}
      pathFor={pathFor}
      tagging={
        canTag && client.setMaterialTag
          ? {
              canTag: true,
              onSetTag: (material, color) => {
                onPatchRow(material.id, { tagColor: color });
                void client
                  .setMaterialTag?.({
                    teamId,
                    materialId: material.id,
                    color
                  })
                  .catch(cause => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }));
              }
            }
          : undefined
      }
    />
  );
}
