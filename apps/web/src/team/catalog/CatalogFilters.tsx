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

  return (
    <div className="team-catalog-filter-region">
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
    </div>
  );
}
