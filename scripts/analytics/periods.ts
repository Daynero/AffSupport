import type { ResolvedPeriod } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a period token (or an explicit --days N) into a concrete window.
 *
 * Rolling windows (7d/30d/90d and --days N) end at "now" and start N days back.
 * "today" starts at UTC midnight. "all" has no lower bound. The end bound is
 * always exclusive so the same event is never counted in two adjacent windows.
 */
export function resolvePeriod(token: string | undefined, days: number | undefined): ResolvedPeriod {
  const now = new Date();
  const end = now.toISOString();

  if (typeof days === 'number' && Number.isFinite(days)) {
    if (days <= 0) throw new Error('--days must be a positive number');
    const start = new Date(now.getTime() - days * DAY_MS).toISOString();
    return { token: `${days}d`, start, end, label: `last ${days} day${days === 1 ? '' : 's'}` };
  }

  const normalized = (token ?? '7d').toLowerCase();
  switch (normalized) {
    case 'today': {
      const midnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );
      return { token: 'today', start: midnight.toISOString(), end, label: 'today (UTC)' };
    }
    case '7d':
    case '30d':
    case '90d': {
      const n = Number(normalized.replace('d', ''));
      const start = new Date(now.getTime() - n * DAY_MS).toISOString();
      return { token: normalized, start, end, label: `last ${n} days` };
    }
    case 'all':
      return { token: 'all', start: null, end, label: 'all time' };
    default:
      throw new Error(
        `Unknown period "${token}". Use one of: today, 7d, 30d, 90d, all — or --days N.`
      );
  }
}
