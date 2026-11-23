import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useExplorer } from './ExplorerProvider';
import { Button, DropdownMenu, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';

/**
 * How deep a path is shown in full before the middle folds away.
 *
 * A path of four or more ran past the toolbar and was cut mid-word — "…айли /
 * OneMedi" beside the Search button, with no way to read where you were or to
 * step back to anywhere but the root. Two ancestors and the open folder is what
 * a person needs to see; the rest is one press away.
 */
const VISIBLE_TAIL = 2;

/** The folders visited in this explorer, and where in that list the reader is. */
export type FolderHistory = {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
};

/**
 * The explorer's own Back and Forward (011), as Finder keeps them: the folders
 * this explorer visited, not the browser's history — a browser Back from the
 * first folder would leave the space. Owned by the toolbar, which also offers
 * the two steps in its "…" when the row is too narrow for the arrows.
 */
export function useFolderHistory(): FolderHistory {
  const { currentFolderId, openFolder } = useExplorer();
  const [history, setHistory] = useState<{ entries: (string | null)[]; index: number }>(() => ({
    entries: [currentFolderId],
    index: 0
  }));
  useEffect(() => {
    setHistory(previous => {
      if (previous.entries[previous.index] === currentFolderId) return previous;
      return {
        entries: [...previous.entries.slice(0, previous.index + 1), currentFolderId],
        index: previous.index + 1
      };
    });
  }, [currentFolderId]);
  const move = (step: -1 | 1) => {
    const index = history.index + step;
    if (index < 0 || index >= history.entries.length) return;
    setHistory(previous => ({ ...previous, index }));
    openFolder(history.entries[index] ?? null);
  };
  return {
    canBack: history.index > 0,
    canForward: history.index < history.entries.length - 1,
    back: () => move(-1),
    forward: () => move(1)
  };
}

/** The two arrows, as one group of the row's own plates (070, T012). */
export function FolderHistoryButtons({ history }: { history: FolderHistory }) {
  const { t } = useI18n();
  return (
    <div className="team-explorer-history" role="group" aria-label={t('teamExplorerHistoryLabel')}>
      {/* Obvious arrows carry no tooltip (docs/DESIGN.md, «Кнопки дій»); the name stays. */}
      <IconButton
        label={t('teamExplorerHistoryBack')}
        title=""
        disabled={!history.canBack}
        onClick={history.back}
      >
        <ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <IconButton
        label={t('teamExplorerHistoryForward')}
        title=""
        disabled={!history.canForward}
        onClick={history.forward}
      >
        <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * Where you are (011): the root, the open folder's ancestors and the open folder, on one line.
 *
 * The steps are the inventory's ghost buttons (070, T012) — they were bare `<button>`s with
 * their own height, colour and focus ring, the only links in the toolbar that did not look
 * like its other controls. The folded middle is the inventory's menu, which brings the arrows,
 * typeahead and focus return its hand-written popover was re-deriving.
 */
export function Breadcrumb({ before }: { before?: ReactNode } = {}) {
  const { t } = useI18n();
  const { currentFolderId, pathTo, openFolder } = useExplorer();
  const path = pathTo(currentFolderId);
  const folded = path.length > VISIBLE_TAIL + 1 ? path.slice(0, path.length - VISIBLE_TAIL) : [];
  const shown = folded.length > 0 ? path.slice(path.length - VISIBLE_TAIL) : path;

  /*
   * The whole trail behind the open folder, for the strip too narrow to show
   * any of it. Below about 360px there is room for one name, and it has to be
   * the folder a person is standing in — so everything above it, the root
   * included, goes into one menu. CSS chooses which of the two renderings is
   * on; both are always in the document, so the way back never depends on a
   * width.
   */
  const ancestors = path.slice(0, path.length - 1);

  return (
    <div className="team-explorer-location">
      {before}
      <nav className="team-explorer-breadcrumb" aria-label={t('teamExplorerBreadcrumbLabel')}>
        <ol>
          {path.length > 0 && (
            <li className="team-explorer-breadcrumb-compact">
              <FoldedPath
                nodes={[
                  { id: 'root', driveFileId: '', name: t('teamExplorerRootLabel') },
                  ...ancestors
                ]}
                onOpen={driveFileId => openFolder(driveFileId === '' ? null : driveFileId)}
                label={t('teamExplorerBreadcrumbFolded', { count: ancestors.length + 1 })}
              />
              <Separator />
            </li>
          )}
          <li className="team-explorer-breadcrumb-step">
            {path.length === 0 ? (
              <span aria-current="page" className="team-explorer-crumb-here">
                {t('teamExplorerRootLabel')}
              </span>
            ) : (
              <Crumb name={t('teamExplorerRootLabel')} onOpen={() => openFolder(null)} />
            )}
          </li>
          {folded.length > 0 && (
            <li className="team-explorer-breadcrumb-step">
              <Separator />
              <FoldedPath
                nodes={folded}
                onOpen={driveFileId => openFolder(driveFileId)}
                label={t('teamExplorerBreadcrumbFolded', { count: folded.length })}
              />
            </li>
          )}
          {shown.map((node, index) => (
            <li
              key={node.id}
              className={index === shown.length - 1 ? '' : 'team-explorer-breadcrumb-step'}
            >
              <Separator
                className={index === shown.length - 1 ? 'team-explorer-breadcrumb-step' : ''}
              />
              {index === shown.length - 1 ? (
                /* The open folder, cut with an ellipsis when it must be: the whole name is
                   its tooltip and what a screen reader hears (spec, Edge Cases). */
                <span aria-current="page" className="team-explorer-crumb-here" title={node.name}>
                  {node.name}
                </span>
              ) : (
                <Crumb name={node.name} onOpen={() => openFolder(node.driveFileId)} />
              )}
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );
}

function Crumb({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="team-explorer-crumb"
      /* A name cut by the ellipsis is still readable on hover. */
      title={name}
      onClick={onOpen}
    >
      {name}
    </Button>
  );
}

function Separator({ className = '' }: { className?: string }) {
  return (
    <span className={`team-explorer-breadcrumb-separator ${className}`.trim()} aria-hidden="true">
      /
    </span>
  );
}

/** The ancestors the row has no space for, still one press away. */
function FoldedPath({
  nodes,
  onOpen,
  label
}: {
  nodes: { id: string; driveFileId: string; name: string }[];
  onOpen: (driveFileId: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="team-explorer-breadcrumb-folded">
      <IconButton
        ref={button}
        size="sm"
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        placement="bottom-start"
        label={label}
        items={nodes.map(node => ({
          id: node.id,
          label: node.name,
          onSelect: () => onOpen(node.driveFileId)
        }))}
      />
    </div>
  );
}
