/**
 * The catalog updater's rules as the web needs them (feature 023): the three intervals and how far
 * IDs have moved, for the dialog's "next update" preview.
 *
 * A copy of `supabase/functions/_shared/catalog-updater.ts`, which decides; the shared package
 * cannot change in a web-only release. `tests/catalog-updater-parity.test.ts` holds them together.
 */

export const UPDATER_INTERVALS = { '1h': 3_600, '1d': 86_400, '1w': 604_800 } as const;
export type UpdaterInterval = keyof typeof UPDATER_INTERVALS;

export function idOffset(updateCount: number): number {
  if (!Number.isSafeInteger(updateCount) || updateCount < 0) {
    throw new RangeError('update count must be a non-negative integer');
  }
  return 500 * updateCount + (updateCount * (updateCount - 1)) / 2;
}
