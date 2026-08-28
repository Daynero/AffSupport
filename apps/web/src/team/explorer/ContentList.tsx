import type { TeamMaterialRow, TeamMaterialRowKind } from '@video-compressor/shared';
import type { TeamMaterialSummary } from '../../api/team';
import { Button } from '../../components/ui';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useI18n } from '../../i18n';
import { formatSize } from '../../format';
import {
  DRAG_TYPE,
  KIND_ICON,
  KIND_LABEL,
  KIND_REASON,
  PREVIEWABLE_KINDS,
  previewSummary
} from './rowKinds';
import { useExplorer } from './ExplorerProvider';
import { useFolderPage, type FolderPageClient } from './useFolderPage';
import { RowActions, type RowActionsProps } from './RowActions';

/**
 * The open folder's rows (011, FR-009/FR-010): first screen and total at once,
 * more on request, folders first. Every row shows its kind; a kind Soty cannot
 * open says why instead of pretending.
 */
export function ContentList({
  client,
  revision = 0,
  kinds,
  onPreview,
  actions
}: {
  client: FolderPageClient;
  revision?: number;
  kinds?: TeamMaterialRowKind[];
  onPreview?: (material: TeamMaterialSummary) => void;
  /** Per-row file actions; absent when the member may do nothing (011, FR-025). */
  actions?: RowActionsProps;
}) {
  const { t } = useI18n();
  const { teamId, currentFolderId, openFolder, selectedId, select, selectedIds, toggleSelected } =
    useExplorer();
  const page = useFolderPage({ teamId, client, parentFolderId: currentFolderId, kinds, revision });

  return (
    <section className="team-explorer-content" aria-labelledby="team-explorer-content-title">
      <div className="team-explorer-content-heading">
        <h2 id="team-explorer-content-title" className="visually-hidden">
          {t('teamMaterials')}
        </h2>
        {page.total !== null && (
          <p className="team-explorer-total" aria-live="polite">
            {t('teamExplorerTotal', { count: page.total })}
          </p>
        )}
      </div>
      {page.loading && page.rows.length === 0 && (
        <LabeledSkeleton label="teamMaterialsLoading" rows={4} />
      )}
      {page.error && <p className="team-inline-error">{t('teamExplorerLoadFailed')}</p>}
      {!page.loading && !page.error && page.rows.length === 0 && (
        <p className="team-explorer-muted">{t('teamExplorerEmpty')}</p>
      )}
      <ul className="team-explorer-rows">
        {page.rows.map(row => (
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
  actions
}: {
  row: TeamMaterialRow;
  selected: boolean;
  checked: boolean;
  onSelect: (materialId: string | null) => void;
  onToggle: (materialId: string) => void;
  onOpenFolder: (folderId: string) => void;
  onPreview?: (material: TeamMaterialSummary) => void;
  actions?: RowActionsProps;
}) {
  const { t } = useI18n();
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
      onClick={() => onSelect(row.id)}
    >
      <input
        type="checkbox"
        className="team-explorer-row-check"
        aria-label={t('teamExplorerSelectNamed', { name: row.name })}
        checked={checked}
        onClick={event => event.stopPropagation()}
        onChange={() => onToggle(row.id)}
      />
      {row.kind === 'folder' ? (
        <button
          type="button"
          className="team-explorer-row-name"
          onClick={() => onOpenFolder(row.driveFileId)}
        >
          <span aria-hidden="true">{KIND_ICON.folder}</span> {row.name}
        </button>
      ) : (
        <button
          type="button"
          className="team-explorer-row-name"
          disabled={!previewable || !onPreview}
          onClick={() => onPreview?.(previewSummary(row))}
        >
          <span aria-hidden="true">{KIND_ICON[row.kind]}</span> {row.name}
        </button>
      )}
      <span className="team-explorer-row-kind">{t(KIND_LABEL[row.kind])}</span>
      <span className="team-explorer-row-meta">
        {row.sizeBytes !== null && row.kind !== 'folder' ? formatSize(row.sizeBytes) : ''}
      </span>
      {actions && row.kind !== 'folder' && (
        <div className="team-explorer-row-actions" onClick={event => event.stopPropagation()}>
          <RowActions {...actions} row={row} />
        </div>
      )}
      {reason && <span className="team-explorer-row-reason">{t(reason)}</span>}
    </li>
  );
}
