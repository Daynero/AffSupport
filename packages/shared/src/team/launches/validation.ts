import { parseLaunchNotes } from './notes.js';
import { clampStitchEndDuration } from '../../stitcher.js';
import { isRecord } from '../contract.js';
import {
  LAUNCH_ADS_MAX,
  LAUNCH_BUDGET_MAX,
  LAUNCH_CAMPAIGN_MAX,
  LAUNCH_SUB_VARIABLES,
  type LaunchConfig,
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
export function launchCreativeAlias(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/u, '');
  return stem
    .normalize('NFC')
    .replace(/^\p{Zs}+|\p{Zs}+$/gu, '')
    .replace(/\p{Zs}+/gu, '_');
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
    (required && !positive(value.productCount, 400)) ||
    typeof value.restitchEnabled !== 'boolean'
  )
    return null;
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
    productCount: value.productCount,
    restitchEnabled: value.restitchEnabled,
    finalDurationMode: mode,
    customFinalDurationSeconds: seconds,
    ...(Array.isArray(range) ? { finalDurationRangeSeconds: [range[0], range[1]] as const } : {})
  };
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
  if (budgetMode !== 'auto' && budgetMode !== 'manual') errors.budgetMode = 'INVALID_INPUT';
  if (typeof value.advantagePlus !== 'boolean') errors.advantagePlus = 'INVALID_INPUT';
  if (value.schemaVersion !== 1) errors.schemaVersion = 'INVALID_INPUT';
  if (
    budgetMode === 'manual' &&
    (!Array.isArray(budgets) || !budgets.every((v: unknown) => typeof v === 'number'))
  )
    errors.budgets = 'LAUNCH_BUDGET_INVALID';
  if (budgetMode === 'auto' && budgets !== null) errors.budgets = 'LAUNCH_BUDGET_INVALID';
  if (Object.keys(errors).length) return { ok: false, errors };
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
    (budgetMode !== 'auto' && budgetMode !== 'manual')
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
      typeof value.minBudget === 'number' ? value.minBudget : undefined
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
  return {
    schemaVersion: 1,
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
