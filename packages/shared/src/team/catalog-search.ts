import {
  GEO_CODES,
  LANGUAGE_CODES,
  TRANSCRIPT_INGEST_STATES,
  isRecord,
  normalizeExtension,
  normalizeMimeType,
  normalizeTeamFreeText,
  normalizeTeamTags,
  type TranscriptIngestState
} from './contract.js';
import {
  MATERIAL_CATEGORIES,
  type MaterialCategory,
  type MaterialClassificationSource,
  type MaterialKind
} from './material-category.js';

export const CATALOG_FILTER_KEYS = [
  'geo',
  'language',
  'offer',
  'category',
  'originalType',
  'kind',
  'unfilled'
] as const;
export type CatalogFilterKey = (typeof CATALOG_FILTER_KEYS)[number];
export type CatalogUnfilledField = 'geo' | 'offer' | 'language';

export interface CatalogSearchFilters {
  geo: string[];
  language: string[];
  offer: string[];
  category: MaterialCategory[];
  originalType: string[];
  kind: MaterialKind[];
  unfilled: CatalogUnfilledField[];
}

export interface CatalogSearchRequest {
  query: string;
  filters: CatalogSearchFilters;
  page: number;
  pageSize: number;
}

export interface CatalogSearchRequestInput {
  query?: string;
  filters?: Partial<CatalogSearchFilters>;
  page?: number;
  pageSize?: number;
}

export interface MaterialMetadataPatch {
  geo?: string | null;
  language?: string | null;
  offer?: string | null;
  tags?: string[];
}

export interface CatalogLineageSummary {
  hasSource: boolean;
  hasDerivatives: boolean;
  isVersion: boolean;
}

export interface CatalogMaterialItem {
  id: string;
  teamId: string;
  parentFolderId?: string | null;
  name: string;
  kind: MaterialKind;
  category: MaterialCategory | null;
  mimeType: string | null;
  fileExtension: string | null;
  classificationVersion: number;
  classificationSource: MaterialClassificationSource;
  sizeBytes: number | null;
  modifiedAt: string | null;
  geo: string | null;
  language: string | null;
  offer: string | null;
  tags: string[];
  transcriptIngestState: TranscriptIngestState;
  transcriptTruncated: boolean;
  previewState: string;
  lineage: CatalogLineageSummary;
}

export interface CatalogFacetValue {
  value: string;
  count: number;
}

export interface CatalogSearchResponse {
  items: CatalogMaterialItem[];
  total: number;
  activeFilters: Partial<Record<CatalogFilterKey, string[]>>;
  facets: Partial<Record<Exclude<CatalogFilterKey, 'unfilled'>, CatalogFacetValue[]>>;
  catalogFreshness: {
    state: 'not_started' | 'scanning' | 'replaying' | 'ready' | 'failed' | 'unavailable';
    lastSyncedAt: string | null;
  };
}

export interface CatalogVocabulary {
  geo: string[];
  languages: string[];
  offers: string[];
  tags: string[];
}

const GEO_SET = new Set(GEO_CODES);
const LANGUAGE_BY_LOWER = new Map(
  LANGUAGE_CODES.map(code => [code.toLocaleLowerCase('en-US'), code] as const)
);
const KINDS = new Set<MaterialKind>(['file', 'folder', 'shortcut']);
const UNFILLED = new Set<CatalogUnfilledField>(['geo', 'offer', 'language']);
const CLASSIFICATION_SOURCES = new Set<MaterialClassificationSource>([
  'mime',
  'extension',
  'inspected_landing',
  'fallback'
]);
const FRESHNESS_STATES = new Set<CatalogSearchResponse['catalogFreshness']['state']>([
  'not_started',
  'scanning',
  'replaying',
  'ready',
  'failed',
  'unavailable'
]);

function compactText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return normalized.length <= maxLength ? normalized : null;
}

