import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';

import { Button } from '../../components/ui';
import { DropdownMenu, Popover, SegmentedControl } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute, type ExplorerView, type TeamRouteQuery } from '../routes';
import { formatShortcut, shortcutOf } from '../palette/shortcuts';
import { Breadcrumb } from './Breadcrumb';
import type { ProcessableFolder } from './FolderScopeDialog';
import { KindFilterMenu } from './KindFilterMenu';
import { SortMenu } from './SortMenu';
import type { ExplorerSort } from './sort';

/** The folder-wide work the toolbar offers, when the reader may process. */
export type ExplorerToolbarProcess = {
  folder: ProcessableFolder | null;
  onFolder: (folder: ProcessableFolder) => void;
  onCompressFolder?: (folder: ProcessableFolder) => void;
  onSpace?: () => void;
};

/** The Drive scan button, when the reader may ask for one here. */
export type ExplorerToolbarResync = {
  /** A scan or an upload into this folder is under way. */
  busy: boolean;
  /** Inside a folder (it scans the folder) rather than at the root (it scans the space). */
  inFolder: boolean;
  onStart: () => void;
};

/**
 * The explorer's toolbar (070, FR-001, out of `ExplorerShell`): the folder toggle, the way back
 * (to the files from the trash, to the task that sent you here), the path, and the actions —
 * how the list is shown, the search, adding files and folders, the Drive scan, processing, and
 * list or grid. The selection bar sits at its end (`children`).
 */
export function ExplorerToolbar({
  teamId,
  treeOpen,
  onToggleTree,
  trash,
  trashReturnLabel,
  onLeaveTrash,
  backToTask,
  searching,
  onOpenSearch,
  onCloseSearch,
  kinds,
  onKindsChange,
  sort,
  onSortChange,
  canUpload,
  onPickFiles,
  onPickFolder,
  onCreateFolder,
  addMenuOpen,
  addMenuAnchor,
  onOpenAddMenu,
  onCloseAddMenu,
  resync,
  process,
  view,
  onViewChange,
  children
}: {
  teamId: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  trash: boolean;
  trashReturnLabel?: string;
  onLeaveTrash: () => void;
  /** The task that sent the reader here, if one did (024, FR-080). */
  backToTask?: string | null;
  searching: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  kinds: TeamRouteQuery['kinds'];
  onKindsChange: (kinds: TeamRouteQuery['kinds']) => void;
  sort: ExplorerSort;
  onSortChange: (sort: ExplorerSort) => void;
  canUpload: boolean;
  onPickFiles: (files: FileList) => void;
  onPickFolder: () => void;
  onCreateFolder: () => void;
  /** The "Add files" menu, shared with the empty folder's own button. */
  addMenuOpen: boolean;
  addMenuAnchor: MutableRefObject<HTMLButtonElement | null>;
  onOpenAddMenu: (anchor: HTMLButtonElement) => void;
  onCloseAddMenu: () => void;
  resync: ExplorerToolbarResync | null;
  process: ExplorerToolbarProcess | null;
  view: ExplorerView;
  onViewChange: (view: ExplorerView) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="team-explorer-toolbar">
      <Button
        type="button"
        variant="ghost"
        className="team-explorer-folders-toggle"
        aria-pressed={treeOpen}
        onClick={onToggleTree}
      >
        {t('teamExplorerFoldersToggle')}
      </Button>
      {trash ? (
        <Button type="button" variant="ghost" onClick={onLeaveTrash}>
          ← {trashReturnLabel ?? t('teamExplorerBackToFiles')}
        </Button>
      ) : (
        <>
          {/* The task that sent you here, one press away (024, FR-080). */}
          {backToTask && (
            <a
              className="team-explorer-back-to-task"
              href={buildTeamRoute({
                spaceId: teamId,
                section: 'tasks',
                query: { taskId: backToTask }
              })}
              onClick={event =>
                internalLink(
                  event,
                  buildTeamRoute({
                    spaceId: teamId,
                    section: 'tasks',
                    query: { taskId: backToTask }
                  })
                )
              }
            >
              ← {t('teamExplorerBackToTask')}
            </a>
          )}
          <Breadcrumb />
        </>
      )}
      <div className="team-explorer-toolbar-actions">
        {/* In the actions' group, so they wrap with the buttons, and first in it, at the
              left edge behind a rule (owner, 2026-10-10): how the list is shown, apart
              from what to do to it. */}
        {!trash && !searching && (
          <div className="team-explorer-list-controls">
            <KindFilterMenu kinds={kinds} onChange={onKindsChange} />
            {/* Re-sorting is one move, not a reshuffle in a single frame (058). */}
            <SortMenu sort={sort} onChange={onSortChange} />
          </div>
        )}
        {!trash && (
          <Button
            type="button"
            variant="secondary"
            aria-pressed={searching}
            /* The key that does the same thing, on the control that does it
                 (024, FR-054): a shortcut nobody is told about is a shortcut
                 only the person who wrote it uses. */
            title={
              searching
                ? undefined
                : `${t('teamExplorerSearchOpen')} · ${formatShortcut(shortcutOf('search')!.keys)}`
            }
            onClick={() => (searching ? onCloseSearch() : onOpenSearch())}
          >
            {searching ? t('teamExplorerSearchClose') : t('teamExplorerSearchOpen')}
          </Button>
        )}
        {canUpload && !trash && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={event => {
                if (event.target.files) onPickFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <Button type="button" variant="secondary" onClick={onCreateFolder}>
              {t('teamExplorerCreateFolder')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={event => onOpenAddMenu(event.currentTarget)}
            >
              {t('teamExplorerAddFiles')}
            </Button>
            <DropdownMenu
              open={addMenuOpen}
              onClose={onCloseAddMenu}
              anchor={addMenuAnchor}
              label={t('teamExplorerAddFiles')}
              items={[
                {
                  id: 'files',
                  label: t('teamExplorerAddFiles'),
                  onSelect: () => fileInput.current?.click()
                },
                {
                  id: 'folder',
                  label: t('teamExplorerAddFolder'),
                  onSelect: onPickFolder
                }
              ]}
            />
            {resync && (
              <Button
                type="button"
                variant="secondary"
                disabled={resync.busy}
                aria-busy={resync.busy || undefined}
                onClick={resync.onStart}
              >
                {resync.busy && <span className="ui-spinner" aria-hidden="true" />}
                {resync.busy
                  ? t('teamFolderResyncRunning')
                  : resync.inFolder
                    ? t('teamDriveResyncFolder')
                    : t('teamDriveResync')}
              </Button>
            )}
          </>
        )}
        {/*
         * Processing a whole folder or a whole space was reachable only
         * through an unlabelled ▶ that appeared after something was selected
         * — and that button then ignored the selection anyway. It is a door
         * in the toolbar now, open before anything is chosen, and it names
         * the two scopes that actually exist.
         */}
        {process && !trash && !searching && <ProcessMenu {...process} />}
        {!trash && (
          /* A choice of two, told as one: it was a pair of `aria-pressed`
               toggles, which says "this button is down" twice rather than
               "this is the one of two that is chosen" (021, T088). */
          <SegmentedControl<'list' | 'grid'>
            className="team-explorer-view-toggle"
            label={t('teamExplorerViewLabel')}
            value={view}
            onChange={onViewChange}
            options={[
              {
                value: 'list',
                label: <ListViewIcon />,
                title: t('teamExplorerViewList')
              },
              {
                value: 'grid',
                label: <GridViewIcon />,
                title: t('teamExplorerViewGrid')
              }
            ]}
          />
        )}
      </div>
      {children}
    </div>
  );
}

function ListViewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 5h2v2H4zm4 .25h12v1.5H8zM4 11h2v2H4zm4 .25h12v1.5H8zM4 17h2v2H4zm4 .25h12v1.5H8z"
      />
    </svg>
  );
}

function GridViewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" />
    </svg>
  );
}

/**
 * Where a batch is started from, and over what.
 *
 * Two scopes, because two exist: the folder that is open, walked with its
 * subfolders, and everything the space holds. Both already worked; neither had
 * a way in that a person could find without first selecting a file.
 */
function ProcessMenu({
  folder,
  onFolder,
  onCompressFolder,
  onSpace
}: {
  folder: ProcessableFolder | null;
  onFolder: (folder: ProcessableFolder) => void;
  onCompressFolder?: (folder: ProcessableFolder) => void;
  onSpace?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  /*
   * Choosing an item unmounts it, and the window that opens next restores focus
   * to whatever was focused when it appeared — a detached button, which puts
   * focus on the body and loses a keyboard user's place entirely. So the
   * trigger takes focus back first, and the dialog restores to that.
   */
  const choose = (run: () => void) => {
    setOpen(false);
    button.current?.focus();
    run();
  };

  // A menu that says `role="menu"` promises arrow keys; Tab alone was all it
  // had, and the first item never took focus when the menu opened.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    /* Tab leaves a menu rather than walking it — the arrows are the walk. The
       trigger takes focus first: closing on a keydown unmounts the focused item
       before the browser applies the move, and Tab from a detached element
       starts again at the top of the document. */
    if (event.key === 'Tab') {
      button.current?.focus();
      setOpen(false);
      return;
    }
    const items = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(items.length - 1);
  };

  /*
   * At the root there is no folder, so the menu held exactly one item: a press
   * to open a list of one, then a second press to choose the only thing there.
   * With one scope the button is the scope.
   */
  // At the root there is no folder to process; the whole space is in the space's own menu (024).
  if (!folder) return null;

  return (
    <div className="team-explorer-process-menu">
      <Button
        type="button"
        ref={button}
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('teamExplorerProcess')}
      </Button>
      <Popover
        open={open}
        onClose={() => {
          setOpen(false);
          button.current?.focus();
        }}
        anchor={button}
        placement="bottom-start"
        frequent
        label={t('teamExplorerProcessScope')}
        surface="none"
        className="team-explorer-menu"
      >
        <div
          className="team-explorer-menu-items"
          role="menu"
          aria-label={t('teamExplorerProcessScope')}
          ref={list}
          onKeyDown={onListKeyDown}
        >
          {folder && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(() => onFolder(folder))}
            >
              {t('teamExplorerProcessFolder')}
            </button>
          )}
          {folder && onSpace && <hr className="team-explorer-menu-rule" aria-hidden="true" />}
          {onSpace && (
            <button
              type="button"
              role="menuitem"
              className="team-explorer-menu-item"
              onClick={() => choose(onSpace)}
            >
              {t('teamExplorerProcessSpace')}
            </button>
          )}
        </div>
      </Popover>
      {onCompressFolder && (
        <Button type="button" variant="secondary" onClick={() => onCompressFolder(folder)}>
          {t('teamExplorerCompressFolder')}
        </Button>
      )}
    </div>
  );
}
