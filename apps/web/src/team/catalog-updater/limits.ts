/**
 * The catalog updater's rules as the web needs them (feature 023): the three intervals and how far
 * IDs have moved, for the dialog's "next update" preview.
 *
 * A copy of `supabase/functions/_shared/catalog-updater.ts`, which decides; the shared package
 * cannot change in a web-only release. `tests/catalog-updater-parity.test.ts` holds them together.
 */

export const UPDATER_INTERVALS = { '1h': 3_600, '1d': 86_400, '1w': 604_800 } as const;
export type UpdaterPreset = keyof typeof UPDATER_INTERVALS;
/** A preset, or an interval of the updater's own in whole hours: `'6h'`. */
export type UpdaterInterval = UpdaterPreset | `${number}h`;
export const CUSTOM_INTERVAL_MAX_HOURS = 720;

const CUSTOM_INTERVAL = /^[1-9][0-9]{0,2}h$/u;

export function parseUpdaterInterval(value: unknown): UpdaterInterval | null {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(UPDATER_INTERVALS, value)) return value as UpdaterPreset;
  return CUSTOM_INTERVAL.test(value) && Number(value.slice(0, -1)) <= CUSTOM_INTERVAL_MAX_HOURS
    ? (value as `${number}h`)
    : null;
}

export function isUpdaterPreset(interval: UpdaterInterval): interval is UpdaterPreset {
  return Object.hasOwn(UPDATER_INTERVALS, interval);
}

/** Whole hours typed by a person, as the interval the server stores; null when out of range. */
export function customIntervalFromHours(input: string): UpdaterInterval | null {
  const trimmed = input.trim();
  return /^\d{1,3}$/u.test(trimmed) ? parseUpdaterInterval(`${Number(trimmed)}h`) : null;
}

export function idOffset(updateCount: number): number {
  if (!Number.isSafeInteger(updateCount) || updateCount < 0) {
    throw new RangeError('update count must be a non-negative integer');
  }
  return 500 * updateCount + (updateCount * (updateCount - 1)) / 2;
}
