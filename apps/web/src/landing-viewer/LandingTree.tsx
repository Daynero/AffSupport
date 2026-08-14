import { useMemo, useState } from 'react';
import type { LandingPreviewItem } from '@video-compressor/shared';
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
  if (!visible.length)
    return <p className="landing-gallery-tree-empty">{t('landingGallerySearchEmpty')}</p>;
  return (
    <div className="landing-gallery-tree" role="tree">
      {tree.children.map(node => (
        <TreeBranch
          key={node.key}
          node={node}
          depth={0}
          collapsed={collapsed}
          toggle={key =>
            setCollapsed(current => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          selectedId={selectedId}
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
  onSelect
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  selectedId: string | null;
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
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={selectedId === item.id}
        className={`landing-gallery-tree-landing is-${item.status} ${item.stale ? 'is-stale' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => onSelect(item.id)}
        title={item.relativePath}
      >
        <span className="landing-gallery-tree-icon" aria-hidden="true">
          {item.sourceKind === 'zip' ? 'Z' : '⌑'}
        </span>
        <span className="landing-gallery-tree-copy">
          <strong>{node.name}</strong>
          {status && <small>{status}</small>}
        </span>
        {item.previewAvailable && <i aria-hidden="true" />}
      </button>
    );
  }
  const closed = collapsed.has(node.key);
  return (
    <div role="group">
      <button
        type="button"
        role="treeitem"
        aria-expanded={!closed}
        className="landing-gallery-tree-folder"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => toggle(node.key)}
      >
        <span aria-hidden="true">{closed ? '›' : '⌄'}</span>
        <strong>{node.name}</strong>
      </button>
      {!closed &&
        node.children.map(child => (
          <TreeBranch
            key={child.key}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            toggle={toggle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
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
