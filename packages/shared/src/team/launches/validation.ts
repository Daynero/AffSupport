import { parseLaunchCatalogVideoConfig } from './catalog-video.js';
import { CATALOG_PRODUCT_COUNT_MAX } from '../catalog-video-set.js';
import { parseLaunchNotes } from './notes.js';
import { clampStitchEndDuration } from '../../stitcher.js';
import { isRecord } from '../contract.js';
import {
  LAUNCH_ADS_MAX,
  LAUNCH_BUDGET_MAX,
  LAUNCH_CAMPAIGN_MAX,
  LAUNCH_CREATIVE_LABEL_MAX,
  LAUNCH_SUB_VARIABLES,
  type LaunchConfig,
  type LaunchCreative,
  type LaunchCreativeKind,
  type LaunchSourceMaterial,
  type LaunchParseResult,
  type LaunchSubConfig,
  type LaunchSubVariable,
  type LaunchCatalogConfig
} from '../launches.js';
import { isLaunchDate, isLaunchTimezone } from './naming.js';
import { isLaunchUrl } from './url.js';
import { launchBudgets } from './budgets.js';
export function normalizeLaunchSub(value: unknown, max = 160): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/^\p{Zs}+|\p{Zs}+$/gu, '')
    .replace(/\p{Zs}+/gu, '_');
  return text.length <= max && /^[A-Za-z0-9_-]+$/u.test(text) ? text : null;
}
const CYRILLIC_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ie',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'i',
  й: 'i',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'iu',
  я: 'ia',
  ё: 'e',
  ы: 'y',
  э: 'e',
  ъ: ''
};
/**
 * A creative's name from its file name, always a valid SUB value: Ukrainian
 * transliteration, spaces to `_`, anything else outside `A–Z a–z 0–9 _ -` dropped.
 * 062: names are no longer typed by hand, so this is the name.
 */
function latinized(text: string): string {
  return Array.from(text.normalize('NFC'), char => {
    const lower = char.toLowerCase();
    const mapped = CYRILLIC_LATIN[lower];
    if (mapped === undefined) return char;
    return char === lower || !mapped ? mapped : mapped[0]!.toUpperCase() + mapped.slice(1);
  }).join('');
}
export function launchCreativeAlias(filename: string): string {
  const latin = latinized(filename.replace(/\.[^.]+$/u, ''));
  const alias = latin
    .replace(/\p{Zs}+/gu, '_')
    .replace(/[^A-Za-z0-9_-]+/gu, '')
    .replace(/([_-])[_-]+/gu, '$1')
    .replace(/^[_-]+|[_-]+$/gu, '')
    .slice(0, 160);
  return alias || 'creative';
}
/**
 * The name of several creatives, or the automatic «<first>+N», as SUB «Креатив» takes it:
 * spaces to `_`, then only `A–Z a–z 0–9 _ - +` (a «+» goes out as %2B, never as a space).
 */
export function normalizeLaunchCreativeLabel(
  value: unknown,
  max = LAUNCH_CREATIVE_LABEL_MAX
): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/^\p{Zs}+|\p{Zs}+$/gu, '')
    .replace(/\p{Zs}+/gu, '_');
  return text.length <= max && /^[A-Za-z0-9_+-]+$/u.test(text) ? text : null;
}
/**
 * What a person types into the name of several creatives, turned into that alphabet as they
 * type: «пак 1» → «pak_1». Cyrillic is transliterated as creative names are, spaces become `_`,
 * any other character is dropped. `final` (on leaving the field) also trims separators at the
 * ends, which typing keeps so «pak » can still become «pak_1».
 */
