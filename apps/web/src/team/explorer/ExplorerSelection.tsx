import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ListChecks, MoreHorizontal, Play } from 'lucide-react';
import type { MaterialCategory, TeamPermissions } from '@video-compressor/shared';
import { Button, DropdownMenu, IconButton, SelectionBar } from '../../components/ui/index';
import type { MenuItem } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n, type TranslationKey } from '../../i18n';
import type { useOptionalAddToTask } from '../tasks/AddToTask';
import {
  MATERIAL_ACTION_BY_ID,
  type ActionContext,
  type MaterialActionId,
  type MaterialRef
} from '../materials/actions';
import type { ProcessOrigin, ProcessableFolder, ScopeFile } from '../processing/processScope';

/**
 * The little a selection needs to know about each thing in it — met in a folder (a row) or in
 * the search's results (a catalog item), which is why it is not either of those shapes.
 */
export interface SelectedMaterial {
  id: string;
  teamId: string;
  name: string;
  kind: string;
  category: MaterialCategory | null;
  parentFolderId?: string | null;
}

/** What a selection can be handed to — the same acts in the folder and in the results. */
export interface SelectionActs<T extends SelectedMaterial> {
  permissions: TeamPermissions | null;
  onCreateTask?: (assets: Array<{ id: string; name: string }>) => void;
  addToTask: ReturnType<typeof useOptionalAddToTask>;
  /** Opens the one processing dialog on the selection (070, T062). */
  onProcess?: (origin: ProcessOrigin) => void;
  /** Opens the one compression dialog on the selection's videos (070, T062). */
  onCompress: (origin: ProcessOrigin) => void;
  onDownloadRestitched: (items: T[]) => void;
  onTrash: (items: T[]) => void;
  /** The folder open now, where a selected file's own folder is not known. */
  currentFolderId: string | null;
  /** The same folder by name, so the dialog can offer it beside the selection. */
  currentFolder?: ProcessableFolder | null;
}

/**
 * What to do with a selection (070, FR-012): the inventory's `SelectionBar`, drawn in the strip
 * above the list in place of what arranges the list — so it moves nothing when it appears, and
 * covers nothing: it used to lie over the toolbar row, which took the path, the search and
 * «Завантажити» away for as long as anything was checked.
 *
 * The acts come from the one registry with `host: 'selection'`: what applies to the checked set,
 * in the registry's icons. Three are on the bar (the ones a batch is for), the rest are named
 * under "…". An act that takes only part of the set says how many it takes.
 */
