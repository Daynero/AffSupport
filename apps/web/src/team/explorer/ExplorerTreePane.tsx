import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Drawer, Splitter } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { NARROW_LG_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { boundedNumber, persistedViewKey, usePersistedState } from '../persistedView';
import { FolderTree } from './FolderTree';

/** The folder tree's width (070, FR-006): what it was (280, the old column's widest), and the
 *  bounds the edge moves between. */
export const TREE_WIDTH = { initial: 280, min: 200, max: 480 } as const;

/**
 * Where the folder tree lives (070, US2, out of `ExplorerShell`).
 *
 * From 1024 px up it is a column whose edge moves (FR-006): 200–480 px by the pointer or the
 * arrows, kept per space in this browser and stored once, when the edge is let go. Up to and
 * including 1024 px it is a drawer opened from the toolbar (FR-007) that closes when a folder
 * is chosen — a block over the list pushed the files below the fold on a tablet.
 *
 * Returns what the shell needs: whether the tree is a drawer, its open state and toggle, the
 * column's width for the surface, and the tree itself, to render first in the surface.
 */
export function useExplorerTreePane({
  teamId,
  currentFolderId,
  elsewhere,
  onDropMaterials,
  onReset
}: {
  teamId: string;
  currentFolderId: string | null;
  elsewhere: boolean;
  onDropMaterials?: (folderDriveId: string, materialIds: string[]) => void;
  onReset?: () => void;
}): {
  asDrawer: boolean;
  open: boolean;
  toggle: () => void;
  surfaceStyle: CSSProperties | undefined;
  tree: ReactNode;
} {
  const { t } = useI18n();
  const asDrawer = useMediaQuery(NARROW_LG_QUERY);
  const [open, setOpen] = useState(false);
  const [stored, setStored] = usePersistedState(
    persistedViewKey(teamId, 'explorer.treeWidth'),
    TREE_WIDTH.initial,
    boundedNumber(TREE_WIDTH.min, TREE_WIDTH.max)
  );
  /* While the edge is held the width follows the pointer; it is stored when it is let go. */
  const [dragged, setDragged] = useState<number | null>(null);
  const width = dragged ?? stored;

  /* A folder chosen in the drawer is where the reader wanted to go: the drawer has done its
     job. And a window that grows past the drawer's width leaves nothing open. */
  const lastFolder = useRef(currentFolderId);
  useEffect(() => {
    if (lastFolder.current === currentFolderId) return;
    lastFolder.current = currentFolderId;
    setOpen(false);
  }, [currentFolderId]);
  useEffect(() => {
    if (!asDrawer) setOpen(false);
  }, [asDrawer]);

  const folders = (
    <FolderTree elsewhere={elsewhere} onDropMaterials={onDropMaterials} onReset={onReset} />
  );
  const tree = asDrawer ? (
    <Drawer
      open={open}
      side="left"
      size="sm"
      title={t('teamExplorerTreeLabel')}
      className="team-explorer-tree-drawer"
      onClose={() => setOpen(false)}
    >
      {folders}
    </Drawer>
  ) : (
    <>
      {folders}
      <Splitter
        className="team-explorer-tree-splitter"
        label={t('teamExplorerTreeWidth')}
        value={width}
        min={TREE_WIDTH.min}
        max={TREE_WIDTH.max}
        onChange={setDragged}
        onChangeEnd={next => {
          setStored(next);
          setDragged(null);
        }}
      />
    </>
  );
  return {
    asDrawer,
    open,
    toggle: () => setOpen(value => !value),
    surfaceStyle: asDrawer
      ? undefined
      : ({ '--explorer-tree-width': `${width}px` } as CSSProperties),
    tree
  };
}
