export interface CatalogCreatedDateRange {
  from?: string | null;
  to?: string | null;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** Empty bounds are open; invalid or reversed input must never widen the result set. */
export function isCatalogCreatedDateRangeValid(range: CatalogCreatedDateRange): boolean {
  const { from, to } = range;
  return (
    (!from || validCalendarDate(from)) &&
    (!to || validCalendarDate(to)) &&
    (!from || !to || from <= to)
  );
}

/** Compare local calendar days, including every instant of the selected end day. */
export function matchesCatalogCreatedAt(
  createdAt: string | null | undefined,
  range: CatalogCreatedDateRange
): boolean {
  const { from, to } = range;
  if (!from && !to) return true;
  if (!isCatalogCreatedDateRangeValid(range) || !createdAt) return false;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(createdAt) ||
    !validCalendarDate(createdAt.slice(0, 10))
  )
    return false;
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return false;
  const local = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return (!from || local >= from) && (!to || local <= to);
}
