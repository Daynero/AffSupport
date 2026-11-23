import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, FolderTree, LayoutGrid, List } from 'lucide-react';

import {
  Button,
  DropdownMenu,
  FileTrigger,
  IconButton,
  Link,
  Popover,
  SearchField,
  SegmentedControl,
  type FileTriggerHandle
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute, type ExplorerView } from '../routes';
import { formatShortcut, shortcutOf } from '../palette/shortcuts';
import { Breadcrumb, FolderHistoryButtons, useFolderHistory } from './Breadcrumb';
import type { ProcessableFolder } from './FolderScopeDialog';

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

/** Marks the toolbar's search box, so the `/` shortcut can put the caret in it. */
export const EXPLORER_SEARCH_ATTRIBUTE = 'data-explorer-search';

/**
 * The explorer's toolbar (070, US1): one row, the way Finder and Drive draw theirs.
 *
 * Left, where you are — the folder tree's toggle on a narrow window, Back and Forward, the way
 * back to the task that sent you, the path. Then the search box. Right, what you do here: the
 * one primary, «Завантажити ▾» (files, a folder, a new folder), and how the list is shown.
 *
 * It used to hold eleven controls and wrap onto three lines: a kind filter and a sort menu
 * that arrange the list (they live above the list now, and the list's own headers sort it),
 * two primaries side by side («Нова папка» and «Додати файли»), a Search button that opened
 * a different screen, and a hidden `<input type="file">` — the explorer's one raw control,
 * now the inventory's `FileTrigger`. The selection bar sits over it (`children`).
 */
export function ExplorerToolbar({
  teamId,
  treeAsDrawer,
  treeOpen,
  onToggleTree,
  trash,
  trashReturnLabel,
  onLeaveTrash,
  backToTask,
  searching,
  onOpenSearch,
  onCloseSearch,
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
  /** The tree is a drawer on this window (up to 1024 px), opened from here. */
  treeAsDrawer: boolean;
  treeOpen: boolean;
  onToggleTree: () => void;
  trash: boolean;
  trashReturnLabel?: string;
  onLeaveTrash: () => void;
  /** The task that sent the reader here, if one did (024, FR-080). */
  backToTask?: string | null;
  searching: boolean;
  /** Opens the search of the space with what was typed (until T021 puts results in place). */
  onOpenSearch: (text: string) => void;
  onCloseSearch: () => void;
  canUpload: boolean;
  onPickFiles: (files: File[]) => void;
  onPickFolder: () => void;
  onCreateFolder: () => void;
  /** The upload menu, shared with the empty folder's own button. */
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
  const filePicker = useRef<FileTriggerHandle>(null);
  const history = useFolderHistory();
  const [draft, setDraft] = useState('');
  const taskRoute = backToTask
    ? buildTeamRoute({ spaceId: teamId, section: 'tasks', query: { taskId: backToTask } })
    : null;
  const shortcut = formatShortcut(shortcutOf('search')!.keys);

  return (
    <div className="team-explorer-toolbar">
      {treeAsDrawer && (
        <IconButton
          className="team-explorer-folders-toggle"
          label={t('teamExplorerFoldersToggle')}
          pressed={treeOpen}
          onClick={onToggleTree}
        >
          <FolderTree size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
      {trash ? (
        <div className="team-explorer-location">
          <Button
            variant="ghost"
            leading={<ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
            onClick={onLeaveTrash}
          >
            {trashReturnLabel ?? t('teamExplorerBackToFiles')}
          </Button>
        </div>
      ) : (
        <Breadcrumb
          before={
            <>
              <FolderHistoryButtons history={history} />
              {/* The task that sent you here, one press away (024, FR-080): a navigation
                  control of the row, not a chip of its own colour beside the path. */}
              {taskRoute && (
                <Link
                  variant="standalone"
                  className="team-explorer-back-to-task"
                  href={taskRoute}
                  leading={<ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
                  onClick={event => internalLink(event, taskRoute)}
                >
                  {t('teamExplorerBackToTask')}
                </Link>
              )}
            </>
          }
        />
      )}
      {!trash &&
        (searching ? (
          <Button variant="secondary" className="team-explorer-search" onClick={onCloseSearch}>
            {t('teamExplorerSearchClose')}
          </Button>
        ) : (
          <div className="team-explorer-search" {...{ [EXPLORER_SEARCH_ATTRIBUTE]: '' }}>
            <SearchField
              aria-label={t('teamExplorerSearchOpen')}
              placeholder={t('teamExplorerSearchPlaceholder', { shortcut })}
              value={draft}
              onChange={setDraft}
              onSubmit={text => {
                setDraft('');
                onOpenSearch(text.trim());
              }}
            />
          </div>
        ))}
      <div className="team-explorer-toolbar-actions">
        {canUpload && !trash && (
          <>
            {/* The picker for files; the menu item opens it through the ref. */}
            <FileTrigger ref={filePicker} onSelect={onPickFiles} />
            <Button
              variant="primary"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              trailing={<ChevronDown size={16} strokeWidth={ICON_STROKE} />}
              onClick={event => onOpenAddMenu(event.currentTarget)}
            >
              {t('teamExplorerUpload')}
            </Button>
            <DropdownMenu
              open={addMenuOpen}
              onClose={onCloseAddMenu}
              anchor={addMenuAnchor}
              label={t('teamExplorerUpload')}
              items={[
                {
                  id: 'files',
                  label: t('teamExplorerUploadFiles'),
                  onSelect: () => filePicker.current?.open()
                },
                {
                  id: 'folder',
                  label: t('teamExplorerUploadFolder'),
                  onSelect: onPickFolder
                },
                'separator',
                {
                  id: 'create-folder',
                  label: t('teamExplorerCreateFolder'),
                  onSelect: onCreateFolder
                }
              ]}
            />
            {resync && (
              <Button variant="secondary" disabled={resync.busy} onClick={resync.onStart}>
                {resync.busy
                  ? t('teamFolderResyncRunning')
                  : resync.inFolder
                    ? t('teamDriveResyncFolder')
                    : t('teamDriveResync')}
              </Button>
            )}
          </>
        )}
        {process && !trash && !searching && <ProcessMenu {...process} />}
        {!trash && (
          /* A choice of two, told as one (021, T088). */
          <SegmentedControl<'list' | 'grid'>
            className="team-explorer-view-toggle"
            label={t('teamExplorerViewLabel')}
            value={view}
            onChange={onViewChange}
            options={[
              {
                value: 'list',
                label: <List size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
                title: t('teamExplorerViewList')
              },
              {
                value: 'grid',
                label: <LayoutGrid size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
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
