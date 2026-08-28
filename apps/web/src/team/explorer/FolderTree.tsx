import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { TeamFolderNode } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { KindIcon } from './KindIcon';
import { useExplorer } from './ExplorerProvider';
import { DRAG_TYPE } from './rowKinds';

/**
 * The folder tree (011, FR-008/FR-027): every level, counts beside each
 * folder, "listing…" until a folder's last page has landed, and a keyboard
 * that does what a tree's keyboard does. Collapsed by default except along
 * the open folder's path, which keeps the DOM bounded at the published limit.
 */
export function FolderTree({
  onDropMaterials
}: {
  /** Materials dragged from the content area onto a folder (011, FR-026). */
  onDropMaterials?: (folderDriveId: string, materialIds: string[]) => void;
} = {}) {
  const { t } = useI18n();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const {
    nodes,
    loading,
    error,
    topLevelIds,
    currentFolderId,
    childrenOf,
    nodeOf,
    pathTo,
    openFolder
  } = useExplorer();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the open folder's ancestors expanded so the address is always visible.
  useEffect(() => {
    if (!currentFolderId) return;
    setExpanded(current => {
      const next = new Set(current);
      for (const node of pathTo(currentFolderId)) next.add(node.driveFileId);
      return next;
    });
  }, [currentFolderId, pathTo]);

  /** Visible items in document order, for arrow-key movement. */
  const visible = useMemo(() => {
    const order: TeamFolderNode[] = [];
    const walk = (ids: string[]) => {
      for (const id of ids) {
        const node = nodeOf(id);
        if (!node) continue;
        order.push(node);
        if (expanded.has(id)) walk(childrenOf(id).map(child => child.driveFileId));
      }
    };
    walk(topLevelIds);
    return order;
  }, [childrenOf, expanded, nodeOf, topLevelIds]);

  const toggle = (id: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focusItem = (id: string) => {
    setFocused(id);
    const element = listRef.current?.querySelector<HTMLElement>(`[data-folder-id="${id}"]`);
    element?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, node: TeamFolderNode) => {
    const index = visible.findIndex(item => item.driveFileId === node.driveFileId);
    const hasChildren = node.childFolderCount > 0;
    switch (event.key) {
      case 'ArrowDown': {
        const next = visible[index + 1];
        if (next) focusItem(next.driveFileId);
        break;
      }
      case 'ArrowUp': {
        const previous = visible[index - 1];
        if (previous) focusItem(previous.driveFileId);
        break;
      }
      case 'ArrowRight': {
        if (hasChildren && !expanded.has(node.driveFileId)) toggle(node.driveFileId);
        else if (hasChildren) {
          const child = childrenOf(node.driveFileId)[0];
          if (child) focusItem(child.driveFileId);
        }
        break;
      }
      case 'ArrowLeft': {
        if (expanded.has(node.driveFileId)) toggle(node.driveFileId);
        else if (node.parentFolderId && nodeOf(node.parentFolderId)) {
          focusItem(node.parentFolderId);
        }
        break;
      }
      case 'Enter':
      case ' ':
        openFolder(node.driveFileId);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderLevel = (ids: string[], depth: number) => (
    <ul role={depth === 0 ? 'tree' : 'group'} ref={depth === 0 ? listRef : undefined}>
      {ids.map(id => {
        const node = nodeOf(id);
        if (!node) return null;
        const isExpanded = expanded.has(id);
        const hasChildren = node.childFolderCount > 0;
        const isCurrent = currentFolderId === id;
        return (
          <li
            key={node.id}
            role="treeitem"
            className={dropTarget === id ? 'is-drop-target' : undefined}
            aria-labelledby={`team-explorer-node-${node.id}`}
            aria-level={depth + 1}
            onDragOver={event => {
              if (!onDropMaterials || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(id);
            }}
            onDragLeave={() => setDropTarget(current => (current === id ? null : current))}
            onDrop={event => {
              if (!onDropMaterials) return;
              const raw = event.dataTransfer.getData(DRAG_TYPE);
              if (!raw) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(null);
              onDropMaterials(id, raw.split(',').filter(Boolean));
            }}
            aria-expanded={hasChildren ? isExpanded : undefined}
            aria-selected={isCurrent}
            aria-current={isCurrent ? 'location' : undefined}
            data-folder-id={id}
            tabIndex={focused === id || (focused === null && depth === 0 && ids[0] === id) ? 0 : -1}
            onKeyDown={event => onKeyDown(event, node)}
            onFocus={() => setFocused(id)}
          >
            <div className={`team-explorer-tree-row${isCurrent ? ' is-current' : ''}`}>
              {hasChildren ? (
                <button
                  type="button"
                  className="team-explorer-tree-toggle"
                  aria-label={isExpanded ? t('teamExplorerCollapse') : t('teamExplorerExpand')}
                  tabIndex={-1}
                  onClick={event => {
                    event.stopPropagation();
                    toggle(id);
                  }}
                >
                  {isExpanded ? '▾' : '▸'}
                </button>
              ) : (
                <span className="team-explorer-tree-toggle" aria-hidden="true" />
              )}
              <button
                type="button"
                id={`team-explorer-node-${node.id}`}
                className="team-explorer-tree-name"
                tabIndex={-1}
                onClick={() => openFolder(id)}
              >
                <KindIcon kind="folder" /> {node.name}
              </button>
              <span
                className="team-explorer-tree-count"
                aria-label={t('teamExplorerFolderCounts', {
                  folders: node.childFolderCount,
                  files: node.childFileCount
                })}
              >
                {node.indexedAt === null
                  ? t('teamExplorerListing')
                  : /* Everything inside, not files alone: a folder holding two
                       sub-folders and no loose files read as "0", which says
                       empty when it is not. Nothing is shown when it truly is. */
                    node.childFolderCount + node.childFileCount || ''}
              </span>
            </div>
            {hasChildren &&
              isExpanded &&
              renderLevel(
                childrenOf(id).map(child => child.driveFileId),
                depth + 1
              )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <aside className="team-explorer-tree" aria-label={t('teamExplorerTreeLabel')}>
      <button
        type="button"
        className={`team-explorer-tree-root${currentFolderId === null ? ' is-current' : ''}`}
        aria-current={currentFolderId === null ? 'location' : undefined}
        onClick={() => openFolder(null)}
      >
        {t('teamExplorerRootLabel')}
      </button>
      {loading && nodes === null && (
        <p className="team-explorer-muted">{t('teamExplorerLoading')}</p>
      )}
      {error && <p className="team-inline-error">{t('teamExplorerLoadFailed')}</p>}
      {nodes && nodes.length === 0 && (
        <p className="team-explorer-muted">{t('teamExplorerNoFolders')}</p>
      )}
      {nodes && nodes.length > 0 && renderLevel(topLevelIds, 0)}
    </aside>
  );
}
