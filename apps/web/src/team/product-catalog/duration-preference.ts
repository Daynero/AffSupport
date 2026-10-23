import type { RestitchDurationValue } from '../../components/ui/RestitchDurationControl';

/** Personal, device-local choice; never a change to the space's shared defaults. */
export function catalogDurationPreferenceKey(userId: string | null, teamId: string): string | null {
  return userId ? `soty.catalog-restitch-duration.v1:${userId}:${teamId}` : null;
}

const minuteSeconds = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 60 &&
  value <= 3600 &&
  value % 60 === 0;

export function parseCatalogDurationPreference(value: unknown): RestitchDurationValue | null {
  if (!value || typeof value !== 'object') return null;
  const {
    finalDurationMode: mode,
    customFinalDurationSeconds: seconds,
    finalDurationRangeSeconds: range
  } = value as Record<string, unknown>;
  if (!minuteSeconds(seconds)) return null;
  if (mode === 'custom' && range === undefined)
    return { finalDurationMode: mode, customFinalDurationSeconds: seconds };
  if (
    mode === 'random-centered' &&
    Array.isArray(range) &&
    range.length === 2 &&
    range.every(minuteSeconds) &&
    range[0] <= range[1]
  )
    return {
      finalDurationMode: mode,
      customFinalDurationSeconds: seconds,
      finalDurationRangeSeconds: [range[0], range[1]]
    };
  return null;
}

export function readCatalogDurationPreference(key: string | null): RestitchDurationValue | null {
  if (!key) return null;
  try {
    return parseCatalogDurationPreference(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    // Corrupt/blocked storage means using the space's defaults, never refusing the dialog.
    return null;
  }
}

export function saveCatalogDurationPreference(
  key: string | null,
  value: RestitchDurationValue
): void {
  if (!key) return;
  const parsed = parseCatalogDurationPreference(value);
  if (!parsed) return;
  try {
    localStorage.setItem(key, JSON.stringify(parsed));
  } catch {
    // The in-memory choice still survives toggling re-stitch within the current dialog.
  }
}
