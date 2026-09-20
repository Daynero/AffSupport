import { useEffect, useRef, useState } from 'react';
import {
  CATALOG_FILTER_KEYS,
  MATERIAL_CATEGORIES,
  type CatalogSearchFilters,
  type CatalogSearchResponse,
  type CatalogVocabulary,
  type MaterialCategory,
  type TeamMaterialTagColor
} from '@video-compressor/shared';
import { Button } from '../../components/ui';
import { CATEGORY_LABEL } from '../explorer/rowKinds';
import { COLOR_LABEL } from '../explorer/TagDot';
import { useI18n, type TranslationKey } from '../../i18n';
import { Select } from '../../components/ui/index';

/** The filters' own names, in the reader's language — they label the chips too. */
const LABEL_KEYS: Record<Exclude<keyof CatalogSearchFilters, 'geo'>, TranslationKey> = {
  language: 'teamCatalogLanguage',
  offer: 'teamCatalogOffer',
  category: 'teamCatalogCategory',
  originalType: 'teamCatalogOriginalType',
  kind: 'teamCatalogKind',
  unfilled: 'teamCatalogMissingMetadata',
  marker: 'teamCatalogMarker'
};

const KIND_KEYS: Record<string, TranslationKey> = {
  file: 'teamCatalogFile',
  folder: 'teamCatalogFolder',
  shortcut: 'teamCatalogShortcut'
};

/** "Missing metadata" offers the three fields by their own names. */
const UNFILLED_KEYS: Record<string, TranslationKey> = {
  language: 'teamCatalogLanguage',
  offer: 'teamCatalogOffer'
};

/**
 * A MIME type read as a person would say it: `video/mp4` is "MP4", and
 * `application/vnd.google-apps.folder` is "Folder". A bare extension keeps its
 * own spelling. The raw value stays in the title, for when the short form is
 * ambiguous.
 */
function originalTypeLabel(value: string): string {
  const tail = value.split('/').pop() ?? value;
  const word = tail.split('.').pop() ?? tail;
  if (word.length === 0) return value;
  return word.length <= 6 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1);
}

