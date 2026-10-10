/** Display only: preserve canonical decimal strings in storage and requests.
 * Fractions are written with a comma, the way the team writes money. */
export function formatFinanceAmount(value: unknown, empty = '—'): string {
  if (value === null || value === undefined) return empty;
  return financeDecimalComma(String(value).replace(/\.00$/, ''));
}

/** What is typed into a money field: a dot becomes the comma, as it is pressed.
 * `parseFinanceMoney` reads either, so nothing else has to change. */
export function financeDecimalComma(value: string): string {
  return value.replace(/\./gu, ',');
}
