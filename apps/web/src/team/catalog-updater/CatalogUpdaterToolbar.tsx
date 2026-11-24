import { useRef, useState } from 'react';
import { CircleHelp, History, MoreHorizontal, SlidersHorizontal, X } from 'lucide-react';
import type { CatalogRegistryRow } from '../../api/team';
import {
  Button,
  Checkbox,
  DropdownMenu,
  IconButton,
  SearchField,
  SelectMenu,
  type MenuItem
} from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { catalogSelectedCountKey, useI18n, type TranslationKey } from '../../i18n';
import { CatalogCreatedFilter } from './CatalogCreatedFilter';
import { needsAttention } from './catalogRowState';

/**
 * The catalog manager's head, its toolbar, its filters and its selection bar — out of the
 * dialog (070, T056; from 024 T131) and onto the inventory: `SearchField` instead of a hand-drawn
 * box and ×, a `Checkbox` whose `indeterminate` is a prop rather than a DOM write, and the
 * notes about the icons behind one "?".
 */

export function CatalogUpdaterHeader({
  titleId,
  rows,
  loading,
  unavailable,
  menuItems,
  onAttention,
  onClose
}: {
  titleId: string;
  rows: readonly CatalogRegistryRow[];
  loading: boolean;
  unavailable: boolean;
  menuItems: MenuItem[];
  onAttention: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const attention = rows.filter(needsAttention).length;
  return (
    <header className="team-updater-header">
      <div>
        <h2 id={titleId}>{t('catalogUpdaterTitle')}</h2>
        {/* Two facts and, when there is one, the thing to look at — pressable, because it is
            a filter (024 US14: the line used to say "needs attention" twice, once as a fact
            and once as a button). */}
        <p className="team-updater-status">
          <span>
            {loading
              ? t(unavailable ? 'catalogUpdaterUnavailable' : 'catalogUpdaterLoading')
              : t('catalogUpdaterListFacts', {
                  count: rows.length,
                  scheduled: rows.filter(row => row.updateInterval !== null).length
                })}
          </span>
          {attention > 0 && (
            <Button
              className="catalog-attention-filter"
              size="xs"
              color="warning"
              variant="soft"
              onClick={onAttention}
            >
              {t('catalogUpdaterFilterFailed')} ({attention})
            </Button>
          )}
        </p>
      </div>
      {/* The space's catalog settings — its own pictures and how new catalogs update —
          open over the manager, so closing them comes back to this list as it was. */}
      <IconButton
        ref={menuAnchor}
        variant="ghost"
        label={t('catalogUpdaterMore')}
        onClick={() => setMenuOpen(true)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <DropdownMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={menuAnchor}
        label={t('catalogUpdaterMore')}
        items={menuItems}
      />
      <IconButton variant="ghost" title="" label={t('catalogUpdaterClose')} onClick={onClose}>
        <X size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </header>
  );
}

export function CatalogUpdaterToolbar({
  searchId,
  query,
  onQuery,
  filtersOpen,
  onToggleFilters,
  activeFilters,
  createdRange,
  onCreatedRange,
  onLegend,
  legendOpen,
  recentCount,
  onRecent,
  selectAll
}: {
  searchId: string;
  query: string;
  onQuery: (query: string) => void;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  activeFilters: number;
  createdRange: { from: string; to: string };
  onCreatedRange: (range: { from: string; to: string }) => void;
  onLegend: () => void;
  legendOpen: boolean;
  recentCount: number;
  onRecent: () => void;
  /** Absent for a reader who cannot run updates: there is nothing to select for. */
  selectAll?: { checked: boolean; indeterminate: boolean; disabled: boolean; onToggle: () => void };
}) {
  const { t } = useI18n();
  return (
    <div className="team-updater-toolbar">
      {/* Escape empties a field with words in it and lets an empty one close the manager —
          the library's own behaviour, which `searchFieldEscape` used to write by hand. */}
      <SearchField
        id={searchId}
        className="team-updater-search"
        value={query}
        placeholder={t('catalogUpdaterSearch')}
        aria-label={t('catalogUpdaterSearch')}
        clearLabel={t('catalogUpdaterClearSearch')}
        onChange={onQuery}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={filtersOpen}
        leading={<SlidersHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={onToggleFilters}
      >
        {t('catalogUpdaterFilters')}
        {activeFilters > 0 && ` (${activeFilters})`}
      </Button>
      <CatalogCreatedFilter value={createdRange} onChange={onCreatedRange} />
      <Button
        className="catalog-recent-trigger"
        size="sm"
        variant="ghost"
        disabled={recentCount === 0}
        leading={<History size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={onRecent}
      >
        {t('catalogIconsRecent')} <span className="catalog-recent-count">({recentCount})</span>
      </Button>
      {/* What the icons mean, behind one "?" rather than a worded button beside the others. */}
      <IconButton
        variant="ghost"
        size="sm"
        label={t('catalogIconsHelp')}
        aria-expanded={legendOpen}
        onClick={onLegend}
      >
        <CircleHelp size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      {selectAll && (
        <Checkbox
          className="team-updater-select-all"
          checked={selectAll.checked}
          indeterminate={selectAll.indeterminate}
          disabled={selectAll.disabled}
          onChange={selectAll.onToggle}
          label={t('catalogUpdaterSelectAll')}
        />
      )}
    </div>
  );
}

const STATUS_WORD: Record<string, TranslationKey> = {
  scheduled: 'catalogUpdaterFilterScheduled',
  off: 'catalogUpdaterOff',
  updating: 'catalogUpdaterUpdatingNow',
  failed: 'catalogUpdaterFilterFailed',
  never: 'catalogUpdaterNeverUpdated'
};
const RECENCY_WORD: Record<string, TranslationKey> = {
  day: 'catalogUpdaterFilterDay',
  week: 'catalogUpdaterFilterWeek',
  older: 'catalogUpdaterFilterOlder',
  never: 'catalogUpdaterNeverUpdated'
};
const SORT_WORD: Record<string, TranslationKey> = {
  last: 'catalogUpdaterSortLast',
  createdAsc: 'catalogCreatedOldest',
  next: 'catalogUpdaterSortNext'
};

export function CatalogUpdaterFilters({
  open,
  status,
  recency,
  sortBy,
  onRecency,
  onSortBy,
  onClear
}: {
  open: boolean;
  status: string;
  recency: string;
  sortBy: string;
  onRecency: (value: string) => void;
  onSortBy: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const active = [
    status !== 'all' && `${t('catalogUpdaterFilterStatus')}: ${t(STATUS_WORD[status]!)}`,
    recency !== 'all' && `${t('catalogUpdaterFilterRecency')}: ${t(RECENCY_WORD[recency]!)}`,
    sortBy !== 'created' && t(SORT_WORD[sortBy]!)
  ].filter(Boolean);
  return (
    <>
      {open && (
        <div className="team-updater-filters" role="group" aria-label={t('catalogUpdaterFilters')}>
          <div className="team-updater-filter-field">
            <span id="catalog-recency-filter-label">{t('catalogUpdaterFilterRecency')}</span>
            <SelectMenu
              id="catalog-recency-filter"
              label={t('catalogUpdaterFilterRecency')}
              placeholder={t('catalogUpdaterFilterAll')}
              errorLabel={t('catalogUpdaterFilterRecency')}
              value={recency}
              options={[
                { value: 'all', label: t('catalogUpdaterFilterAll') },
                { value: 'day', label: t('catalogUpdaterFilterDay') },
                { value: 'week', label: t('catalogUpdaterFilterWeek') },
                { value: 'older', label: t('catalogUpdaterFilterOlder') },
                { value: 'never', label: t('catalogUpdaterNeverUpdated') }
              ]}
              onChange={onRecency}
            />
          </div>
          <div className="team-updater-filter-field">
            <span id="catalog-sort-label">{t('catalogUpdaterSort')}</span>
            <SelectMenu
              id="catalog-sort"
              label={t('catalogUpdaterSort')}
              placeholder={t('catalogUpdaterSort')}
              errorLabel={t('catalogUpdaterSort')}
              value={sortBy}
              options={[
                { value: 'created', label: t('catalogUpdaterSortCreated') },
                { value: 'createdAsc', label: t('catalogCreatedOldest') },
                { value: 'last', label: t('catalogUpdaterSortLast') },
                { value: 'next', label: t('catalogUpdaterSortNext') }
              ]}
              onChange={onSortBy}
            />
          </div>
        </div>
      )}
      {active.length > 0 && (
        <div className="team-updater-active-filters">
          <span>{active.join(' · ')}</span>
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('catalogUpdaterClearFilters')}
          </Button>
        </div>
      )}
    </>
  );
}

/** What can be done to the ticked catalogs, at the bottom of the manager. */
export function CatalogUpdaterBulkBar({
  selected,
  hidden,
  mayRun,
  canConfigure,
  pending,
  onConfigure,
  onRunNow,
  onClear
}: {
  selected: number;
  /** Ticked, and hidden by the filters now. */
  hidden: number;
  mayRun: boolean;
  canConfigure: boolean;
  pending: boolean;
  onConfigure: (mode: 'all' | 'restitch' | 'schedule') => void;
  onRunNow: () => void;
  onClear: () => void;
}) {
  const { t, language } = useI18n();
  if (selected === 0) return null;
  return (
    <footer className="team-updater-footer" role="group" aria-label={t('catalogUpdaterBulkLabel')}>
      <span aria-live="polite">
        {t(catalogSelectedCountKey(language, selected), { count: selected })}
        {hidden > 0 && ` · ${t('catalogUpdaterHiddenSelected', { count: hidden })}`}
      </span>
      {mayRun && (
        <div className="team-updater-bulk">
          {canConfigure && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => onConfigure('restitch')}
              >
                {t('catalogUpdaterRestitch')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => onConfigure('schedule')}
              >
                {t('catalogIconsSchedule')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => onConfigure('all')}
              >
                {t('catalogUpdaterConfigure')}
              </Button>
            </>
          )}
          <Button size="sm" color="success" variant="soft" onClick={onRunNow}>
            {t('catalogUpdaterNow')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('catalogUpdaterClearSelection')}
          </Button>
        </div>
      )}
    </footer>
  );
}