function normalizedArray<T>(
  value: unknown,
  normalize: (entry: unknown) => T | null,
  key: (entry: T) => string = entry => String(entry)
): T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const output: T[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = normalize(raw);
    if (entry === null) return null;
    const identity = key(entry);
    if (!seen.has(identity)) {
      seen.add(identity);
      output.push(entry);
    }
  }
  return output;
}

function normalizeGeo(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toLocaleUpperCase('en-US') : '';
  return GEO_SET.has(code) ? code : null;
}

function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return LANGUAGE_BY_LOWER.get(value.trim().toLocaleLowerCase('en-US')) ?? null;
}

function normalizeOriginalType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  return normalizeMimeType(raw) ?? normalizeExtension(raw);
}

export function normalizeCatalogSearchRequest(input: unknown): CatalogSearchRequest | null {
  if (!isRecord(input)) return null;
  if (Object.keys(input).some(key => !['query', 'filters', 'page', 'pageSize'].includes(key))) {
    return null;
  }
  const query = input.query === undefined ? '' : compactText(input.query, 240);
  if (query === null) return null;
  const page = input.page === undefined ? 1 : input.page;
  const pageSize = input.pageSize === undefined ? 50 : input.pageSize;
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1_000_000 ||
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return null;
  }
  const rawFilters = input.filters === undefined ? {} : input.filters;
  if (!isRecord(rawFilters)) return null;
  if (
    Object.keys(rawFilters).some(key => !(CATALOG_FILTER_KEYS as readonly string[]).includes(key))
  ) {
    return null;
  }
  const geo = normalizedArray(rawFilters.geo, normalizeGeo);
  const language = normalizedArray(rawFilters.language, normalizeLanguage);
  const offer = normalizedArray(
    rawFilters.offer,
    value => {
      const normalized = normalizeTeamFreeText(value, 160);
      return normalized?.toLocaleLowerCase('en-US') ?? null;
    },
    value => value
  );
  const category = normalizedArray(rawFilters.category, value =>
    typeof value === 'string' && (MATERIAL_CATEGORIES as readonly string[]).includes(value)
      ? (value as MaterialCategory)
      : null
  );
  const originalType = normalizedArray(rawFilters.originalType, normalizeOriginalType);
  const kind = normalizedArray(rawFilters.kind, value =>
    typeof value === 'string' && KINDS.has(value as MaterialKind) ? (value as MaterialKind) : null
  );
  const unfilled = normalizedArray(rawFilters.unfilled, value =>
    typeof value === 'string' && UNFILLED.has(value as CatalogUnfilledField)
      ? (value as CatalogUnfilledField)
      : null
  );
  if (!geo || !language || !offer || !category || !originalType || !kind || !unfilled) {
    return null;
  }
  return {
    query,
    filters: { geo, language, offer, category, originalType, kind, unfilled },
    page,
    pageSize
  };
}

