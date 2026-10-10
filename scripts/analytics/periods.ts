import type { ResolvedPeriod } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a period token (or an explicit --days N) into a concrete window.
 *
 * Rolling windows (7d/30d/90d and --days N) end at "now" and start N days back.
 * "today" starts at UTC midnight. "all" has no lower bound. The end bound is
 * inclusive (`created_at <= end`), so a window fixed with `--as-of X` contains
 * X itself (031 FR-055); for a window ending "now" the difference is a
 * millisecond nobody can observe.
 *
 * `asOf` (031) fixes the window's end to one instant so a repeated analysis of
 * an unchanged snapshot sees exactly the same rows. It is echoed as
 * `period.as_of`; without it `as_of` is absent and `end` is the moment of the
 * call.
 */
export function resolvePeriod(
  token: string | undefined,
  days: number | undefined,
  asOf?: string
): ResolvedPeriod {
  const now = asOf === undefined ? new Date() : parseAsOf(asOf);
  const end = now.toISOString();
  const fixed = asOf === undefined ? {} : { as_of: end };

  if (typeof days === 'number' && Number.isFinite(days)) {
    if (days <= 0) throw new Error('--days must be a positive number');
    const start = new Date(now.getTime() - days * DAY_MS).toISOString();
    return {
      token: `${days}d`,
      start,
      end,
      label: `last ${days} day${days === 1 ? '' : 's'}`,
      ...fixed
    };
  }

  const normalized = (token ?? '7d').toLowerCase();
  switch (normalized) {
    case 'today': {
      const midnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );
      return { token: 'today', start: midnight.toISOString(), end, label: 'today (UTC)', ...fixed };
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = Number(normalized.replace('d', ''));
      const start = new Date(now.getTime() - n * DAY_MS).toISOString();
      return { token: normalized, start, end, label: `last ${n} days`, ...fixed };
    }
    case 'all':
      return { token: 'all', start: null, end, label: 'all time', ...fixed };
    default:
      throw new Error(
        `Unknown period "${token}". Use one of: today, 7d, 30d, 90d, all — or --days N.`
      );
  }
}

/** `--as-of` must be a complete ISO-8601 instant; a bare date is read as UTC midnight. */
export function parseAsOf(value: string): Date {
  const trimmed = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)
  ) {
    throw new Error(
      `Invalid --as-of "${value}". Use an ISO-8601 instant such as 2026-10-10T12:00:00Z.`
    );
  }
  const date = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --as-of "${value}": not a real date.`);
  }
  return date;
}

/** The calendar day (UTC) an analysis is pinned to — the `audit --write` file name. */
export function asOfDate(period: ResolvedPeriod): string {
  return (period.as_of ?? period.end).slice(0, 10);
}
