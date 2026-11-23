import { LAUNCH_SUB_VALUE_MAX } from '../launches.js';
import type {
  LaunchConfig,
  LaunchSources,
  LaunchPreview,
  LaunchParseResult,
  LaunchSubSlot,
  LaunchDraft,
  LaunchCampaign
} from '../launches.js';
import { normalizeLaunchSub, normalizeLaunchOffer, parseLaunchConfig } from './validation.js';
import { launchBudgets, launchAdRange, launchPreviewRows } from './budgets.js';
import { launchCampaignName, launchCreativeLabel, isLaunchDate } from './naming.js';
import { patchLaunchUrl } from './url.js';
/**
 * 062: a catalog Launch without a creative list stays video-only, as before.
 * With one, every creative must be a material of the declared kind, in order.
 */
function launchCreativeKindMismatch(
  config: LaunchConfig,
  sources: LaunchSources
): { field: string; code: string } | null {
  if (!config.creatives) {
    return sources.materialType === 'video' ? null : { field: 'materialId', code: 'INVALID_INPUT' };
  }
  const materials =
    sources.materials ??
    (config.creatives.length === 1
      ? [{ materialId: config.materialId, type: sources.materialType }]
      : null);
  if (!materials || materials.length !== config.creatives.length)
    return { field: 'creatives', code: 'SOURCE_CHANGED' };
  for (const [index, creative] of config.creatives.entries()) {
    const material = materials[index]!;
    if (material.materialId.toLowerCase() !== creative.materialId.toLowerCase())
      return { field: 'creatives', code: 'SOURCE_CHANGED' };
    if (material.type !== config.creativeKind)
      return { field: 'creatives', code: 'CREATIVES_MIXED' };
  }
  return null;
}
export function launchPreview(
  config: LaunchConfig,
  sources: LaunchSources,
  catalogName?: string
): LaunchParseResult<LaunchPreview> {
  const parsed = parseLaunchConfig(config);
  if (!parsed.ok) return parsed;
  config = parsed.value;
  const errors: Record<string, string> = {};
  const buyer = normalizeLaunchSub(sources.buyer, 80);
  const offer = normalizeLaunchOffer(sources.offer);
  if (!buyer) errors.buyerId = 'LAUNCH_SUB_INVALID';
  if (!offer) errors.offerId = 'INVALID_INPUT';
  if (!/^[0-9]{3,64}$/u.test(sources.agentId)) errors.agentRowId = 'INVALID_INPUT';
  if (!sources.social || /\p{Cc}/u.test(sources.social)) errors.agentRowId = 'INVALID_INPUT';
  if (config.method === 'catalog') {
    const kind = launchCreativeKindMismatch(config, sources);
    if (kind) errors[kind.field] = kind.code;
  }
  const vars = {
    buyer,
    social: normalizeLaunchSub(sources.social),
    adAccountSuffix: sources.agentId.slice(-3),
    catalogName: catalogName ?? null,
    // 062: one value for the whole Launch — the first creative with «+N» for the others, as
    // its card names it — so a tracker keeps one row per Launch however many creatives it has
    // (owner, 2026-11-21: one value per block, or per creative, would swamp the analytics).
    creative: launchCreativeLabel(config)
  };
  const subValues: Record<LaunchSubSlot, string | null> = { sub1: null, sub2: null, sub3: null };
  for (const slot of ['sub1', 'sub2', 'sub3'] as const) {
    const selected = config.subConfig[slot];
    if (!selected.length) continue;
    if (selected.some(key => key !== 'catalogName' && !vars[key])) {
      errors[slot] = 'LAUNCH_SUB_INVALID';
      continue;
    }
    if (
      selected.includes('catalogName') &&
      catalogName !== undefined &&
      (!catalogName ||
        catalogName.length > LAUNCH_SUB_VALUE_MAX ||
        /[\p{Cc}\p{Cs}]/u.test(catalogName))
    ) {
      errors[slot] = 'LAUNCH_SUB_INVALID';
      continue;
    }
    if (selected.includes('catalogName') && catalogName === undefined) continue;
    subValues[slot] = selected.map(key => vars[key]).join('-');
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  try {
    const campaigns = launchBudgets(
      config.campaignCount,
      config.maxBudget,
      config.budgets,
      config.minBudget,
      config.budgetMode
    ).map((budget, index) => {
      const row = { ordinal: index + 1, budget, ...launchAdRange(index + 1, config.adsCount) };
      return { ...row, name: launchCampaignName(config, sources, row) };
    });
    return {
      ok: true,
      value: {
        advertisingUrl: patchLaunchUrl(
          config.originalUrl,
          subValues,
          new Set(
            (['sub1', 'sub2', 'sub3'] as const).filter(slot =>
              config.subConfig[slot].includes('catalogName')
            )
          )
        ),
        subValues,
        campaigns
      }
    };
  } catch {
    return { ok: false, errors: { originalUrl: 'LAUNCH_URL_INVALID' } };
  }
}

/** A SUB preview does not depend on age, budgets or the validity of the rest of the form. */
/** A creative's SUB value: an alias, or a Launch label with «+N» for the other creatives. */
function normalizeLaunchCreativeSub(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = /^(.+)\+(\d{1,3})$/u.exec(value);
  const alias = normalizeLaunchSub(label ? label[1] : value);
  return alias === null ? null : label ? `${alias}+${label[2]}` : alias;
}

export function launchSubPreview(
  config: import('../launches.js').LaunchSubConfig,
  alias: unknown,
  sources: Partial<Pick<LaunchSources, 'buyer' | 'social' | 'agentId'>>
): Record<LaunchSubSlot, string | null> {
  const variables = {
    buyer: normalizeLaunchSub(sources.buyer, 80),
    social: normalizeLaunchSub(sources.social),
    adAccountSuffix: /^[0-9]{3,64}$/u.test(sources.agentId ?? '')
      ? (sources.agentId ?? '').slice(-3)
      : null,
    catalogName: null,
    creative: normalizeLaunchCreativeSub(alias)
  };
  const result: Record<LaunchSubSlot, string | null> = { sub1: null, sub2: null, sub3: null };
  for (const slot of ['sub1', 'sub2', 'sub3'] as const) {
    const selected = config[slot];
    if (selected.length && !selected.some(key => variables[key] === null))
      result[slot] = selected.map(key => variables[key]).join('-');
  }
  return result;
}

/** Names depend on naming fields only. Missing URL/material proof never hides
 * otherwise computable text; authoritative generation still validates it all. */
export function launchNamingPreview(
  config: LaunchDraft,
  sources: Partial<Pick<LaunchSources, 'social' | 'agentId' | 'offer'>>
): LaunchCampaign[] {
  let rows: LaunchCampaign[];
  try {
    rows = launchPreviewRows(
      config.campaignCount ?? 0,
      config.maxBudget ?? 0,
      config.adsCount ?? 0,
      config.budgetMode === 'manual' ? (config.budgets ?? []) : null,
      config.minBudget,
      config.budgetMode
    );
  } catch {
    return [];
  }
  const alias = normalizeLaunchSub(config.creativeAlias);
  const offer = normalizeLaunchOffer(sources.offer);
  const { social, agentId } = sources;
  const { age, gender, advantagePlus, method, launchDate } = config;
  if (
    !alias ||
    !offer ||
    typeof social !== 'string' ||
    !social ||
    /\p{Cc}/u.test(social) ||
    typeof agentId !== 'string' ||
    !/^[0-9]{3,64}$/u.test(agentId) ||
    typeof age !== 'number' ||
    !Number.isSafeInteger(age) ||
    age < 1 ||
    (gender !== 'M' && gender !== 'W' && gender !== 'ALL') ||
    typeof advantagePlus !== 'boolean' ||
    (method !== 'catalog' && method !== 'other') ||
    !isLaunchDate(launchDate)
  )
    return rows;
  return rows.map(row => ({
    ...row,
    name: launchCampaignName(
      { creativeAlias: alias, age, gender, advantagePlus, method, launchDate },
      { social, agentId, offer },
      row
    )
  }));
}
