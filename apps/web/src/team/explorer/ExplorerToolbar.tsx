import { useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  FolderTree,
  LayoutGrid,
  List,
  MoreHorizontal,
  Play,
  RefreshCw,
  Shrink,
  Trash2
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
  onOpenTrash,
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
  onOpenTrash: () => void;
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
          </>
        )}
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
        {!trash && (
          <MoreMenu
            items={moreActions({
              t,
              searching,
              resync,
              process,
              canUpload,
              onOpenTrash
            })}
          />
        )}
      </div>
      {children}
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>['t'];

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
