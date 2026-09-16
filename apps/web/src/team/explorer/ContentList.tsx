import type { ReactNode } from 'react';
import type { TeamMaterialRow, TeamMaterialTagColor } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import {
  EmptyState,
  ErrorState,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';
import { FolderOpen } from 'lucide-react';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useI18n } from '../../i18n';
import { formatDate, formatSize } from '../../format';
import { DRAG_TYPE, KIND_LABEL, KIND_REASON, PREVIEWABLE_KINDS, previewSummary } from './rowKinds';
import { useExplorer } from './ExplorerProvider';
import { MorePages } from './MorePages';
import type { FolderPageState } from './useFolderPage';
import { KindIcon } from './KindIcon';
import { KindNote } from './KindNote';
import { RowActions, type RowActionsProps } from './RowActions';
import { TagDot } from './TagDot';

/** Setting a tag is the space owner's; everyone else is handed nothing. */
export interface TaggingProps {
  canTag: true;
  onSetTag: (row: TeamMaterialRow, color: TeamMaterialTagColor | null) => void;
}

/**
 * The open folder's rows (011, FR-009/FR-010): first screen and total at once,
 * more on request, folders first. Every row shows its kind; a kind Soty cannot
 * open says why instead of pretending.
 */
export function ContentList({
  page,
  rows = page.rows,
  onPreview,
  actions,
  tagging,
  emptyAction
}: {
  /** The folder's rows, held by the shell so one listing serves everything. */
  page: FolderPageState;
  /**
   * The rows to draw, already in order (024).
   *
   * The shell sorts once — it has to, because the arrow keys walk the list in
   * the order the reader sees — and this used to sort the same array again on
   * every render with the same comparator. Two sorts that agreed by accident:
   * the day they stopped agreeing, Down would have moved to a different row
   * from the one below.
   *
   * Defaults to the page's own rows so this view can still be rendered on its
   * own — by a test, or by a surface that has no sort of its own — without
   * having to know what order the shell would have put them in.
   */
  rows?: readonly TeamMaterialRow[];
  onPreview?: (material: TeamMaterialSummary) => void;
  /** Per-row file actions; absent when the member may do nothing (011, FR-025). */
  actions?: RowActionsProps;
  /** Present only for the space's owner (011). */
  tagging?: TaggingProps;
  /**
   * The control that fills an empty folder — the shell's own Add files, since
   * that is where the file input lives. Absent for a member who may not upload,
   * which is the same rule as the toolbar's (FR-021, FR-004).
   */
  emptyAction?: ReactNode;
}) {
  const { t } = useI18n();
  const { openFolder, selectedId, select, selectedIds, toggleSelected } = useExplorer();
  /*
   * The page comes from the shell, which is the only place that can hold it:
   * this component used to run its own `useFolderPage` with the same arguments,
   * so every folder was listed twice and only this copy ever paged. Everything
   * the shell decides — the preview pane, the arrow keys, Delete, the upload's
   * name-clash check — read the shell's copy, which stopped at the first
   * hundred rows and never grew.
   */

  return (
    <section className="team-explorer-content" aria-labelledby="team-explorer-content-title">
      <div className="team-explorer-content-heading">
        <h2 id="team-explorer-content-title" className="visually-hidden">
          {t('teamMaterials')}
        </h2>
        {page.total !== null && page.total > 0 && (
          <p className="team-explorer-total" aria-live="polite">
            {t('teamExplorerTotal', { count: page.total })}
          </p>
        )}
      </div>
      {page.loading && page.rows.length === 0 && (
        <LabeledSkeleton label="teamMaterialsLoading" rows={4} />
      )}
      {page.error && <ErrorState message={t('teamExplorerLoadFailed')} />}
      {/* One sentence, centred in a content area that keeps its shape. It was
          "Елементів: 0" and "Ця папка порожня." stacked flush left, saying the
          same thing twice above a card that had collapsed to a strip. */}
      {!page.loading && !page.error && page.rows.length === 0 && (
        <EmptyState
          className="team-explorer-empty"
          icon={<FolderOpen size={26} strokeWidth={ICON_STROKE} aria-hidden="true" />}
          title={t('teamExplorerEmpty')}
          action={emptyAction}
        />
      )}
      {rows.length > 0 && (
        <Table
          size="sm"
          className="team-explorer-rows"
          aria-labelledby="team-explorer-content-title"
        >
          {/* The columns were ruled to read as a table before they were one;
              now they are named, so a reader arriving at "17.2 MB" is told
              which column that is. */}
          <TableHeader>
            <TableHeaderCell className="team-explorer-row-check" />
            <TableHeaderCell className="team-explorer-row-name">
              {t('teamExplorerSortName')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-kind">
              {t('teamExplorerPaneKind')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-date">
              {t('teamExplorerSortModified')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-meta">
              {t('teamExplorerPaneSize')}
            </TableHeaderCell>
            {actions && (
              <TableHeaderCell className="team-explorer-row-actions">
                {/* Named for a screen reader; a sighted reader sees the "…" (Drive
                    does not caption its row actions either). */}
                <span className="visually-hidden">{t('teamAccountColumnActions')}</span>
              </TableHeaderCell>
            )}
          </TableHeader>
          {rows.map(row => (
            <Row
              key={row.id}
              row={row}
              selected={selectedId === row.id}
              checked={selectedIds.has(row.id)}
              onSelect={select}
              onToggle={toggleSelected}
              onOpenFolder={openFolder}
              onPreview={onPreview}
              actions={actions}
              tagging={tagging}
            />
          ))}
        </Table>
      )}
      <MorePages
        hasMore={page.hasMore}
        loading={page.loading}
        onLoadMore={() => void page.loadMore()}
      />
    </section>
  );
}

function Row({
  row,
  selected,
  checked,
  onSelect,
  onToggle,
  onOpenFolder,
  onPreview,
  actions,
  tagging
}: {
  row: TeamMaterialRow;
  selected: boolean;
  checked: boolean;
  onSelect: (materialId: string | null) => void;
  onToggle: (row: TeamMaterialRow) => void;
  onOpenFolder: (folderId: string) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
  tagging?: TaggingProps;
}) {
  const { t, language } = useI18n();
  const reason = KIND_REASON[row.kind];
  const previewable = PREVIEWABLE_KINDS.has(row.kind);
  const open = () => {
    if (row.kind === 'folder') onOpenFolder(row.driveFileId);
    else if (previewable) onPreview?.(previewSummary(row));
  };
  return (
    <TableRow
      /*
       * Two states, said two ways (024, FR-092). `selected` is where you are —
       * one row, the one the pane is describing and the arrows move from.
       * `is-checked` is what you are about to act on, which can be forty rows
       * and most of them off screen. The list said the second one only on the
       * tick box, so a checked row you had scrolled past looked exactly like a
       * row nobody had touched.
       */
      className={`team-explorer-row is-${row.kind}${checked ? ' is-checked' : ''}`}
      data-material-id={row.id}
      selected={selected}
      interactive
      draggable={row.kind !== 'folder'}
      onDragStart={event => {
        event.dataTransfer.setData(DRAG_TYPE, row.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      /*
       * A file manager's own grammar: one press selects, two open. The name
       * used to be a button — a highlighted, underlined strip across most of
       * the row — so selecting a row meant finding the gap beside it, and every
       * press that missed opened something. The row is the target now, and
       * opening asks for the second press. Enter does it from the keyboard
       * (the shell's own handler), which is why nothing here is focusable.
       */
      /*
       * One grammar, in both views and for every row (024, FR-091): a press
       * selects, a second press opens — a folder too. Enter opens from the
       * keyboard (the shell's handler).
       */
      onClick={() => onSelect(row.id)}
      onDoubleClick={open}
    >
      <TableCell className="team-explorer-row-check">
        <label
          className="team-explorer-check"
          onClick={event => event.stopPropagation()}
          title={t('teamExplorerSelectNamed', { name: row.name })}
        >
          <input
            type="checkbox"
            aria-label={t('teamExplorerSelectNamed', { name: row.name })}
            checked={checked}
            onChange={() => onToggle(row)}
          />
          <span aria-hidden="true" />
        </label>
      </TableCell>
      <TableCell className="team-explorer-row-name">
        <KindIcon kind={row.kind} />{' '}
        <button
          type="button"
          className="team-explorer-row-open"
          /* The name selects like the rest of the row, and opens on the
             second press like the rest of the row (024): it used to open on
             the first, so the same row did two things depending on where the
             press landed. */
          onClick={event => {
            event.stopPropagation();
            onSelect(row.id);
          }}
          onDoubleClick={event => {
            event.stopPropagation();
            open();
          }}
        >
          {row.name}
        </button>
        {/* The colour mark belongs to the file, so it follows the file's name,
            as Finder's does (the owner, 024). Beside the size it read as part of
            the size. */}
        <TagDot
          color={row.tagColor ?? null}
          name={row.name}
          canTag={Boolean(tagging)}
          onChange={color => tagging?.onSetTag(row, color)}
        />
        {/* A fact about the kind, not about this file: an icon that says it on
            hover and focus, rather than a second line under every such row. */}
        {reason && <KindNote text={t(reason)} />}
      </TableCell>
      <TableCell className="team-explorer-row-kind">{t(KIND_LABEL[row.kind])}</TableCell>
      <TableCell className="team-explorer-row-date">
        {formatDate(row.modifiedAt, language)}
      </TableCell>
      {/* The tag rides with the size, on the far side of it — the last thing
          before the row's own buttons, which is where the eye already ends its
          run across the row. */}
      <TableCell className="team-explorer-row-meta">
        {row.sizeBytes !== null && row.kind !== 'folder' ? formatSize(row.sizeBytes) : ''}
      </TableCell>
      {actions && (
        <TableCell className="team-explorer-row-actions" onClick={event => event.stopPropagation()}>
          {/* Share lives in the menu beside copy-link (024, FR-093): a share
              icon next to a "…" that also shares was the same action twice on
              every row. */}
          <RowActions {...actions} row={row} />
        </TableCell>
      )}
    </TableRow>
  );
}
