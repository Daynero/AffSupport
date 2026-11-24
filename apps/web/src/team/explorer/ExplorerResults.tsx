import { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { CatalogMaterialItem, TeamMaterialTagColor } from '@video-compressor/shared';
import { useToasts } from '../../components/toast';
import { SegmentedControl } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { SearchResultActions } from '../catalog/SearchResultActions';
import { TeamCatalog, type EmbeddedCatalogView } from '../catalog/TeamCatalog';
import type { TeamRouteQuery } from '../routes';
import type { ExplorerShellClient } from './ExplorerShell';
import { ExplorerSelection, type SelectionActs } from './ExplorerSelection';
import { ResultList } from './ResultList';
import { ResultPane } from './ResultPane';
import { useResultSelection } from './useResultSelection';
import { useThumbnailSession } from './useThumbnailSession';
import type { ExplorerSearch } from './useExplorerSearch';
import type { useFolderPage } from './useFolderPage';

/** Where the results put what they draw outside the list: the strip above it, the pane. */
export interface ExplorerResultHosts {
  strip: HTMLElement | null;
  pane: HTMLElement | null;
}

/**
 * A search of the space, in the list's place (070, US3).
 *
 * With `explorerInlineSearch` the field is the toolbar's and this is the results alone: the
 * folder's list, its selection and its selection bar, and the details pane beside it. With the
 * flag off it is the catalogue's search screen with its own field, as before.
 */
export function ExplorerResults({
  teamId,
  client,
  query,
  currentFolderId,
  search,
  hosts,
  onPaneShown,
  acts,
  revision,
  onCreateTask,
  onReveal,
  onOpenFolder,
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
  search: ExplorerSearch;
  hosts: ExplorerResultHosts;
  /** Whether the details pane is up, so the explorer makes room for it. */
  onPaneShown: (shown: boolean) => void;
  acts: SelectionActs<CatalogMaterialItem>;
  revision: number;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  onReveal: (item: { id: string; parentFolderId?: string | null }) => void;
  /** A folder found by the search is gone into; false when the tree does not know it. */
  onOpenFolder: (material: CatalogMaterialItem) => boolean;
  onSearched: (state: { query: string; filters: TeamRouteQuery['filters'] }) => void;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
  pathFor: (item: CatalogMaterialItem) => string;
  canTag: boolean;
  /** A tag painted on a result is painted on the folder's row too, if it is loaded. */
  onPatchRow: ReturnType<typeof useFolderPage>['patchRow'];
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const tagging =
    canTag && client.setMaterialTag
      ? {
          canTag: true as const,
          onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => {
            onPatchRow(material.id, { tagColor: color });
            void client
              .setMaterialTag?.({ teamId, materialId: material.id, color })
              .catch(cause => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }));
          }
        }
      : undefined;
  const reveal = (material: CatalogMaterialItem) => {
    search.rememberSearch();
    onReveal(material);
  };
  const shared = {
    teamId,
    client,
    onReveal: reveal,
    initialQuery: query.q,
    initialFilters: query.filters,
    scopeFolderId: currentFolderId,
    scope: query.scope,
    kinds: query.kinds,
    onScopeChange: (next: { scope: 'subtree' | 'space'; kinds?: TeamRouteQuery['kinds'] }) =>
      onQueryChange({ scope: next.scope, ...(next.kinds ? { kinds: next.kinds } : {}) }),
    pathFor,
    tagging,
    onCreateTask
  };

  if (!search.inline) {
    return (
      <TeamCatalog
        {...shared}
        onSearched={onSearched}
        autoFocusSearch
        onClose={() => onQueryChange({ q: '', scope: 'folder', filters: undefined })}
      />
    );
  }
  return (
    <TeamCatalog
      {...shared}
      onSearched={search.reportSearched}
      embedded={{
        query: search.draft,
        onQueryChange: search.setDraft,
        renderResults: view => (
          <InlineResults
            view={view}
            client={client}
            teamId={teamId}
            query={query}
            currentFolderId={currentFolderId}
            hosts={hosts}
            onPaneShown={onPaneShown}
            acts={acts}
            revision={revision}
            onScopeChange={shared.onScopeChange}
            onReveal={reveal}
            onOpenFolder={material => {
              search.rememberSearch();
              if (!onOpenFolder(material)) onReveal(material);
            }}
            onCreateTask={onCreateTask}
            pathFor={pathFor}
            tagging={tagging}
          />
        )
      }}
    />
  );
}

