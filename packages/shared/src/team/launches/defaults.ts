import type { LaunchDraft } from '../launches.js';

/** The same reusable field boundary for saving and applying either profile. */
export const LAUNCH_DEFAULT_FIELDS = [
  'buyerId',
  'campaignCount',
  'minBudget',
  'maxBudget',
  'budgetMode',
  'budgets',
  'adsCount',
  'age',
  'gender',
  'method',
  'advantagePlus',
  'catalog',
  'subConfig'
] as const;
export function launchDefaultValues(config: LaunchDraft): LaunchDraft {
  return Object.fromEntries(
    LAUNCH_DEFAULT_FIELDS.filter(key => config[key] !== undefined).map(key => [key, config[key]])
  );
}
/** Replace the entire profile, including absent optional fields; keep one-off inputs. */
export function applyLaunchDefaultValues(current: LaunchDraft, profile: LaunchDraft): LaunchDraft {
  const next = { ...current };
  for (const key of LAUNCH_DEFAULT_FIELDS) delete next[key];
  return { ...next, ...launchDefaultValues(profile) };
}
