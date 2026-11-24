import type { KeyboardEvent, RefObject } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { CatalogUpdaterRow, type CatalogRowContext } from './CatalogUpdaterRow';

/** Alt+↑/↓ on a row's control moves to the same control a row up or down. */
function moveAlongColumn(event: KeyboardEvent<HTMLTableElement>) {
  if (
    !event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !['ArrowUp', 'ArrowDown'].includes(event.key)
  )
    return;
  const target = event.target as HTMLElement;
  const field = target.dataset.catalogField;
  if (!field) return;
  const row = target.closest('tr');
  const neighbor =
    event.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling;
  const next = neighbor?.querySelector<HTMLButtonElement>(`[data-catalog-field="${field}"]`);
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

/** The manager's list and what it says when it has nothing to show (070, T056). */
export function CatalogUpdaterList({
  rows,
  shown,
  rowsById,
  ctx,
  selected,
  duplicateNames,
  visibleCount,
  loading,
  failed,
  invalidRowCount,
  listRef,
  onToggle,
  onShowMore,
  onReload,
  onBrowseFiles,
  onClearFilters
}: {
  rows: readonly CatalogRegistryRow[];
  shown: readonly CatalogRegistryRow[];
  rowsById: ReadonlyMap<string, CatalogRegistryRow>;
  ctx: CatalogRowContext;
  selected: ReadonlySet<string>;
  duplicateNames: ReadonlySet<string>;
  visibleCount: number;
  loading: boolean;
  failed: boolean;
  invalidRowCount: number;
  listRef: RefObject<HTMLTableElement | null>;
  onToggle: (catalogId: string) => void;
  onShowMore: () => void;
  onReload: () => void;
  onBrowseFiles: () => void;
  onClearFilters: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="team-updater-list">
      {loading && !failed && <p className="team-updater-empty">{t('catalogUpdaterLoading')}</p>}
      {failed && loading && (
        <div className="team-inline-error" role="alert">
          {t('catalogUpdaterLoadFailed')}{' '}
          <Button type="button" size="sm" variant="ghost" onClick={onReload}>
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
      {!loading && rows.length === 0 && invalidRowCount === 0 && (
        <div className="team-updater-empty">
          <p>{t('catalogUpdaterEmpty')}</p>
          <Button variant="secondary" onClick={onBrowseFiles}>
            {t('catalogUpdaterBrowseFiles')}
          </Button>
        </div>
      )}
      {rows.length > 0 && shown.length === 0 && (
        <div className="team-updater-empty">
          <p>{t('catalogUpdaterNoMatches')}</p>
          <Button type="button" size="sm" variant="ghost" onClick={onClearFilters}>
            {t('catalogUpdaterClearFilters')}
          </Button>
        </div>
      )}
      {shown.length > 0 && (
        <table className="catalog-compact-table" ref={listRef} onKeyDown={moveAlongColumn}>
          <thead>
            <tr>
              <th aria-label={t('catalogUpdaterSelectAll')} />
              <th>
                <div className="catalog-name-heading">
                  <span>{t('catalogIconsCatalog')}</span>
                  <span>{t('catalogCreatedFilter')}</span>
                </div>
              </th>
              <th>
                <span className="catalog-video-heading">{t('catalogIconsVideo')}</span>
                {t('catalogIconsChanges')}
              </th>
              <th>{t('catalogIconsSchedule')}</th>
              <th>{t('catalogIconsLastSuccess')}</th>
              <th>{t('catalogIconsActions')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, visibleCount).map(filteredRow => {
              const row = rowsById.get(filteredRow.catalogId) ?? filteredRow;
              return (
                <CatalogUpdaterRow
                  key={row.catalogId}
                  row={row}
                  ctx={ctx}
                  selected={selected.has(row.catalogId)}
                  duplicateName={duplicateNames.has(row.name)}
                  onToggle={() => onToggle(row.catalogId)}
                />
              );
            })}
          </tbody>
        </table>
      )}
      {shown.length > visibleCount && (
        <Button type="button" size="sm" variant="ghost" onClick={onShowMore}>
          {t('catalogUpdaterShowMore', { count: shown.length - visibleCount })}
        </Button>
      )}
    </div>
  );
}
