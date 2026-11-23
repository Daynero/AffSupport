import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Download,
  ListChecks,
  ListPlus,
  MoreHorizontal,
  Play,
  Shrink,
  Trash2,
  X
} from 'lucide-react';
import type { TeamMaterialRow, TeamPermissions } from '@video-compressor/shared';
import { DropdownMenu } from '../../components/ui/index';
import type { MenuItem } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import type { LibraryBatchScope } from '../library/ProcessLibraryDialog';
import type { useOptionalAddToTask } from '../tasks/AddToTask';
import { BATCH_SCOPE_LIMIT } from './FolderScopeDialog';
import type { CompressPlanItem } from './TeamCompressorDialog';

/**
 * What to do with a selection (070, FR-001, out of `ExplorerShell`): the count, the way out,
 * select-all, and the acts a selection takes — three in words, the rest under "…".
 */
export function ExplorerSelection({
  selectedRows,
  selectedIds,
  rows,
  sortedRows,
  currentFolderId,
  permissions,
  onClear,
  onSelectAll,
  onCreateTaskFromSelection,
  onProcessSelection,
  trashRows,
  addToTask,
  onCompress,
  deliverRestitched
}: {
  /** The selection, across folders. */
  selectedRows: TeamMaterialRow[];
  selectedIds: ReadonlyMap<string, unknown>;
  /** The rows of the open folder that are loaded. */
  rows: TeamMaterialRow[];
  /** Those rows as the list shows them, which select-all takes. */
  sortedRows: TeamMaterialRow[];
  currentFolderId: string | null;
  permissions: TeamPermissions | null;
  onClear: () => void;
  onSelectAll: () => void;
  onCreateTaskFromSelection?: (assets: Array<{ id: string; name: string }>) => void;
  onProcessSelection?: (materialIds: string[], scope?: LibraryBatchScope) => void;
  trashRows: (rows: TeamMaterialRow[]) => Promise<void>;
  addToTask: ReturnType<typeof useOptionalAddToTask>;
  onCompress: (items: CompressPlanItem[]) => void;
  deliverRestitched: (rows: TeamMaterialRow[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  /* The videos in the selection, once: three of the bar's actions ask for exactly this
     and one of them decides whether it is offered at all. */
  const selectedVideos = useMemo(
    () => selectedRows.filter(row => row.category === 'video'),
    [selectedRows]
  );
  /*
   * What the batch can actually take. A folder, a transcript or an image can be
   * checked like anything else, and passing those on gave a window titled
   * "Обробка: обрано 1" that scanned nothing and then said "everything is
   * already current" — which reads as done, not as "not a thing I process".
   */
  /*
   * How many of the selection are not on screen — measured against the rows
   * shown, not against the folder id.
   *
   * At the root `currentFolderId` is null while every row carries the drive's
   * real root id, so comparing ids called three tiles in plain view "3 з інших
   * папок". This is also the truer sentence: a selected row hidden by a kind
   * filter, or waiting behind "Показати ще", is out of sight wherever it lives.
   */
  const elsewhere = useMemo(
    () => selectedRows.filter(row => !rows.some(shown => shown.id === row.id)).length,
    [rows, selectedRows]
  );
  const processableRows = useMemo(
    () => selectedRows.filter(row => row.category === 'video' || row.category === 'landing'),
    [selectedRows]
  );
  if (selectedRows.length === 0) return null;
  /*
   * What to do with a selection, in the compressor's idiom.
   *
   * It was five full-width buttons of prose that wrapped onto three lines above the
   * files and pushed them down the page — the bar meant to help was the widest thing
   * on the screen. Each action is now the icon it already has elsewhere in this
   * workspace, named on hover and to a screen reader; the count leads, and the way out
   * sits at the far end where a dismissal belongs.
   */
  return (
    <div
      className="team-explorer-selection-bar"
      role="region"
      /* A static name: it used to be the same string as the count beside
               it, so a screen reader said "Обрано: 3" twice on entry. */
      aria-label={t('teamExplorerSelectionRegion')}
    >
      {/* The way out leads, as a bare cross, the way Drive and Gmail draw
                it: at the far end, in words, it repeated the count beside it and
                took the room the bin's own label needed, which then scrolled
                out of sight. Its name still carries the count for a reader. */}
      <SelectionAction
        iconOnly
        label={t('teamExplorerClearSelectionCount', { count: selectedRows.length })}
        onClick={onClear}
      >
        <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </SelectionAction>
      <span className="team-explorer-selection-count">
        {t('teamExplorerSelectedCount', { count: selectedRows.length })}
        {/* The selection survives walking into another folder, which is
                  what makes it useful and what makes the bin a surprise: three
                  of the five being acted on can be two folders back. */}
        {elsewhere > 0 && (
          <span className="team-explorer-selection-elsewhere">
            {t('teamExplorerSelectedElsewhere', { count: elsewhere })}
          </span>
        )}
      </span>
      {sortedRows.some(row => !selectedIds.has(row.id)) && (
        <SelectionAction label={t('selectAll')} onClick={onSelectAll}>
          <ListChecks size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </SelectionAction>
      )}
      <div className="team-explorer-selection-actions">
        {onCreateTaskFromSelection && (
          <SelectionAction
            label={t('teamExplorerCreateTaskFromSelection')}
            onClick={() =>
              onCreateTaskFromSelection(selectedRows.map(row => ({ id: row.id, name: row.name })))
            }
          >
            <ListPlus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </SelectionAction>
        )}
        {/*
         * The selection, whatever its size. This used to say "Process…"
         * over four files and quietly start work on the entire space —
         * the selection was never passed anywhere — so it was cut back
         * to one file. Now the ids travel with the press, and the count
         * in the label is the count of files the batch can take.
         */}
        {onProcessSelection && permissions?.process && processableRows.length > 0 && (
          <SelectionAction
            primary
            label={
              processableRows.length === 1
                ? t('teamExplorerProcessSelection')
                : t('teamExplorerProcessSelectionMany', { count: processableRows.length })
            }
            onClick={() => {
              /* The same bound the folder path already respects: the
                       scan and the claim refuse a scope over five hundred, and
                       the selection survives folder changes, so it can get
                       there. Refused here, it is a sentence; refused by the
                       RPC, it is "Частина даних некоректна" in a window with
                       no fields. */
              if (processableRows.length > BATCH_SCOPE_LIMIT) {
                push({
                  tone: 'error',
                  text: t('teamBatchFolderTooMany', {
                    count: processableRows.length,
                    limit: BATCH_SCOPE_LIMIT
                  })
                });
                return;
              }
              onProcessSelection(
                processableRows.map(row => row.id),
                {
                  kind: 'selection',
                  count: processableRows.length,
                  ...(processableRows.length < selectedRows.length
                    ? { picked: selectedRows.length }
                    : {})
                }
              );
            }}
          >
            <Play size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </SelectionAction>
        )}
        {permissions?.delete && (
          <SelectionAction
            label={t('teamFileTrash')}
            destructive
            onClick={() => void trashRows(selectedRows)}
          >
            <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </SelectionAction>
        )}
        {/* Three acts in words, the rest under "…" — Linear's and
                  Airtable's bulk bars. With a video in the selection the bar
                  held six worded acts, the last cut mid-word and the rest a
                  sideways scroll nobody knew to try. */}
        <SelectionMore
          label={t('teamTaskCardMore')}
          items={[
            ...(addToTask
              ? [
                  {
                    id: 'add-to-task',
                    label: t('materialActionAddToTask'),
                    icon: (
                      <ListChecks size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    ),
                    onSelect: () =>
                      addToTask(selectedRows.map(row => ({ id: row.id, name: row.name })))
                  }
                ]
              : []),
            ...(permissions?.process && selectedVideos.length > 0
              ? [
                  {
                    id: 'compress',
                    label: t('teamCompressSelected'),
                    icon: <Shrink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />,
                    onSelect: () =>
                      onCompress(
                        selectedVideos.map(row => ({
                          id: row.id,
                          name: row.name,
                          folderId: row.parentFolderId ?? currentFolderId ?? null
                        }))
                      )
                  }
                ]
              : []),
            ...(permissions?.download && selectedVideos.length > 0
              ? [
                  {
                    id: 'download-restitched',
                    label: t('teamRestitchDownloadRestitched'),
                    icon: (
                      <Download size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    ),
                    onSelect: () => void deliverRestitched(selectedVideos)
                  }
                ]
              : [])
          ]}
        />
      </div>
    </div>
  );
}

/** The bar's "…": the acts a selection needs less often, one press away. */
function SelectionMore({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="team-explorer-selection-action is-icon"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={label}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>
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

/**
 * One action on the selection: an icon, and its name where a name belongs.
 *
 * The bar used to spell each of these out in a button, and at the content column's width the
 * five of them wrapped onto three lines above the files. The names have not gone anywhere —
 * they are the tooltip and the accessible label, exactly as on a file's own card.
 */
function SelectionAction({
  label,
  onClick,
  destructive,
  primary,
  iconOnly,
  children
}: {
  label: string;
  onClick: () => void;
  /** Drawn as its icon alone; the name stays for a reader and the tooltip. */
  iconOnly?: boolean;
  /** The one that throws things away; coloured apart from the rest. */
  destructive?: boolean;
  /** The action this screen exists for; it keeps its word at any width. */
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`team-explorer-selection-action ${destructive ? 'is-destructive' : ''} ${
        primary ? 'is-primary' : ''
      } ${iconOnly ? 'is-icon' : ''}`.trim()}
      aria-label={label}
      data-tip={label}
      onClick={onClick}
    >
      {children}
      {/* The word is in the markup and only CSS takes it away, and only where
          the bar runs out of room. Five unlabelled icons — one of them a bin —
          asked people to guess, with four hundred pixels of the bar unused. */}
      {!iconOnly && <span className="team-explorer-selection-action-label">{label}</span>}
    </button>
  );
}