export function ExplorerSelection<T extends SelectedMaterial>({
  items,
  shownIds,
  selectable,
  elsewhereKey,
  onClear,
  onSelectAll,
  acts
}: {
  /** The selection, wherever its things live. */
  items: readonly T[];
  /** What is on screen now; the rest of the selection is "elsewhere". */
  shownIds: ReadonlySet<string>;
  /** What select-all would take; offered while some of it is not checked yet. */
  selectable: readonly { id: string }[];
  /** How "elsewhere" is said here: other folders, or outside these results. */
  elsewhereKey: TranslationKey;
  onClear: () => void;
  onSelectAll: () => void;
  acts: SelectionActs<T>;
}) {
  const { t } = useI18n();
  const checked = useMemo(() => new Set(items.map(item => item.id)), [items]);
  const elsewhere = useMemo(
    () => items.filter(item => !shownIds.has(item.id)).length,
    [items, shownIds]
  );
  const videos = useMemo(() => items.filter(item => item.category === 'video'), [items]);
  /*
   * What the batch can actually take. A folder, a transcript or an image can be checked like
   * anything else, and passing those on gave a window titled "Обробка: обрано 1" that scanned
   * nothing and then said "everything is already current".
   */
  const processable = useMemo(
    () => items.filter(item => item.category === 'video' || item.category === 'landing'),
    [items]
  );
  const { permissions } = acts;
  if (items.length === 0) return null;

  const context: ActionContext = {
    host: 'selection',
    permissions,
    isOwner: false,
    currentFolderId: acts.currentFolderId,
    agentAvailability: 'ready',
    storageConnected: true,
    restitchConfigured: true,
    catalogSettingsReady: true,
    selectionSize: items.length
  };
  /** Whether the registry offers this act on any of the selection, and lets this member run it. */
  const offers = (id: MaterialActionId, among: readonly T[] = items) => {
    const action = MATERIAL_ACTION_BY_ID.get(id);
    if (!action || among.length === 0) return false;
    return among.some(item => {
      const ref = refOf(item);
      if (!action.applies(ref, context)) return false;
      const availability = action.available(ref, context);
      // The agent and the storage are asked when the act starts; only a permission is final.
      return availability.ok || availability.reason !== 'NO_PERMISSION';
    });
  };
  const icon = (id: MaterialActionId) => {
    const Icon = MATERIAL_ACTION_BY_ID.get(id)!.icon;
    return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />;
  };
  const assets = () => items.map(item => ({ id: item.id, name: item.name }));

  const bar: ReactNode[] = [];
  if (acts.onCreateTask && offers('createTask')) {
    const create = acts.onCreateTask;
    bar.push(
      <SelectionAct
        key="create-task"
        label={t('teamExplorerCreateTaskFromSelection')}
        icon={icon('createTask')}
        onPress={() => create(assets())}
      />
    );
  }
  if (acts.onProcess && permissions?.process && processable.length > 0) {
    const run = acts.onProcess;
    bar.push(
      <SelectionAct
        key="process"
        label={
          processable.length === 1
            ? t('teamExplorerProcessSelection')
            : t('teamExplorerProcessSelectionMany', { count: processable.length })
        }
        icon={<Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        onPress={() =>
          /* The bound (500 files) is the dialog's to say now, before Start (070, T061). */
          run({
            intent: 'process',
            initial: 'selection',
            selection: processable.map(item => scopeFileOf(item, acts.currentFolderId)),
            picked: items.length,
            folder: acts.currentFolder ?? null,
            space: true
          })
        }
      />
    );
  }
  if (offers('trash')) {
    bar.push(
      <SelectionAct
        key="trash"
        destructive
        label={t('teamFileTrash')}
        icon={icon('trash')}
        onPress={() => acts.onTrash([...items])}
      />
    );
  }

  const more: MenuItem[] = [];
  if (selectable.some(item => !checked.has(item.id))) {
    more.push({
      id: 'select-all',
      label: t('selectAll'),
      icon: <ListChecks size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
      onSelect: onSelectAll
    });
  }
  if (acts.addToTask && offers('addToTask')) {
    const add = acts.addToTask;
    more.push({
      id: 'add-to-task',
      label: t('materialActionAddToTask'),
      icon: icon('addToTask'),
      onSelect: () => add(assets())
    });
  }
  if (permissions?.process && offers('compress', videos)) {
    more.push({
      id: 'compress',
      label:
        videos.length < items.length
          ? t('teamCompressSelectedVideos', { count: videos.length })
          : t('teamCompressSelected'),
      icon: icon('compress'),
      onSelect: () =>
        acts.onCompress({
          intent: 'compress',
          initial: 'selection',
          selection: videos.map(item => scopeFileOf(item, acts.currentFolderId)),
          folder: acts.currentFolder ?? null
        })
    });
  }
  if (permissions?.download && offers('downloadRestitched', videos)) {
    more.push({
      id: 'download-restitched',
      label: t('teamRestitchDownloadRestitched'),
      icon: icon('downloadRestitched'),
      onSelect: () => acts.onDownloadRestitched(videos)
    });
  }

  return (
    <SelectionBar
      className="team-explorer-selection-bar"
      count={items.length}
      toolbarLabel={t('teamExplorerSelectionRegion')}
      label={
        <>
          {t('teamExplorerSelectedCount', { count: items.length })}
          {/* The selection survives walking into another folder (and out of a search), which
              is what makes it useful and what makes the bin a surprise. */}
          {elsewhere > 0 && (
            <span className="team-explorer-selection-elsewhere">
              {t(elsewhereKey, { count: elsewhere })}
            </span>
          )}
        </>
      }
      actions={
        <>
          {bar}
          {more.length > 0 && <SelectionMore label={t('teamTaskCardMore')} items={more} />}
        </>
      }
      clearLabel={t('teamExplorerClearSelectionCount', { count: items.length })}
      onClear={onClear}
    />
  );
}

function refOf(item: SelectedMaterial): MaterialRef {
  return {
    id: item.id,
    teamId: item.teamId,
    name: item.name,
    kind: item.kind === 'folder' ? 'folder' : 'file',
    category: item.category,
    parentFolderId: item.parentFolderId ?? null,
    availability: 'ready'
  };
}

/** One act on the selection: its icon and its word — CSS takes the word only where room runs out. */
function SelectionAct({
  label,
  icon,
  onPress,
  destructive = false
}: {
  label: string;
  icon: ReactNode;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      color={destructive ? 'error' : 'neutral'}
      className="team-explorer-selection-act"
      aria-label={label}
      leading={icon}
      onClick={onPress}
    >
      <span className="team-explorer-selection-act-label ui-selection-act-label">{label}</span>
    </Button>
  );
}

/** The bar's "…": the acts a selection needs less often, named. */
function SelectionMore({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        variant="ghost"
        label={label}
        title=""
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        label={label}
        items={items}
      />
    </>
  );
}

function scopeFileOf(item: SelectedMaterial, currentFolderId: string | null): ScopeFile {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    parentFolderId: item.parentFolderId ?? currentFolderId ?? null
  };
}
