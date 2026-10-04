/** Display only: preserve canonical decimal strings in storage and requests. */
export function formatFinanceAmount(value: unknown, empty = '—'): string {
  if (value === null || value === undefined) return empty;
  return String(value).replace(/\.00$/, '');
}
