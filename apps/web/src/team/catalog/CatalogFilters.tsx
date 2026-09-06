import { useEffect, useRef, useState } from 'react';
import {
  MATERIAL_CATEGORIES,
  type CatalogSearchFilters,
  type CatalogVocabulary
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

const LABELS: Record<keyof CatalogSearchFilters, string> = {
  geo: 'GEO',
  language: 'Language',
  offer: 'Offer',
  category: 'Category',
  originalType: 'Original type',
  kind: 'Kind',
  unfilled: 'Missing metadata'
};

export function CatalogFilters({
  filters,
  vocabulary,
  hasContent = true,
  visibleKeys,
  onSet,
  onRemove,
  onClear
}: {
  filters: CatalogSearchFilters;
  vocabulary: CatalogVocabulary;
  /** Whether the catalog currently has any material to filter. */
  hasContent?: boolean;
  visibleKeys?: readonly (keyof CatalogSearchFilters)[];
  onSet: (key: keyof CatalogSearchFilters, value: string | null) => void;
  onRemove: (key: keyof CatalogSearchFilters, value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const visible = new Set<keyof CatalogSearchFilters>(
    visibleKeys ?? (Object.keys(filters) as Array<keyof CatalogSearchFilters>)
  );
  const selections = (Object.keys(filters) as Array<keyof CatalogSearchFilters>).flatMap(key =>
    visible.has(key) ? (filters[key] as readonly string[]).map(value => ({ key, value })) : []
  );
  const hasFacets =
    vocabulary.geo.length > 0 || vocabulary.languages.length > 0 || vocabulary.offers.length > 0;
  // No junk filters for an empty space: show nothing to filter unless there is
  // content or the user already has an active selection to clear.
  /* Open when something is narrowing the search, and then whatever the person
     last chose. */
  const [open, setOpen] = useState(selections.length > 0);
  const known = useRef(selections.length > 0);
  useEffect(() => {
    const active = selections.length > 0;
    if (known.current === active) return;
    known.current = active;
    if (active) setOpen(true);
  }, [selections.length]);

  if (!hasContent && !hasFacets && selections.length === 0) return null;
  const select = (key: keyof CatalogSearchFilters, options: readonly string[], label: string) => (
    <label>
      <span>{label}</span>
      <select
        value={filters[key][0] ?? ''}
        onChange={event => onSet(key, event.target.value || null)}
      >
        <option value="">{t('teamCatalogAny')}</option>
        {options.map(option => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );

  /*
   * Seven selects, all reading "Будь-яке", stood between the search box and the
   * first result — the whole panel was filters before anything was found. They
   * fold away, and open with the count of what is narrowing the search on the
   * button, so nothing is hidden that is doing something. Any active filter
   * keeps the section open, because a filter you cannot see is worse than a
   * filter you have to open.
   */
  return (
    /* `defaultOpen` has no equivalent on `details`, and a bare `open` prop React
       only re-asserts when it changes — so closing the panel by hand while a
       filter was on kept it closed, and clearing the last filter snapped a
       hand-opened panel shut. The state is this component's. */
    <details
      className="team-catalog-filter-region"
      open={open}
      onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="team-catalog-filter-summary">
        {selections.length > 0
          ? t('teamCatalogFiltersActive', { count: selections.length })
          : t('teamCatalogFiltersIdle')}
      </summary>
      <div className="team-catalog-filters">
        {visible.has('geo') && select('geo', vocabulary.geo, 'GEO')}
        {visible.has('language') &&
          select('language', vocabulary.languages, t('teamCatalogLanguage'))}
        {visible.has('offer') && select('offer', vocabulary.offers, t('teamCatalogOffer'))}
        {visible.has('category') &&
          select('category', MATERIAL_CATEGORIES, t('teamCatalogCategory'))}
        {visible.has('originalType') && select('originalType', [], t('teamCatalogOriginalType'))}
        {visible.has('kind') &&
          select('kind', ['file', 'folder', 'shortcut'], t('teamCatalogKind'))}
        {visible.has('unfilled') &&
          select('unfilled', ['geo', 'offer', 'language'], t('teamCatalogMissingMetadata'))}
      </div>
      {selections.length > 0 && (
        <div className="team-catalog-chips" aria-label={t('teamCatalogActiveFilters')}>
          {selections.map(({ key, value }) => (
            <Button
              type="button"
              variant="ghost"
              key={`${key}:${value}`}
              aria-label={t('teamCatalogRemoveFilter', { label: LABELS[key], value })}
              onClick={() => onRemove(key, value)}
            >
              {LABELS[key]}: {value} ×
            </Button>
          ))}
          <Button type="button" variant="ghost" onClick={onClear}>
            {t('teamCatalogClearAll')}
          </Button>
        </div>
      )}
    </details>
  );
}