export function launchCreativeLabelInput(text: string, final = false): string {
  const typed = latinized(text)
    .replace(/\p{Zs}+/gu, '_')
    .replace(/[^A-Za-z0-9_+-]+/gu, '')
    .slice(0, LAUNCH_CREATIVE_LABEL_MAX);
  return final ? typed.replace(/^[_+-]+|[_+-]+$/gu, '') : typed;
}
export function normalizeLaunchOffer(value: unknown): string | null {
  if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return null;
  const normalized = value.trim().normalize('NFC');
  return normalized.length > 0 && normalized.length <= 160 ? normalized : null;
}
export function isLaunchUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
function variables(value: unknown): value is LaunchSubVariable[] {
  return (
    Array.isArray(value) &&
    value.length <= LAUNCH_SUB_VARIABLES.length &&
    value.every((v: unknown) => typeof v === 'string' && LAUNCH_SUB_VARIABLES.some(k => k === v)) &&
    new Set(value).size === value.length
  );
}
export function parseLaunchSubConfig(value: unknown): LaunchSubConfig | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !variables(value.sub1) ||
    !variables(value.sub2) ||
    !variables(value.sub3)
  )
    return null;
  return { schemaVersion: 1, sub1: [...value.sub1], sub2: [...value.sub2], sub3: [...value.sub3] };
}
function catalogConfig(value: unknown, required: boolean): LaunchCatalogConfig | null {
  if (
    !isRecord(value) ||
    typeof value.productCount !== 'number' ||
    !Number.isFinite(value.productCount) ||
    (required && !positive(value.productCount, CATALOG_PRODUCT_COUNT_MAX)) ||
    typeof value.restitchEnabled !== 'boolean' ||
    (value.copyVideoToR2 !== undefined && typeof value.copyVideoToR2 !== 'boolean')
  )
    return null;
  const video = parseLaunchCatalogVideoConfig(value, required);
  if (!video) return null;
  const mode = value.finalDurationMode;
  if (
    mode !== 'random-30-40' &&
    mode !== 'random-40-50' &&
    mode !== 'random-50-60' &&
    mode !== 'random-centered' &&
    mode !== 'custom'
  )
    return null;
  const range = value.finalDurationRangeSeconds;
  if (
    range !== undefined &&
    (!Array.isArray(range) ||
      range.length !== 2 ||
      !range.every(
        n => typeof n === 'number' && Number.isInteger(n) && n >= 60 && n <= 3600 && n % 60 === 0
      ) ||
      range[0] > range[1])
  )
    return null;
  const seconds = value.customFinalDurationSeconds;
  const activeDuration = required && value.restitchEnabled;
  if (
    seconds !== null &&
    (typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      (activeDuration &&
        (!positive(seconds) || seconds % 60 !== 0 || clampStitchEndDuration(seconds) !== seconds)))
  )
    return null;
  if (activeDuration && (mode === 'custom' || mode === 'random-centered') && seconds === null)
    return null;
  return {
    ...video,
    ...(typeof value.copyVideoToR2 === 'boolean' ? { copyVideoToR2: value.copyVideoToR2 } : {}),
    productCount: value.productCount,
    restitchEnabled: value.restitchEnabled,
    finalDurationMode: mode,
    customFinalDurationSeconds: seconds,
    ...(Array.isArray(range) ? { finalDurationRangeSeconds: [range[0], range[1]] as const } : {})
  };
}
type ParsedCreatives =
  | { ok: true; creatives?: LaunchCreative[]; creativeKind?: LaunchCreativeKind }
  | { ok: false; code: string };
/**
 * 062: the creative list must name the same first creative as `materialId` /
 * `creativeAlias`, hold distinct materials of one declared kind, and share the
 * products exactly (one or more each). The "other" method keeps one creative.
 */
