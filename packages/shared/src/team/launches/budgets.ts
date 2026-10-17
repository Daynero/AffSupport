import {
  LAUNCH_ADS_MAX,
  LAUNCH_BUDGET_MAX,
  LAUNCH_CAMPAIGN_MAX,
  type LaunchCampaign
} from '../launches.js';
export function launchBudgets(
  count: number,
  max: number,
  manual: number[] | null = null,
  min?: number
): number[] {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > LAUNCH_CAMPAIGN_MAX ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > LAUNCH_BUDGET_MAX
  )
    throw new Error('LAUNCH_BUDGET_INVALID');
  if (min !== undefined && (!Number.isSafeInteger(min) || min < 1 || min > max))
    throw new Error('LAUNCH_BUDGET_INVALID');
  const values =
    manual ??
    Array.from({ length: count }, (_, i) =>
      min === undefined
        ? Math.round(((i + 1) * max) / count)
        : count === 1
          ? max
          : Math.round(min + (i * (max - min)) / (count - 1))
    );
  if (
    values.length !== count ||
    values.some(
      (v, i) =>
        !Number.isSafeInteger(v) || v < (min ?? 1) || v > max || (i > 0 && v <= values[i - 1])
    ) ||
    values[count - 1] !== max
  )
    throw new Error('LAUNCH_BUDGET_INVALID');
  return [...values];
}
export function launchAdRange(
  ordinal: number,
  ads: number
): Pick<LaunchCampaign, 'adStart' | 'adEnd'> {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 1 ||
    !Number.isSafeInteger(ads) ||
    ads < 1 ||
    !Number.isSafeInteger(ordinal * ads)
  )
    throw new Error('INVALID_INPUT');
  return { adStart: (ordinal - 1) * ads + 1, adEnd: ordinal * ads };
}

export function launchPreviewRows(
  count: number,
  max: number,
  ads: number,
  manual: number[] | null = null,
  min?: number
): LaunchCampaign[] {
  if (!Number.isSafeInteger(ads) || ads < 1 || ads > LAUNCH_ADS_MAX)
    throw new Error('INVALID_INPUT');
  return launchBudgets(count, max, manual, min).map((budget, index) => ({
    ordinal: index + 1,
    budget,
    ...launchAdRange(index + 1, ads),
    name: ''
  }));
}
