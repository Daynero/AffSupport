import { useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderTree,
  LayoutGrid,
  List,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shrink,
  Trash2,
  X
} from 'lucide-react';

import {
  Button,
  DropdownMenu,
  FileTrigger,
  IconButton,
  Link,
  SearchField,
  SegmentedControl,
  type FileTriggerHandle,
  type MenuEntry
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { internalLink } from '../../lib/navigation';
import { buildTeamRoute, type ExplorerView } from '../routes';
import { formatShortcut, shortcutOf } from '../palette/shortcuts';
import {
  Breadcrumb,
  FolderHistoryButtons,
  useFolderHistory,
  type FolderHistory
} from './Breadcrumb';
import { useToolbarFit } from './useToolbarFit';
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

/** The toolbar's search when it is the explorer's one search (070, US3). */
export type ExplorerToolbarSearch = {
  value: string;
  onChange: (text: string) => void;
  /** Down or Enter in the box: the keyboard goes to the results. */
  onToResults: () => void;
  /** Filled with what opens the box on a short row, for the `/` key. */
  openRef: MutableRefObject<(() => void) | null>;
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
 * now the inventory's `FileTrigger`. The selection bar no longer lies over it (070, T024): it
 * is in the strip above the list, where the list's own controls are.
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
  onOpenTrash,
  view,
  onViewChange,
  inlineSearch,
  backToResults
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
  onOpenTrash: () => void;
  view: ExplorerView;
  onViewChange: (view: ExplorerView) => void;
  /**
   * The one search (070, US3, `explorerInlineSearch`): the box holds the words and the results
   * follow them. Without it the box opens the old search screen on Enter.
   */
  inlineSearch?: ExplorerToolbarSearch | null;
  /** A search left by «Показати в папці», and the way back to it (070, T023). */
  backToResults?: { query: string; onBack: () => void } | null;
}) {
  const { t } = useI18n();
  const filePicker = useRef<FileTriggerHandle>(null);
  const history = useFolderHistory();
  const [draft, setDraft] = useState('');
  /* On a row too short for the box, the magnifier opens it in the path's place (070). */
  const [boxOpen, setBoxOpen] = useState(false);
  const taskRoute = backToTask
    ? buildTeamRoute({ spaceId: teamId, section: 'tasks', query: { taskId: backToTask } })
    : null;
  const shortcut = formatShortcut(shortcutOf('search')!.keys);
  const row = useRef<HTMLDivElement>(null);
  /* A search left from elsewhere (a result shown in its folder, Back) gives the path back. */
  const [wasSearching, setWasSearching] = useState(searching);
  if (wasSearching !== searching) {
    setWasSearching(searching);
    const typingHere =
      typeof document !== 'undefined' && row.current?.contains(document.activeElement);
    if (!searching && (inlineSearch?.value ?? '') === '' && !typingHere) setBoxOpen(false);
  }
  /* The controls that are there only sometimes take their room from the steps (T014). */
  const fit = useToolbarFit(
    row,
    (treeAsDrawer ? SOMETIMES_PX.treeToggle : 0) + (taskRoute ? SOMETIMES_PX.backToTask : 0)
  );
  const arrowsInRow = fit !== 'tight';
  const searchBox = fit === 'full';
  const searchInRow = fit !== 'tight';
  const viewInRow = fit === 'full' || fit === 'compact';
  const inline = Boolean(inlineSearch);
  /* The box stands in the path's place while it is open on a short row, or holds words. */
  const boxOverPath =
    inline && !searchBox && (boxOpen || (inlineSearch?.value ?? '').trim() !== '');
  const openBox = () => {
    setBoxOpen(true);
    // After the box is drawn: it is not in the row until this render lands.
    window.requestAnimationFrame(() =>
      row.current?.querySelector<HTMLInputElement>(`[${EXPLORER_SEARCH_ATTRIBUTE}] input`)?.focus()
    );
  };
  if (inlineSearch) inlineSearch.openRef.current = openBox;
  const closeBox = () => {
    setBoxOpen(false);
    inlineSearch?.onChange('');
  };
  const searchKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!inlineSearch) return;
    if (event.key === 'ArrowDown' && inlineSearch.value.trim() !== '') {
      event.preventDefault();
      event.stopPropagation();
      inlineSearch.onToResults();
    } else if (event.key === 'Escape' && inlineSearch.value === '' && boxOverPath) {
      event.preventDefault();
      setBoxOpen(false);
    }
  };
  const inlineBox = inlineSearch && (
    <div
      className={`team-explorer-search${boxOverPath ? ' is-over-path' : ''}`}
      {...{ [EXPLORER_SEARCH_ATTRIBUTE]: '' }}
      onKeyDownCapture={searchKeys}
    >
      <SearchField
        aria-label={t('teamExplorerSearchOpen')}
        placeholder={t('teamExplorerSearchPlaceholder')}
        value={inlineSearch.value}
        onChange={inlineSearch.onChange}
        onSubmit={text => {
          if (text.trim() !== '') inlineSearch.onToResults();
        }}
      />
      {/* The key that puts the caret here, as ⌘K sits in «Знайти ⌘K»: in the box's end,
          while the box is empty — not in the placeholder's words. */}
      {inlineSearch.value === '' && (
        <kbd className="team-explorer-search-key" aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </div>
  );

  return (
    <div ref={row} className="team-explorer-toolbar" data-fit={fit}>
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
      ) : boxOverPath ? (
        <>
          {inlineBox}
          <IconButton label={t('teamExplorerSearchClose')} title="" onClick={closeBox}>
            <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </>
      ) : (
        <Breadcrumb
          before={
            <>
              {arrowsInRow && <FolderHistoryButtons history={history} />}
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
              {/* The search «Показати в папці» came from, one press away (070, T023). */}
              {backToResults && (
                <Button
                  variant="ghost"
                  className="team-explorer-back-to-results"
                  leading={<ArrowLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
                  title={t('teamExplorerBackToResultsFor', { query: backToResults.query })}
                  onClick={backToResults.onBack}
                >
                  {t('teamExplorerBackToResults')}
                </Button>
              )}
            </>
          }
        />
      )}
      {!trash && inline ? (
        boxOverPath ? null : searchBox ? (
          inlineBox
        ) : searchInRow ? (
          <IconButton
            label={t('teamExplorerSearchOpen')}
            title={`${t('teamExplorerSearchOpen')} · ${shortcut}`}
            onClick={openBox}
          >
            <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        ) : null
      ) : (
        !trash &&
        (searching ? (
          searchBox ? (
            <Button variant="secondary" className="team-explorer-search" onClick={onCloseSearch}>
              {t('teamExplorerSearchClose')}
            </Button>
          ) : (
            /* The way out of the search keeps its place; a × is one of the obvious actions. */
            <IconButton label={t('teamExplorerSearchClose')} title="" onClick={onCloseSearch}>
              <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          )
        ) : searchBox ? (
          <div className="team-explorer-search" {...{ [EXPLORER_SEARCH_ATTRIBUTE]: '' }}>
            <SearchField
              aria-label={t('teamExplorerSearchOpen')}
              placeholder={t('teamExplorerSearchPlaceholder')}
              value={draft}
              onChange={setDraft}
              onSubmit={text => {
                setDraft('');
                onOpenSearch(text.trim());
              }}
            />
            {draft === '' && (
              <kbd className="team-explorer-search-key" aria-hidden="true">
                {shortcut}
              </kbd>
            )}
          </div>
        ) : searchInRow ? (
          /* Too narrow for a box: its magnifier, with the box's name and its key. */
          <IconButton
            label={t('teamExplorerSearchOpen')}
            title={`${t('teamExplorerSearchOpen')} · ${shortcut}`}
            onClick={() => onOpenSearch('')}
          >
            <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        ) : null)
      )}
      <div className="team-explorer-toolbar-actions">
        {canUpload && !trash && (
          <>
            {/* The picker for files; the menu item opens it through the ref. */}
            <FileTrigger ref={filePicker} onSelect={onPickFiles} />
            {fit === 'tight' ? (
              /* A phone's row has room for the folder you are in or for the word, not both:
                 the primary keeps its colour and its name, as Drive's "+" does. */
              <IconButton
                color="primary"
                variant="solid"
                label={t('teamExplorerUpload')}
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                onClick={event => onOpenAddMenu(event.currentTarget)}
              >
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
            ) : (
              <Button
                variant="primary"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                trailing={<ChevronDown size={16} strokeWidth={ICON_STROKE} />}
                onClick={event => onOpenAddMenu(event.currentTarget)}
              >
                {t('teamExplorerUpload')}
              </Button>
            )}
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
          </>
        )}
        {!trash && viewInRow && (
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
        {!trash && (
          <MoreMenu
            items={[
              ...collapsedActions({
                t,
                history: arrowsInRow ? null : history,
                search:
                  searchInRow || boxOverPath || (searching && !inline)
                    ? null
                    : inline
                      ? openBox
                      : () => onOpenSearch(''),
                view: viewInRow ? null : { value: view, onChange: onViewChange }
              }),
              ...moreActions({
                t,
                searching,
                resync,
                process,
                canUpload,
                onOpenTrash
              })
            ]}
          />
        )}
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

/** The room, in pixels, of the controls the row holds only sometimes (T014). */
const SOMETIMES_PX = { treeToggle: 52, backToTask: 128 };

/**
 * What left the row for lack of room (T014), first in "…" and in words: the search, the
 * arrows (only the steps there are), and the view as two choices of one question.
 */
function collapsedActions({
  t,
  history,
  search,
  view
}: {
  t: Translate;
  history: FolderHistory | null;
  search: (() => void) | null;
  view: { value: ExplorerView; onChange: (view: ExplorerView) => void } | null;
}): MenuEntry[] {
  const moves: MenuEntry[] = [];
  if (search) {
    moves.push({
      id: 'search',
      label: t('teamExplorerSearchOpen'),
      icon: <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      onSelect: search
    });
  }
  if (history?.canBack) {
    moves.push({
      id: 'back',
      label: t('teamExplorerHistoryBack'),
      icon: <ChevronLeft size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      onSelect: history.back
    });
  }
  if (history?.canForward) {
    moves.push({
      id: 'forward',
      label: t('teamExplorerHistoryForward'),
      icon: <ChevronRight size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      onSelect: history.forward
    });
  }
  const entries: MenuEntry[] = [...moves];
  if (view) {
    if (entries.length > 0) entries.push('separator');
    entries.push(
      { heading: t('teamExplorerViewLabel') },
      {
        id: 'view-list',
        label: t('teamExplorerViewList'),
        icon: <List size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        checked: view.value === 'list',
        onSelect: () => view.onChange('list')
      },
      {
        id: 'view-grid',
        label: t('teamExplorerViewGrid'),
        icon: <LayoutGrid size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        checked: view.value === 'grid',
        onSelect: () => view.onChange('grid')
      }
    );
  }
  if (entries.length > 0) entries.push('separator');
  return entries;
}

/**
 * What the "…" holds (070, FR-004): the work that is rare here, each with its name. The Drive
 * scan says when one is already running instead of starting a second; processing and
 * compressing take this folder (processing at the root takes the space); the trash is always
 * one press away.
 */
function moreActions({
  t,
  searching,
  resync,
  process,
  canUpload,
  onOpenTrash
}: {
  t: Translate;
  searching: boolean;
  resync: ExplorerToolbarResync | null;
  process: ExplorerToolbarProcess | null;
  canUpload: boolean;
  onOpenTrash: () => void;
}): MenuEntry[] {
  const work: MenuEntry[] = [];
  if (resync && canUpload) {
    work.push({
      id: 'sync',
      label: resync.busy
        ? t('teamExplorerMenuSyncRunning')
        : resync.inFolder
          ? t('teamExplorerMenuSyncFolder')
          : t('teamExplorerMenuSyncSpace'),
      icon: <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      // Present and explained, not dead: the panel under the toolbar shows the running scan.
      disabled: resync.busy,
      note: resync.busy ? t('teamExplorerMenuSyncRunningNote') : undefined,
      onSelect: resync.onStart
    });
  }
  if (process && !searching) {
    const folder = process.folder;
    if (folder) {
      work.push({
        id: 'process-folder',
        label: t('teamExplorerMenuProcessFolder'),
        icon: <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        onSelect: () => process.onFolder(folder)
      });
      if (process.onCompressFolder) {
        const compress = process.onCompressFolder;
        work.push({
          id: 'compress-folder',
          label: t('teamExplorerMenuCompressFolder'),
          icon: <Shrink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
          onSelect: () => compress(folder)
        });
      }
    } else if (process.onSpace) {
      work.push({
        id: 'process-space',
        label: t('teamProcessWholeSpace'),
        icon: <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
        onSelect: process.onSpace
      });
    }
  }
  return [
    ...work,
    ...(work.length > 0 ? (['separator'] as const) : []),
    {
      id: 'trash',
      label: t('teamTrashEntry'),
      icon: <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      onSelect: onOpenTrash
    }
  ];
}

/** The row's "…": an icon with a name, opening the inventory's menu. */
function MoreMenu({ items }: { items: MenuEntry[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        className="team-explorer-more"
        label={t('teamExplorerMoreActions')}
        /* An obvious "…" carries no tooltip (docs/DESIGN.md); the name stays. */
        title=""
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        label={t('teamExplorerMoreActions')}
        items={items}
      />
    </>
  );
}
