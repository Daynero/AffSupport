import { useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, FileArchive, Folder, TriangleAlert } from 'lucide-react';
import type { LandingPreviewItem } from '@video-compressor/shared';
import { ICON_STROKE } from '../components/icons';
import { Spinner } from '../components/ui';
import { useI18n } from '../i18n';

interface TreeNode {
  key: string;
  name: string;
  children: TreeNode[];
  landing: LandingPreviewItem | null;
}

export function LandingTree({
  landings,
  selectedId,
  search,
  onSelect
}: {
  landings: LandingPreviewItem[];
  selectedId: string | null;
  search: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const normalized = search.trim().toLocaleLowerCase();
  const visible = normalized
    ? landings.filter(item =>
        `${item.name} ${item.relativePath}`.toLocaleLowerCase().includes(normalized)
      )
    : landings;
  const tree = useMemo(() => buildTree(visible), [visible]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // One tab stop for the whole tree, arrows inside it: two hundred landings used to be two
  // hundred tabs. Focus moves between the rows that are actually shown, in document order.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches('[role="treeitem"]')) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')
    );
    const index = rows.indexOf(target as HTMLButtonElement);
    const focus = (next: number) => rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    const folderKey = target.dataset.folder;
    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(rows.length - 1);
        break;
      case 'ArrowRight':
        if (folderKey && collapsed.has(folderKey)) toggle(folderKey);
        else focus(index + 1);
        break;
      case 'ArrowLeft':
        if (folderKey && !collapsed.has(folderKey)) toggle(folderKey);
        else {
          const parent = target.closest('[role="group"]')?.previousElementSibling;
          if (parent instanceof HTMLElement && parent.matches('[role="treeitem"]')) parent.focus();
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  if (!visible.length) return <p className="lv-tree-empty">{t('landingGallerySearchEmpty')}</p>;
  const tabStop = selectedId && visible.some(item => item.id === selectedId) ? selectedId : null;
  return (
    <div className="lv-tree" role="tree" aria-label={t('landingGalleryTree')} onKeyDown={onKeyDown}>
      {tree.children.map((node, index) => (
        <TreeBranch
          key={node.key}
          node={node}
          depth={0}
          collapsed={collapsed}
          toggle={toggle}
          selectedId={selectedId}
          // Without a selection the first row carries the tab stop.
          tabStop={tabStop ?? (index === 0 ? firstLandingId(node) : null)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeBranch({
  node,
  depth,
  collapsed,
  toggle,
  selectedId,
  tabStop,
  onSelect
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  selectedId: string | null;
  tabStop: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  if (node.landing) {
    const item = node.landing;
    const status = item.stale
      ? t('landingGalleryStatusStale')
      : item.status === 'rendering'
        ? t('landingGalleryStatusRendering')
        : item.status === 'failed'
          ? t('landingGalleryStatusFailed')
          : item.status === 'queued'
            ? t('landingGalleryStatusQueued')
            : '';
    const Icon = item.sourceKind === 'zip' ? FileArchive : Folder;
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={selectedId === item.id}
        aria-level={depth + 1}
        tabIndex={tabStop === item.id ? 0 : -1}
        className={`lv-tree-landing is-${item.status} ${item.stale ? 'is-stale' : ''}`.trim()}
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => onSelect(item.id)}
      >
        <Icon size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="lv-tree-copy">
          <strong>{node.name}</strong>
          {status && <small>{status}</small>}
        </span>
        <span className="lv-tree-state" aria-hidden="true">
          {item.status === 'rendering' ? (
            <Spinner small />
          ) : item.status === 'failed' ? (
            <TriangleAlert size={14} strokeWidth={2} />
          ) : item.previewAvailable ? (
            <i />
          ) : null}
        </span>
      </button>
    );
  }
  const closed = collapsed.has(node.key);
  // A collapsed folder that hides the selected row carries its tab stop, so the tree can
  // still be entered from the keyboard and opened again.
  const holdsTabStop = closed && tabStop !== null && containsLanding(node, tabStop);
  // The folder row first, its children in a group after it — a group must not contain the
  // row that owns it.
  return (
    <>
      <button
        type="button"
        role="treeitem"
        aria-expanded={!closed}
        aria-level={depth + 1}
        tabIndex={holdsTabStop ? 0 : -1}
        data-folder={node.key}
        className="lv-tree-folder"
        style={{ paddingLeft: 6 + depth * 16 }}
        onClick={() => toggle(node.key)}
      >
        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
        <strong>{node.name}</strong>
      </button>
      {!closed && (
        <div role="group">
          {node.children.map(child => (
            <TreeBranch
              key={child.key}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              selectedId={selectedId}
              tabStop={tabStop}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </>
  );
}

function containsLanding(node: TreeNode, id: string): boolean {
  return node.landing?.id === id || node.children.some(child => containsLanding(child, id));
}

function firstLandingId(node: TreeNode): string | null {
  if (node.landing) return node.landing.id;
  for (const child of node.children) {
    const found = firstLandingId(child);
    if (found) return found;
  }
  return null;
}

function buildTree(landings: LandingPreviewItem[]): TreeNode {
  const root: TreeNode = { key: 'root', name: '', children: [], landing: null };
  for (const landing of landings) {
    const segments = landing.relativePath.split('/').filter(Boolean);
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      const last = index === segments.length - 1;
      const key = `${parent.key}/${name}`;
      let child = parent.children.find(item => item.key === key);
      if (!child) {
        child = { key, name, children: [], landing: null };
        parent.children.push(child);
      }
      if (last) child.landing = landing;
      parent = child;
    }
  }
  const sort = (node: TreeNode) => {
    node.children.sort((left, right) => {
      if (Boolean(left.landing) !== Boolean(right.landing)) return left.landing ? 1 : -1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}
