import type {
  AdminSpaceRequest,
  AdminTariffEvent,
  AdminTariffRow,
  AdminTariffState
} from '@video-compressor/shared';

/**
 * The admin tariff table's arithmetic (034, US3) — the order, the filters and
 * their counts. Every state, date and seat count is the server's; this file
 * only sorts and groups what it was given.
 */

export const TARIFF_FILTERS = [
  'all',
  'le7',
  'le3',
  'grace',
  'blocked',
  'pending',
  'legacy',
  'requests'
] as const;
export type TariffFilter = (typeof TARIFF_FILTERS)[number];

/** US3.2 — after the term → the nearest end → running → waiting → paused. */
const ORDER: Record<AdminTariffState, number> = {
  grace: 0,
  expiring: 1,
  active: 2,
  legacy: 3,
  internal: 3,
  pending: 4,
  pending_expired: 4,
  blocked: 5
};

export function sortTariffs(rows: readonly AdminTariffRow[]): AdminTariffRow[] {
  return [...rows].sort(
    (a, b) =>
      ORDER[a.state] - ORDER[b.state] ||
      a.endsOn.localeCompare(b.endsOn) ||
      a.ownerEmail.localeCompare(b.ownerEmail)
  );
}

function running(row: AdminTariffRow): boolean {
  return row.state === 'active' || row.state === 'expiring';
}

export function matchesFilter(row: AdminTariffRow, filter: TariffFilter): boolean {
  switch (filter) {
    case 'all':
    case 'requests':
      return true;
    case 'le7':
      return running(row) && row.daysLeft <= 7;
    case 'le3':
      return running(row) && row.daysLeft <= 3;
    case 'grace':
      return row.state === 'grace';
    case 'blocked':
      return row.state === 'blocked';
    case 'pending':
      return row.state === 'pending' || row.state === 'pending_expired';
    case 'legacy':
      return row.state === 'legacy' || row.legacyAlso;
  }
}

export function matchesSearch(row: AdminTariffRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.ownerEmail, row.ownerName ?? '', row.teamName ?? '']
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle);
}

export function openRequests(requests: readonly AdminSpaceRequest[]): AdminSpaceRequest[] {
  return requests.filter(request => !request.handledAt);
}

export function filterCounts(
  rows: readonly AdminTariffRow[],
  requests: readonly AdminSpaceRequest[],
  legacySpaces: number
): Record<TariffFilter, number> {
  const counts = Object.fromEntries(TARIFF_FILTERS.map(filter => [filter, 0])) as Record<
    TariffFilter,
    number
  >;
  for (const row of rows) {
    for (const filter of TARIFF_FILTERS) {
      if (filter !== 'all' && filter !== 'requests' && matchesFilter(row, filter)) {
        counts[filter] += 1;
      }
    }
  }
  counts.all = rows.length;
  counts.legacy += legacySpaces;
  counts.requests = openRequests(requests).length;
  return counts;
}

/**
 * The date a "+1 month" press would give, for the button's own label.
 *
 * A preview, not a decision: the server extends from the end date while the
 * plan runs and from today once it is paused (US3.4), and its answer is the one
 * shown afterwards. Postgres adds a month the same way — the 31st of January
 * becomes the last day of February — so the label and the result agree.
 */
export function addMonthsPreview(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

export function kyivToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

export function extendBase(
  row: Pick<AdminTariffRow, 'state' | 'revokedAt' | 'endsOn' | 'tariffToday'>
): string {
  // A paused or revoked plan is extended from today (US3.4; a revoked one is restored).
  return row.state === 'blocked' || row.revokedAt !== null
    ? (row.tariffToday ?? kyivToday())
    : row.endsOn;
}

/** People who would lose access — members, not the invitations that also hold seats. */
export function peopleOnSeats(row: AdminTariffRow): number {
  return Math.max(0, row.seatsUsed - row.pendingInvites);
}

export type EventValues = Record<string, unknown> | null;

export function eventField(values: EventValues, key: string): string | null {
  const value = values?.[key];
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function eventNumber(values: EventValues, key: string): number | null {
  const value = values?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function newestFirst(events: readonly AdminTariffEvent[]): AdminTariffEvent[] {
  return [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
