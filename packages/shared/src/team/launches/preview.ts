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
import { launchCampaignName, isLaunchDate } from './naming.js';
import { patchLaunchUrl } from './url.js';
export function launchPreview(
  config: LaunchConfig,
  sources: LaunchSources
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
  if (config.method === 'catalog' && sources.materialType !== 'video')
    errors.materialId = 'INVALID_INPUT';
  const vars = {
    buyer,
    social: normalizeLaunchSub(sources.social),
    adAccountSuffix: sources.agentId.slice(-3),
    creative: config.creativeAlias
  };
  const subValues: Record<LaunchSubSlot, string | null> = { sub1: null, sub2: null, sub3: null };
  for (const slot of ['sub1', 'sub2', 'sub3'] as const) {
    const selected = config.subConfig[slot];
    if (!selected.length) continue;
    if (selected.some(key => !vars[key])) {
      errors[slot] = 'LAUNCH_SUB_INVALID';
      continue;
    }
    subValues[slot] = selected.map(key => vars[key]).join('-');
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  try {
    const campaigns = launchBudgets(
      config.campaignCount,
      config.maxBudget,
      config.budgets,
      config.minBudget
    ).map((budget, index) => {
      const row = { ordinal: index + 1, budget, ...launchAdRange(index + 1, config.adsCount) };
      return { ...row, name: launchCampaignName(config, sources, row) };
    });
    return {
      ok: true,
      value: { advertisingUrl: patchLaunchUrl(config.originalUrl, subValues), subValues, campaigns }
    };
  } catch {
    return { ok: false, errors: { originalUrl: 'LAUNCH_URL_INVALID' } };
  }
}

/** A SUB preview does not depend on age, budgets or the validity of the rest of the form. */
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
    creative: normalizeLaunchSub(alias)
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
      config.minBudget
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
