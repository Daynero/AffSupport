import { useCallback, useEffect, useRef } from 'react';
import type { CatalogMaterialItem } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { useI18n } from '../../i18n';
import type { TeamRouteQuery } from '../routes';
import type { useExplorer } from './ExplorerProvider';
import type { useFolderPage } from './useFolderPage';
import { summaryOf } from './summary';

/**
 * Where a file is, out of `ExplorerShell` (070, FR-001): a file the address names is selected
 * and scrolled to once its folder is in, a search result opens its folder with it selected,
 * and a result's path is read from the cached tree.
 */
export function useExplorerReveal({
  query,
  searching,
  explorer,
  currentFolderId,
  page,
  onPreview,
  onQueryChange
}: {
  query: TeamRouteQuery;
  searching: boolean;
  explorer: ReturnType<typeof useExplorer>;
  currentFolderId: string | null;
  page: ReturnType<typeof useFolderPage>;
  onPreview?: (material: TeamMaterialSummary) => void;
  onQueryChange: (patch: Partial<TeamRouteQuery>) => void;
}) {
  const { t } = useI18n();
  const { select, nodeOf, pathTo } = explorer;
  /*
   * A file the address names (`item`) — from "show in folder" on a search result or a task's
   * attachment: once its folder's rows are in, it is selected and scrolled into view, once per
   * address. A later page is fetched if the file is further down the folder.
   */
  const revealedItem = useRef<string | null>(null);
  const revealItemId = query.itemId;
  useEffect(() => {
    if (!revealItemId) {
      revealedItem.current = null;
      return;
    }
    if (revealedItem.current === revealItemId || searching || query.trash) return;
    if (query.folderId && explorer.nodes && !nodeOf(query.folderId)) {
      onQueryChange({ folderId: null, itemId: revealItemId });
      return;
    }
    if (currentFolderId !== (query.folderId ?? null) || page.loading) return;
    if (!page.rows.some(row => row.id === revealItemId)) {
      if (page.hasMore) void page.loadMore();
      return;
    }
    revealedItem.current = revealItemId;
    select(revealItemId);
    // `open=1` beside it: the address was a file being looked at, so it is
    // looked at again rather than merely pointed at (024, FR-050).
    if (query.open) {
      const row = page.rows.find(candidate => candidate.id === revealItemId);
      if (row && row.kind !== 'folder') onPreview?.(summaryOf(row));
    }
    window.requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLElement>('[data-material-id]'))
        .find(element => element.dataset.materialId === revealItemId)
        ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    });
  }, [
    currentFolderId,
    explorer.nodes,
    nodeOf,
    onPreview,
    onQueryChange,
    page,
    query.folderId,
    query.open,
    query.trash,
    revealItemId,
    searching,
    select
  ]);

  /**
   * Where a file lives: its folder opens with the file selected. A parent the tree does not know is
   * the space root (a file directly under it has the root's Drive id as its parent).
   */
  const revealMaterial = useCallback(
    (item: { id: string; parentFolderId?: string | null }) => {
      const parent = item.parentFolderId ?? null;
      onQueryChange({
        q: '',
        scope: 'folder',
        filters: undefined,
        trash: false,
        folderId: parent && nodeOf(parent) ? parent : null,
        itemId: item.id
      });
    },
    [nodeOf, onQueryChange]
  );

  /** A folder found by the search, gone into — when the tree knows it (070, US3). */
  const openFolderResult = useCallback(
    (material: { id: string }) => {
      const node = explorer.nodes?.find(candidate => candidate.id === material.id);
      if (!node) return false;
      onQueryChange({
        q: '',
        scope: 'folder',
        filters: undefined,
        folderId: node.driveFileId,
        itemId: null
      });
      return true;
    },
    [explorer.nodes, onQueryChange]
  );

  /** Root-relative path for a search result, from the cached tree. */
  const pathFor = useCallback(
    (item: CatalogMaterialItem) => {
      const parent = item.parentFolderId ?? null;
      if (!parent || !nodeOf(parent)) return t('teamExplorerRootLabel');
      return [t('teamExplorerRootLabel'), ...pathTo(parent).map(node => node.name)].join(' / ');
    },
    [nodeOf, pathTo, t]
  );

  return { revealMaterial, openFolderResult, pathFor };
}