function parseLaunchCreatives(value: Record<string, unknown>): ParsedCreatives {
  const raw = value.creatives;
  const kind = value.creativeKind;
  if (raw === undefined)
    return kind === undefined ? { ok: true } : { ok: false, code: 'INVALID_INPUT' };
  if (kind !== 'video' && kind !== 'image') return { ok: false, code: 'INVALID_INPUT' };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, code: 'INVALID_INPUT' };
  if (raw.length > CATALOG_PRODUCT_COUNT_MAX) return { ok: false, code: 'CREATIVES_LIMIT' };
  if (value.method === 'other' && raw.length !== 1) return { ok: false, code: 'CREATIVES_LIMIT' };
  const creatives: LaunchCreative[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || !isLaunchUuid(item.materialId))
      return { ok: false, code: 'INVALID_INPUT' };
    const alias = normalizeLaunchSub(item.alias);
    if (!alias) return { ok: false, code: 'LAUNCH_SUB_INVALID' };
    if (!positive(item.copies, CATALOG_PRODUCT_COUNT_MAX))
      return { ok: false, code: 'DISTRIBUTION_INVALID' };
    if (item.pinned !== null && !positive(item.pinned)) return { ok: false, code: 'INVALID_INPUT' };
    const materialId = item.materialId.toLowerCase();
    if (seen.has(materialId)) return { ok: false, code: 'CREATIVE_DUPLICATE' };
    seen.add(materialId);
    creatives.push({
      materialId: item.materialId,
      alias,
      copies: item.copies,
      pinned: item.pinned
    });
  }
  const first = creatives[0]!;
  if (
    typeof value.materialId !== 'string' ||
    first.materialId.toLowerCase() !== value.materialId.toLowerCase() ||
    first.alias !== normalizeLaunchSub(value.creativeAlias)
  )
    return { ok: false, code: 'INVALID_INPUT' };
  if (value.method === 'catalog') {
    const catalog = isRecord(value.catalog) ? value.catalog : null;
    const n = catalog?.productCount;
    const total = creatives.reduce((sum, creative) => sum + creative.copies, 0);
    if (typeof n !== 'number' || total !== n || n < creatives.length)
      return { ok: false, code: 'DISTRIBUTION_INVALID' };
    if (kind === 'image' && catalog?.restitchEnabled === true)
      return { ok: false, code: 'INVALID_INPUT' };
    if (
      kind === 'video' &&
      catalog?.restitchEnabled === true &&
      catalog.catalogVideoProtocolVersion === 1 &&
      (typeof catalog.videoVariationCount !== 'number' ||
        catalog.videoVariationCount < creatives.length ||
        catalog.videoVariationCount > n)
    )
      return { ok: false, code: 'VARIATIONS_RANGE' };
  }
  return { ok: true, creatives, creativeKind: kind };
}
export function parseLaunchConfig(value: unknown): LaunchParseResult<LaunchConfig> {
  if (!isRecord(value)) return { ok: false, errors: { config: 'INVALID_INPUT' } };
  const errors: Record<string, string> = {};
  const notes = value.notes === undefined ? undefined : parseLaunchNotes(value.notes);
  if (notes === null) errors.notes = 'INVALID_INPUT';
  for (const key of ['agentRowId', 'offerId', 'buyerId', 'materialId'])
    if (!isLaunchUuid(value[key])) errors[key] = 'INVALID_INPUT';
  const creativeAlias = normalizeLaunchSub(value.creativeAlias);
  if (!creativeAlias) errors.creativeAlias = 'LAUNCH_SUB_INVALID';
  for (const [key, max] of [
    ['campaignCount', LAUNCH_CAMPAIGN_MAX],
    ['maxBudget', LAUNCH_BUDGET_MAX],
    ['adsCount', LAUNCH_ADS_MAX],
    ['age', Number.MAX_SAFE_INTEGER]
  ] as const)
    if (!positive(value[key], max)) errors[key] = 'INVALID_INPUT';
  if (
    value.minBudget !== undefined &&
    (!positive(value.minBudget, LAUNCH_BUDGET_MAX) ||
      typeof value.maxBudget !== 'number' ||
      value.minBudget > value.maxBudget)
  )
    errors.minBudget = 'LAUNCH_BUDGET_INVALID';
  if (!isLaunchDate(value.launchDate)) errors.launchDate = 'INVALID_INPUT';
  if (!isLaunchTimezone(value.timezone)) errors.timezone = 'INVALID_INPUT';
  if (!isLaunchUrl(value.originalUrl)) errors.originalUrl = 'LAUNCH_URL_INVALID';
  const subConfig = parseLaunchSubConfig(value.subConfig);
  if (!subConfig) errors.subConfig = 'INVALID_INPUT';
  if (subConfig && value.method !== 'catalog') {
    for (const slot of ['sub1', 'sub2', 'sub3'] as const)
      if (subConfig[slot].includes('catalogName')) errors[slot] = 'LAUNCH_SUB_INVALID';
  }
  const catalog = catalogConfig(value.catalog, value.method === 'catalog');
  if (!catalog) errors.catalog = 'INVALID_INPUT';
  const gender = value.gender;
  const method = value.method;
  const budgetMode = value.budgetMode;
  const budgets = value.budgets;
  if (gender !== 'M' && gender !== 'W' && gender !== 'ALL') errors.gender = 'INVALID_INPUT';
  if (method !== 'catalog' && method !== 'other') errors.method = 'INVALID_INPUT';
  if (budgetMode !== 'auto' && budgetMode !== 'manual' && budgetMode !== 'single')
    errors.budgetMode = 'INVALID_INPUT';
  if (typeof value.advantagePlus !== 'boolean') errors.advantagePlus = 'INVALID_INPUT';
  if (value.schemaVersion !== 1) errors.schemaVersion = 'INVALID_INPUT';
  if (
    budgetMode === 'manual' &&
    (!Array.isArray(budgets) || !budgets.every((v: unknown) => typeof v === 'number'))
  )
    errors.budgets = 'LAUNCH_BUDGET_INVALID';
  if (budgetMode !== 'manual' && budgets !== null) errors.budgets = 'LAUNCH_BUDGET_INVALID';
  const creatives = parseLaunchCreatives(value);
  if (!creatives.ok) errors.creatives = creatives.code;
  // Kept exactly as stored: admission compares the parsed config with the saved draft.
  const creativeLabel =
    value.creativeLabel === undefined
      ? undefined
      : normalizeLaunchCreativeLabel(value.creativeLabel);
  if (value.creativeLabel !== undefined && creativeLabel !== value.creativeLabel)
    errors.creativeLabel = 'LAUNCH_SUB_INVALID';
  if (Object.keys(errors).length) return { ok: false, errors };
  if (!creatives.ok) return { ok: false, errors: { creatives: creatives.code } };
  // Narrow every field again instead of trusting a route generic or casting a payload.
  if (
    !isLaunchUuid(value.agentRowId) ||
    !isLaunchUuid(value.offerId) ||
    !isLaunchUuid(value.buyerId) ||
    !isLaunchUuid(value.materialId) ||
    !creativeAlias ||
    !positive(value.campaignCount, LAUNCH_CAMPAIGN_MAX) ||
    !positive(value.maxBudget, LAUNCH_BUDGET_MAX) ||
    !positive(value.adsCount, LAUNCH_ADS_MAX) ||
    !positive(value.age) ||
    !isLaunchDate(value.launchDate) ||
    !isLaunchTimezone(value.timezone) ||
    !isLaunchUrl(value.originalUrl) ||
    !subConfig ||
    !catalog ||
    typeof value.advantagePlus !== 'boolean' ||
    (gender !== 'M' && gender !== 'W' && gender !== 'ALL') ||
    (method !== 'other' && method !== 'catalog') ||
    (budgetMode !== 'auto' && budgetMode !== 'manual' && budgetMode !== 'single')
  )
    return { ok: false, errors: { config: 'INVALID_INPUT' } };
  let manual: number[] | null = null;
  if (budgetMode === 'manual') {
    if (
      !Array.isArray(budgets) ||
      !budgets.every((v: unknown): v is number => typeof v === 'number')
    )
      return { ok: false, errors: { budgets: 'LAUNCH_BUDGET_INVALID' } };
    manual = [...budgets];
  }
  try {
    launchBudgets(
      value.campaignCount,
      value.maxBudget,
      manual,
      typeof value.minBudget === 'number' ? value.minBudget : undefined,
      budgetMode
    );
  } catch {
    return { ok: false, errors: { budgets: 'LAUNCH_BUDGET_INVALID' } };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      agentRowId: value.agentRowId,
      offerId: value.offerId,
      buyerId: value.buyerId,
      materialId: value.materialId,
      creativeAlias,
      ...(creatives.creatives
        ? { creativeKind: creatives.creativeKind, creatives: creatives.creatives }
        : {}),
      ...(creativeLabel ? { creativeLabel } : {}),
      campaignCount: value.campaignCount,
      maxBudget: value.maxBudget,
      ...(typeof value.minBudget === 'number' ? { minBudget: value.minBudget } : {}),
      adsCount: value.adsCount,
      budgetMode,
      budgets: manual,
      age: value.age,
      gender,
      advantagePlus: value.advantagePlus,
      launchDate: value.launchDate,
      timezone: value.timezone,
      method,
      originalUrl: value.originalUrl,
      subConfig,
      catalog,
      ...(notes ? { notes } : {})
    }
  };
}

