import type { TeamMaterialRow, TeamMaterialTagColor } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useI18n } from '../../i18n';
import { formatDate, formatSize } from '../../format';
import { DRAG_TYPE, KIND_LABEL, KIND_REASON, PREVIEWABLE_KINDS, previewSummary } from './rowKinds';
import { useExplorer } from './ExplorerProvider';
import { sortRows, DEFAULT_SORT, type ExplorerSort } from './sort';
import type { FolderPageState } from './useFolderPage';
import { KindIcon } from './KindIcon';
import { RowActions, type RowActionsProps } from './RowActions';
import { ShareButton } from './ShareButton';
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
  onPreview,
  actions,
  sort,
  tagging
}: {
  /** The folder's rows, held by the shell so one listing serves everything. */
  page: FolderPageState;
  onPreview?: (material: TeamMaterialSummary) => void;
  /** Per-row file actions; absent when the member may do nothing (011, FR-025). */
  actions?: RowActionsProps;
  sort?: ExplorerSort;
  /** Present only for the space's owner (011). */
  tagging?: TaggingProps;
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
  const rows = sortRows(page.rows, sort ?? DEFAULT_SORT);

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
      {page.error && <p className="team-inline-error">{t('teamExplorerLoadFailed')}</p>}
      {/* One sentence, centred in a content area that keeps its shape. It was
          "Елементів: 0" and "Ця папка порожня." stacked flush left, saying the
          same thing twice above a card that had collapsed to a strip. */}
      {!page.loading && !page.error && page.rows.length === 0 && (
        <p className="team-explorer-empty">{t('teamExplorerEmpty')}</p>
      )}
      <ul className="team-explorer-rows">
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
      </ul>
      {page.hasMore && (
        <Button
          type="button"
          variant="secondary"
          loading={page.loading}
          onClick={() => void page.loadMore()}
        >
          {t('teamExplorerLoadMore')}
        </Button>
      )}
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
  return (
    <li
      className={`team-explorer-row is-${row.kind}${selected ? ' is-selected' : ''}`}
      aria-selected={selected}
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
      onClick={() => onSelect(row.id)}
      onDoubleClick={() => {
        if (row.kind === 'folder') onOpenFolder(row.driveFileId);
        else if (previewable) onPreview?.(previewSummary(row));
      }}
    >
      <label
        className="team-explorer-check team-explorer-row-check"
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
      <span className="team-explorer-row-name">
        <KindIcon kind={row.kind} /> {row.name}
      </span>
      <span className="team-explorer-row-kind">{t(KIND_LABEL[row.kind])}</span>
      <span className="team-explorer-row-date">{formatDate(row.modifiedAt, language)}</span>
      {/* The tag rides with the size, on the far side of it — the last thing
          before the row's own buttons, which is where the eye already ends its
          run across the row. */}
      <span className="team-explorer-row-meta">
        {row.sizeBytes !== null && row.kind !== 'folder' ? formatSize(row.sizeBytes) : ''}
        <TagDot
          color={row.tagColor ?? null}
          name={row.name}
          canTag={Boolean(tagging)}
          onChange={color => tagging?.onSetTag(row, color)}
        />
      </span>
      {actions && (
        <div className="team-explorer-row-actions" onClick={event => event.stopPropagation()}>
          <ShareButton teamId={actions.teamId} row={row} />
          <RowActions {...actions} row={row} />
        </div>
      )}
      {reason && <span className="team-explorer-row-reason">{t(reason)}</span>}
    </li>
  );
}