export function normalizeMaterialMetadataPatch(input: unknown): MaterialMetadataPatch | null {
  if (!isRecord(input)) return null;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some(key => !['geo', 'language', 'offer', 'tags'].includes(key))) {
    return null;
  }
  const patch: MaterialMetadataPatch = {};
  if ('geo' in input) {
    if (input.geo === null || input.geo === '') patch.geo = null;
    else {
      const value = normalizeGeo(input.geo);
      if (!value) return null;
      patch.geo = value;
    }
  }
  if ('language' in input) {
    if (input.language === null || input.language === '') patch.language = null;
    else {
      const value = normalizeLanguage(input.language);
      if (!value) return null;
      patch.language = value;
    }
  }
  if ('offer' in input) {
    if (input.offer === null || input.offer === '') patch.offer = null;
    else {
      const value = normalizeTeamFreeText(input.offer, 160);
      if (!value) return null;
      patch.offer = value;
    }
  }
  if ('tags' in input) {
    const value = normalizeTeamTags(input.tags);
    if (!value) return null;
    patch.tags = value;
  }
  return patch;
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function decodeCatalogMaterial(
  value: unknown,
  expectedTeamId: string
): CatalogMaterialItem | null {
  if (!isRecord(value)) return null;
  const forbidden = [
    'transcriptText',
    'transcript_text',
    'driveFileId',
    'drive_file_id',
    'resourceKey'
  ];
  if (forbidden.some(key => key in value)) return null;
  const lineage = isRecord(value.lineage) ? value.lineage : null;
  if (
    typeof value.id !== 'string' ||
    value.teamId !== expectedTeamId ||
    typeof value.name !== 'string' ||
    !KINDS.has(value.kind as MaterialKind) ||
    (value.category !== null &&
      !(MATERIAL_CATEGORIES as readonly unknown[]).includes(value.category)) ||
    !optionalString(value.mimeType) ||
    !optionalString(value.fileExtension) ||
    typeof value.classificationVersion !== 'number' ||
    !Number.isInteger(value.classificationVersion) ||
    value.classificationVersion < 1 ||
    !CLASSIFICATION_SOURCES.has(value.classificationSource as MaterialClassificationSource) ||
    !(value.sizeBytes === null || (typeof value.sizeBytes === 'number' && value.sizeBytes >= 0)) ||
    !optionalString(value.modifiedAt) ||
    !optionalString(value.geo) ||
    !optionalString(value.language) ||
    !optionalString(value.offer) ||
    !Array.isArray(value.tags) ||
    !value.tags.every(tag => typeof tag === 'string') ||
    !(TRANSCRIPT_INGEST_STATES as readonly unknown[]).includes(value.transcriptIngestState) ||
    typeof value.transcriptTruncated !== 'boolean' ||
    typeof value.previewState !== 'string' ||
    !lineage ||
    typeof lineage.hasSource !== 'boolean' ||
    typeof lineage.hasDerivatives !== 'boolean' ||
    typeof lineage.isVersion !== 'boolean'
  ) {
    return null;
  }
  return value as unknown as CatalogMaterialItem;
}

function decodeFacetMap(value: unknown): CatalogSearchResponse['facets'] | null {
  if (!isRecord(value)) return null;
  const output: CatalogSearchResponse['facets'] = {};
  for (const [key, entries] of Object.entries(value)) {
    if (!['geo', 'language', 'offer', 'category', 'originalType', 'kind'].includes(key))
      return null;
    if (
      !Array.isArray(entries) ||
      !entries.every(
        entry =>
          isRecord(entry) &&
          typeof entry.value === 'string' &&
          typeof entry.count === 'number' &&
          Number.isSafeInteger(entry.count) &&
          entry.count >= 0
      )
    ) {
      return null;
    }
    output[key as keyof typeof output] = entries as CatalogFacetValue[];
  }
  return output;
}

export function decodeCatalogSearchResponse(
  input: unknown,
  expectedTeamId: string
): CatalogSearchResponse | null {
  if (!isRecord(input) || !Array.isArray(input.items)) return null;
  const items = input.items.map(item => decodeCatalogMaterial(item, expectedTeamId));
  const facets = decodeFacetMap(input.facets);
  const freshness = isRecord(input.catalogFreshness) ? input.catalogFreshness : null;
  if (
    items.some(item => item === null) ||
    typeof input.total !== 'number' ||
    !Number.isSafeInteger(input.total) ||
    input.total < 0 ||
    !isRecord(input.activeFilters) ||
    !facets ||
    !freshness ||
    !FRESHNESS_STATES.has(freshness.state as CatalogSearchResponse['catalogFreshness']['state']) ||
    !optionalString(freshness.lastSyncedAt)
  ) {
    return null;
  }
  return {
    items: items as CatalogMaterialItem[],
    total: input.total,
    activeFilters: input.activeFilters as CatalogSearchResponse['activeFilters'],
    facets,
    catalogFreshness: freshness as unknown as CatalogSearchResponse['catalogFreshness']
  };
}