export function parseLaunchSources(
  value: unknown
): import('../launches.js').LaunchSourceSnapshot | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isLaunchUuid(value.accountId) ||
    !isLaunchUuid(value.agentRowId) ||
    !isLaunchUuid(value.offerId) ||
    !isLaunchUuid(value.buyerId) ||
    !isLaunchUuid(value.materialId) ||
    typeof value.social !== 'string' ||
    typeof value.agentId !== 'string' ||
    typeof value.offer !== 'string' ||
    typeof value.buyer !== 'string' ||
    (value.materialType !== 'video' && value.materialType !== 'image') ||
    (value.materialVersion !== null && typeof value.materialVersion !== 'string') ||
    (value.materialChecksum !== undefined &&
      value.materialChecksum !== null &&
      (typeof value.materialChecksum !== 'string' ||
        !/^[0-9a-f]{32}$/iu.test(value.materialChecksum))) ||
    (value.materialDriveFileId !== undefined &&
      (typeof value.materialDriveFileId !== 'string' ||
        !value.materialDriveFileId.length ||
        value.materialDriveFileId.length > 1024)) ||
    (value.catalogSettingsVersion !== null && typeof value.catalogSettingsVersion !== 'string') ||
    (value.restitchSettingsVersion !== undefined &&
      value.restitchSettingsVersion !== null &&
      typeof value.restitchSettingsVersion !== 'string')
  )
    return null;
  let materials: LaunchSourceMaterial[] | undefined;
  if (value.materials !== undefined) {
    if (!Array.isArray(value.materials) || value.materials.length === 0) return null;
    materials = [];
    for (const item of value.materials) {
      if (
        !isRecord(item) ||
        !isLaunchUuid(item.materialId) ||
        (item.type !== 'video' && item.type !== 'image') ||
        (item.version !== null && typeof item.version !== 'string') ||
        (item.checksum !== undefined &&
          item.checksum !== null &&
          (typeof item.checksum !== 'string' || !/^[0-9a-f]{32}$/iu.test(item.checksum))) ||
        (item.driveFileId !== undefined &&
          (typeof item.driveFileId !== 'string' ||
            !item.driveFileId.length ||
            item.driveFileId.length > 1024))
      )
        return null;
      materials.push({
        materialId: item.materialId,
        type: item.type,
        version: item.version,
        ...(item.checksum !== undefined ? { checksum: item.checksum } : {}),
        ...(item.driveFileId !== undefined ? { driveFileId: item.driveFileId } : {})
      });
    }
    if (materials[0]!.materialId.toLowerCase() !== value.materialId.toLowerCase()) return null;
  }
  return {
    schemaVersion: 1,
    ...(materials ? { materials } : {}),
    accountId: value.accountId,
    agentRowId: value.agentRowId,
    offerId: value.offerId,
    buyerId: value.buyerId,
    materialId: value.materialId,
    social: value.social,
    agentId: value.agentId,
    offer: value.offer,
    buyer: value.buyer,
    materialType: value.materialType,
    materialVersion: value.materialVersion,
    ...(value.materialChecksum !== undefined ? { materialChecksum: value.materialChecksum } : {}),
    ...(value.materialDriveFileId !== undefined
      ? { materialDriveFileId: value.materialDriveFileId }
      : {}),
    catalogSettingsVersion: value.catalogSettingsVersion,
    ...(value.restitchSettingsVersion !== undefined
      ? { restitchSettingsVersion: value.restitchSettingsVersion }
      : {})
  };
}
