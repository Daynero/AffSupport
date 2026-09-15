import { useMemo, useState } from 'react';
import { FileArchive, Folder, TriangleAlert } from 'lucide-react';
import type { LandingPreviewItem } from '@video-compressor/shared';
import { ICON_STROKE } from '../components/icons';
import { useI18n } from '../i18n';
import { EmptyState, Spinner, Tree, type TreeNode } from '../components/ui/index';

interface Branch {
  key: string;
  name: string;
  children: Branch[];
  landing: LandingPreviewItem | null;
}

/**
 * The gallery's folder tree (021, T070).
 *
 * It is the inventory's Tree now — which is where its one-tab-stop keyboard
 * went: two hundred landings were two hundred tab stops, and that fix belonged
 * to every tree in the product rather than to this one.
 */
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

  const status = (item: LandingPreviewItem) =>
    item.stale
      ? t('landingGalleryStatusStale')
      : item.status === 'rendering'
        ? t('landingGalleryStatusRendering')
        : item.status === 'failed'
          ? t('landingGalleryStatusFailed')
          : item.status === 'queued'
            ? t('landingGalleryStatusQueued')
            : undefined;

  const toNode = (branch: Branch): TreeNode => {
    const item = branch.landing;
    if (!item) {
      return {
        id: branch.key,
        label: branch.name,
        className: 'lv-tree-folder',
        children: branch.children.map(toNode)
      };
    }
    const Icon = item.sourceKind === 'zip' ? FileArchive : Folder;
    return {
      id: item.id,
      label: branch.name,
      description: status(item),
      className: `lv-tree-landing is-${item.status}${item.stale ? ' is-stale' : ''}`,
      icon: <Icon size={18} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      meta:
        item.status === 'rendering' ? (
          <Spinner />
        ) : item.status === 'failed' ? (
          <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
        ) : item.previewAvailable ? (
          <i className="lv-tree-ready" aria-hidden="true" />
        ) : undefined
    };
  };

  if (!visible.length)
    return (
      <EmptyState className="lv-tree-empty" size="sm" title={t('landingGallerySearchEmpty')} />
    );

  /* The tree holds which folders are *closed*; the inventory asks which are
     open, so the expansion is the folders minus those. */
  const expanded = new Set<string>();
  const collectFolders = (branch: Branch) => {
    for (const child of branch.children) {
      if (!child.landing) {
        if (!collapsed.has(child.key)) expanded.add(child.key);
        collectFolders(child);
      }
    }
  };
  collectFolders(tree);

  return (
    <Tree
      className="lv-tree"
      label={t('landingGalleryTree')}
      nodes={tree.children.map(toNode)}
      selectedId={selectedId}
      expandedIds={expanded}
      onSelect={onSelect}
      onToggle={key =>
        setCollapsed(current => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })
      }
    />
  );
}

function buildTree(landings: LandingPreviewItem[]): Branch {
  const root: Branch = { key: 'root', name: '', children: [], landing: null };
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
  const sort = (node: Branch) => {
    node.children.sort((left, right) => {
      if (Boolean(left.landing) !== Boolean(right.landing)) return left.landing ? 1 : -1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}