export function CatalogFilters({
  filters,
  vocabulary,
  facets,
  hasContent = true,
  visibleKeys,
  onSet,
  onRemove,
  onClear
}: {
  filters: CatalogSearchFilters;
  vocabulary: CatalogVocabulary;
  /**
   * What the current result actually contains. "Original type" has no
   * dictionary to read — a space's types are whatever its files are — so its
   * options come from here, and the control was left with an empty list and
   * nothing to choose until now.
   */
  facets?: CatalogSearchResponse['facets'];
  /** Whether the catalog currently has any material to filter. */
  hasContent?: boolean;
  visibleKeys?: readonly (keyof CatalogSearchFilters)[];
  onSet: (key: keyof CatalogSearchFilters, value: string | null) => void;
  onRemove: (key: keyof CatalogSearchFilters, value: string) => void;
  onClear: () => void;
}) {
  const { t, language } = useI18n();
  const visible = new Set<keyof CatalogSearchFilters>(visibleKeys ?? CATALOG_FILTER_KEYS);
  const selections = (Object.keys(filters) as Array<keyof CatalogSearchFilters>).flatMap(key =>
    visible.has(key) ? (filters[key] as readonly string[]).map(value => ({ key, value })) : []
  );
  const usedGeo = (vocabulary as TeamVocabulary).usedGeo ?? vocabulary.geo;
  const usedMarkers = (vocabulary as TeamVocabulary).usedMarkers ?? [];
  const usedLanguages = (vocabulary as TeamVocabulary).usedLanguages ?? vocabulary.languages;
  const hasFacets = usedGeo.length > 0 || usedLanguages.length > 0 || vocabulary.offers.length > 0;
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

  /** The filter's own name, as the reader sees it in the panel and on its chip. */
  const filterLabel = (key: keyof CatalogSearchFilters) =>
    key === 'geo' ? 'GEO' : t(LABEL_KEYS[key]);

  /**
   * A value's name. Codes stay codes — GEO and language are read as `UA`, `EN`
   * — and everything drawn from a fixed set is said in words: the panel used to
   * offer `video`, `file` and `geo` to a reader who had asked for Ukrainian.
   */
  const valueLabel = (key: keyof CatalogSearchFilters, value: string) => {
    if (key === 'category') return t(CATEGORY_LABEL[value as MaterialCategory] ?? 'teamCatalogAny');
    if (key === 'kind') return KIND_KEYS[value] ? t(KIND_KEYS[value]!) : value;
    if (key === 'unfilled')
      return value === 'geo' ? 'GEO' : t(UNFILLED_KEYS[value] ?? 'teamCatalogAny');
    if (key === 'originalType') return originalTypeLabel(value);
    if (key === 'marker') return t(COLOR_LABEL[value as TeamMaterialTagColor] ?? 'teamCatalogAny');
    // Names, not codes (024): "DE" and "de" said nothing to a person picking one.
    if (key === 'geo') return displayName('region', value.toUpperCase(), language) ?? value;
    if (key === 'language') return displayName('language', value, language) ?? value;
    return value;
  };

  /* The inventory's Select (021, T098). The facet options and their localised
     labels are unchanged — what goes is this file's own idea of what a select
     looks like. */
  const select = (key: keyof CatalogSearchFilters, options: readonly string[]) => (
    /* Not a wrapping `<label>` any more: the control is a listbox with a button
       for a trigger, and a label that wraps one names nothing. The name is
       said, and the id ties it to the control the reader actually operates. */
    <div className="team-catalog-facet">
      <span id={`catalog-facet-${key}`}>{filterLabel(key)}</span>
      <Select
        aria-labelledby={`catalog-facet-${key}`}
        value={filters[key]?.[0] ?? ''}
        placeholder={t('teamCatalogAny')}
        options={options.map(option => ({
          value: option,
          label: valueLabel(key, option),
          title: option
        }))}
        onChange={next => onSet(key, next || null)}
      />
    </div>
  );

  const offered = (key: keyof CatalogSearchFilters, options: readonly string[]) =>
    visible.has(key) && options.length > 0 ? select(key, options) : null;

  /* Facet values narrow with the search, so the chosen one is kept in the list:
     without it, picking a type removed every other type and there was no way
     back to a different one. */
  const originalTypeOptions = [
    ...new Set([...(facets?.originalType ?? []).map(facet => facet.value), ...filters.originalType])
  ].sort((left, right) => originalTypeLabel(left).localeCompare(originalTypeLabel(right)));

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
        {/* Only what the space's files carry (024): a filter offering every
            country and language in the dictionary found nothing for most of
            them. The chosen value stays in the list so it can be changed. */}
        {/* A filter with nothing to find is not offered at all (the owner, 024):
            no GEO on any file, no GEO select. One already in force stays, so it
            can be taken off. */}
        {offered('geo', inUse(usedGeo, filters.geo))}
        {offered('language', inUse(usedLanguages, filters.language))}
        {offered('offer', inUse(vocabulary.offers, filters.offer))}
        {offered('marker', inUse(usedMarkers, filters.marker ?? []))}
        {visible.has('category') && select('category', MATERIAL_CATEGORIES)}
        {offered('originalType', originalTypeOptions)}
        {visible.has('kind') && select('kind', ['file', 'folder', 'shortcut'])}
        {visible.has('unfilled') && select('unfilled', ['geo', 'offer', 'language'])}
      </div>
      {selections.length > 0 && (
        <div className="team-catalog-chips" aria-label={t('teamCatalogActiveFilters')}>
          {selections.map(({ key, value }) => (
            <Button
              type="button"
              variant="ghost"
              key={`${key}:${value}`}
              aria-label={t('teamCatalogRemoveFilter', {
                label: filterLabel(key),
                value: valueLabel(key, value)
              })}
              onClick={() => onRemove(key, value)}
            >
              {filterLabel(key)}: {valueLabel(key, value)} ×
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

/** The vocabulary with what the space's files actually carry (024); absent from an older server. */
type TeamVocabulary = CatalogVocabulary & {
  usedGeo?: string[];
  usedLanguages?: string[];
  usedMarkers?: string[];
};

function inUse(used: readonly string[], chosen: readonly string[]): string[] {
  return [...new Set([...used, ...chosen])];
}

export function displayName(
  type: 'region' | 'language',
  code: string,
  language: string
): string | undefined {
  try {
    const name = new Intl.DisplayNames([language === 'uk' ? 'uk' : 'en'], { type }).of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}