function InlineResults({
  view,
  client,
  teamId,
  query,
  currentFolderId,
  hosts,
  onPaneShown,
  acts,
  revision,
  onScopeChange,
  onReveal,
  onOpenFolder,
  onCreateTask,
  pathFor,
  tagging
}: {
  view: EmbeddedCatalogView;
  client: ExplorerShellClient;
  teamId: string;
  query: TeamRouteQuery;
  currentFolderId: string | null;
  hosts: ExplorerResultHosts;
  onPaneShown: (shown: boolean) => void;
  acts: SelectionActs<CatalogMaterialItem>;
  revision: number;
  onScopeChange: (next: { scope: 'subtree' | 'space' }) => void;
  onReveal: (material: CatalogMaterialItem) => void;
  onOpenFolder: (material: CatalogMaterialItem) => void;
  onCreateTask?: (asset: { id: string; name: string }) => void;
  pathFor: (item: CatalogMaterialItem) => string;
  tagging?: {
    canTag: true;
    onSetTag: (material: CatalogMaterialItem, color: TeamMaterialTagColor | null) => void;
  };
}) {
  const { t } = useI18n();
  const { permissions } = useTeam();
  const items = useMemo(() => view.result?.items ?? [], [view.result]);
  const selection = useResultSelection(items);
  const shownIds = useMemo(() => new Set(items.map(item => item.id)), [items]);
  const session = useThumbnailSession({
    teamId,
    client,
    enabled: true
  });
  /* No "thumbnail ready" on a result: the address is asked for, and a picture that does not
     come is the kind's glyph (the card and the row both fall back). */
  const thumbnailFor = (material: CatalogMaterialItem) =>
    session && (material.category === 'image' || material.category === 'video')
      ? client.thumbnailUrl(session, material.id)
      : null;
  const focused = selection.focused;
  const paneShown = focused !== null;
  useEffect(() => {
    onPaneShown(paneShown);
  }, [onPaneShown, paneShown]);
  useEffect(() => () => onPaneShown(false), [onPaneShown]);

  const open = (material: CatalogMaterialItem) => {
    view.commitQuery();
    if (material.kind === 'folder') onOpenFolder(material);
    else view.openers.preview(material);
  };
  const resultActs: SelectionActs<CatalogMaterialItem> = {
    ...acts,
    onTrash: chosen => {
      acts.onTrash(chosen);
      selection.drop(chosen.map(item => item.id));
      view.refetch();
    }
  };
  const inFolder = query.scope !== 'space' && Boolean(currentFolderId);
  const total = view.result?.total ?? 0;

  const strip =
    selection.checkedItems.length > 0 ? (
      <ExplorerSelection
        items={selection.checkedItems}
        shownIds={shownIds}
        selectable={items}
        elsewhereKey="teamExplorerSelectedOffResults"
        onClear={selection.clear}
        onSelectAll={selection.checkAll}
        acts={resultActs}
      />
    ) : (
      <div className="team-explorer-results-strip">
        {/* Only with a folder open: at the root the folder is the space. */}
        {currentFolderId && (
          <SegmentedControl<'subtree' | 'space'>
            size="sm"
            className="team-explorer-search-scope"
            label={t('searchScopeLabel')}
            value={inFolder ? 'subtree' : 'space'}
            options={[
              {
                value: 'subtree',
                label: t('searchScopeFolder'),
                title: t('searchScopeFolderHint')
              },
              { value: 'space', label: t('searchScopeSpace') }
            ]}
            onChange={place => onScopeChange({ scope: place })}
          />
        )}
        {/* Nothing found says so in the list's place, once; the strip does not add "0". */}
        <span className="team-explorer-results-count" aria-live="polite">
          {view.loading && !view.result
            ? t('teamCatalogRefreshing')
            : total === 0
              ? ''
              : total === 1
                ? t('teamCatalogCountOne')
                : t('teamCatalogCountMany', { count: total })}
        </span>
      </div>
    );

  return (
    <>
      {hosts.strip && createPortal(strip, hosts.strip)}
      <ResultList
        result={view.result}
        loading={view.loading}
        error={view.error}
        empty={view.empty}
        query={view.answeredQuery}
        page={view.page}
        onPageChange={view.setPage}
        selection={selection}
        onOpen={open}
        onRetry={view.refetch}
        pathFor={pathFor}
        thumbnailFor={thumbnailFor}
        tagging={tagging}
        actionsFor={material => (
          <SearchResultActions
            className="team-explorer-result-actions"
            maxInline={0}
            material={material}
            permissions={permissions!}
            storageKind={view.storageKind}
            browseClient={client}
            destinationFolderId={material.parentFolderId ?? null}
            canManageMetadata={view.canManageMetadata}
            onChanged={view.refetch}
            onPreview={view.openers.preview}
            onEditText={view.openers.editText}
            onProcess={view.openers.process}
            onEditMetadata={view.openers.editMetadata}
            onShowProvenance={view.openers.provenance}
            onCreateTask={onCreateTask}
            onReveal={onReveal}
          />
        )}
      />
      {focused &&
        hosts.pane &&
        createPortal(
          <ResultPane
            material={focused}
            folderName={pathFor(focused)}
            picture={thumbnailFor(focused)}
            permissions={permissions!}
            storageKind={view.storageKind}
            canManageMetadata={view.canManageMetadata}
            browseClient={client}
            openers={view.openers}
            onReveal={onReveal}
            onCreateTask={onCreateTask}
            onChanged={view.refetch}
            tagging={tagging}
            revision={revision}
          />,
          hosts.pane
        )}
    </>
  );
}
