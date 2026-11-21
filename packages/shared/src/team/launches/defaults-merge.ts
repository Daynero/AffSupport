/**
 * 064: where a new Launch's values come from, without a browser.
 *
 * The form and the assistant build a new draft the same way: the offer's saved profile, else the
 * space's general profile, else the built-in values. Time and time zone are passed in, so the
 * server and a test get the same answer as the form.
 *
 * Saving a profile from the assistant changes only the fields the person named (a mask); the rest
 * of the stored profile, including legacy fields, is carried over untouched.
 */
import type { LaunchDraft, LaunchSubConfig } from '../launches.js';
import {
  applyLaunchDefaultValues,
  LAUNCH_DEFAULT_FIELDS,
  launchDefaultValues
} from './defaults.js';
import { isLaunchTimezone } from './naming.js';

export interface LaunchDefaultsProfile {
  config: LaunchDraft;
  subConfig: LaunchSubConfig;
  version: string;
}

export type LaunchDefaultsSource = 'offer' | 'workspace' | 'builtin';

/** The calendar day `offsetDays` after `now` in `timezone`, as YYYY-MM-DD. */
export function launchDayInZone(now: Date, timezone: string, offsetDays = 0): string {
  if (!isLaunchTimezone(timezone) || !Number.isFinite(now.getTime()))
    throw new Error('INVALID_INPUT');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offsetDays));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function builtinLaunchCatalogConfig(): NonNullable<LaunchDraft['catalog']> {
  return {
    productCount: 100,
    restitchEnabled: false,
    finalDurationMode: 'random-30-40',
    customFinalDurationSeconds: null
  };
}

/** The values a new Launch starts from when no profile exists. */
export function builtinLaunchDraft(now: Date, timezone: string): LaunchDraft {
  return {
    schemaVersion: 1,
    campaignCount: 3,
    maxBudget: 30,
    minBudget: 10,
    adsCount: 3,
    budgetMode: 'auto',
    budgets: null,
    // The usual minimum on Meta; an empty field read as a missing value nobody had chosen.
    age: 18,
    gender: 'M',
    advantagePlus: true,
    launchDate: launchDayInZone(now, timezone, 1),
    timezone,
    // 062: catalog Launches are the usual case; the choice sits right under the account.
    method: 'catalog',
    subConfig: {
      schemaVersion: 1,
      sub1: ['buyer'],
      sub2: ['social', 'adAccountSuffix', 'creative'],
      sub3: ['creative']
    },
    catalog: builtinLaunchCatalogConfig()
  };
}

/** Profile values over built-in values, as the form applies them on an offer selection. */
export function resolveLaunchDefaults(
  profile: LaunchDefaultsProfile | null,
  now: Date,
  timezone: string
): LaunchDraft {
  const next: LaunchDraft = {
    ...launchDefaultValues(builtinLaunchDraft(now, timezone)),
    ...launchDefaultValues(profile?.config ?? {}),
    ...(profile ? { subConfig: profile.subConfig } : {})
  };
  // Older profiles used max/count allocation, not today's explicit minimum.
  if (profile && profile.config.minBudget === undefined && profile.config.maxBudget !== undefined)
    delete next.minBudget;
  return next;
}

/**
 * A complete new draft: built-in shape, then the first profile that exists (offer, then space).
 * A failed read is not "no profile": the caller passes `null` only for a profile that is absent.
 */
export function newDraftFromDefaults(input: {
  offer: LaunchDefaultsProfile | null;
  workspace: LaunchDefaultsProfile | null;
  now: Date;
  timezone: string;
}): { draft: LaunchDraft; source: LaunchDefaultsSource } {
  const profile = input.offer ?? input.workspace;
  const source: LaunchDefaultsSource = input.offer
    ? 'offer'
    : input.workspace
      ? 'workspace'
      : 'builtin';
  const base = builtinLaunchDraft(input.now, input.timezone);
  return {
    draft: applyLaunchDefaultValues(
      base,
      resolveLaunchDefaults(profile, input.now, input.timezone)
    ),
    source
  };
}

/** Paths an assistant may save into a profile: a default field, or one key inside catalog/subConfig. */
export type LaunchDefaultPath =
  | (typeof LAUNCH_DEFAULT_FIELDS)[number]
  | `catalog.${string}`
  | 'subConfig.sub1'
  | 'subConfig.sub2'
  | 'subConfig.sub3';

const CATALOG_KEYS = new Set([
  'productCount',
  'restitchEnabled',
  'finalDurationMode',
  'customFinalDurationSeconds',
  'finalDurationRangeSeconds',
  'videoVariationCount',
  'copyVideoToR2'
]);

export function isLaunchDefaultPath(value: unknown): value is LaunchDefaultPath {
  if (typeof value !== 'string') return false;
  if ((LAUNCH_DEFAULT_FIELDS as readonly string[]).includes(value)) return true;
  if (value.startsWith('catalog.')) return CATALOG_KEYS.has(value.slice('catalog.'.length));
  return value === 'subConfig.sub1' || value === 'subConfig.sub2' || value === 'subConfig.sub3';
}

/** Reads one path from a draft-shaped object; `undefined` when absent. */
export function readLaunchPath(config: LaunchDraft, path: LaunchDefaultPath): unknown {
  const [head, key] = path.split('.') as [keyof LaunchDraft, string | undefined];
  const top = config[head] as unknown;
  if (key === undefined) return top;
  return top && typeof top === 'object' ? (top as Record<string, unknown>)[key] : undefined;
}

/**
 * The stored profile with only `mask` changed to `values`. Everything outside the mask — other
 * fields, legacy fields, absent optional keys — is carried over as stored. `subConfig` travels
 * separately because the profile keeps it apart.
 */
export function applyDefaultsMask(
  current: { config: LaunchDraft; subConfig: LaunchSubConfig | null },
  mask: readonly LaunchDefaultPath[],
  values: LaunchDraft
): { config: LaunchDraft; subConfig: LaunchSubConfig | null } {
  const config: Record<string, unknown> = structuredClone(current.config) as Record<
    string,
    unknown
  >;
  let subConfig = current.subConfig ? structuredClone(current.subConfig) : null;
  for (const path of mask) {
    const value = readLaunchPath(values, path);
    const [head, key] = path.split('.') as [string, string | undefined];
    if (head === 'subConfig') {
      if (key === undefined) {
        subConfig = value === undefined ? subConfig : (structuredClone(value) as LaunchSubConfig);
        continue;
      }
      const base: LaunchSubConfig = subConfig ?? {
        schemaVersion: 1,
        sub1: [],
        sub2: [],
        sub3: []
      };
      subConfig = { ...base, [key]: structuredClone(value ?? []) } as LaunchSubConfig;
      continue;
    }
    if (key === undefined) {
      if (value === undefined) delete config[head];
      else config[head] = structuredClone(value);
      continue;
    }
    const nested = { ...((config[head] as Record<string, unknown> | undefined) ?? {}) };
    if (value === undefined) delete nested[key];
    else nested[key] = structuredClone(value);
    config[head] = nested;
  }
  return { config: config as LaunchDraft, subConfig };
}

/** The mask paths whose stored value differs between two profile versions. */
export function changedDefaultPaths(
  before: LaunchDraft,
  after: LaunchDraft,
  mask: readonly LaunchDefaultPath[]
): LaunchDefaultPath[] {
  return mask.filter(
    path =>
      JSON.stringify(readLaunchPath(before, path)) !== JSON.stringify(readLaunchPath(after, path))
  );
}
