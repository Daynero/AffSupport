/** Safe, per-attempt receipt only. No content, image facts or prices enter diagnostics. */
export interface CatalogContentEvidence {
  content_receipt_status: 'unavailable' | 'policy_selected' | 'frozen' | 'invalid';
  content_policy_version: 1 | null;
  planned_row_count: number | null;
  automatic_row_count: number | null;
  retained_row_count: number | null;
}
const COUNTS = ['planned_row_count', 'automatic_row_count', 'retained_row_count'] as const;
const empty = (
  status: CatalogContentEvidence['content_receipt_status']
): CatalogContentEvidence => ({
  content_receipt_status: status,
  content_policy_version: null,
  planned_row_count: null,
  automatic_row_count: null,
  retained_row_count: null
});
/** Absent optional columns remain unavailable; malformed evidence never changes the operation outcome. */
export function parseCatalogContentEvidence(
  row: Partial<Record<keyof CatalogContentEvidence, unknown>>
): CatalogContentEvidence {
  const noCounts = COUNTS.every(key => row[key] == null);
  if (
    (row.content_receipt_status == null || row.content_receipt_status === 'unavailable') &&
    row.content_policy_version == null &&
    noCounts
  )
    return empty('unavailable');
  if (
    row.content_receipt_status === 'policy_selected' &&
    row.content_policy_version === 1 &&
    noCounts
  )
    return { ...empty('policy_selected'), content_policy_version: 1 };
  if (
    row.content_receipt_status !== 'frozen' ||
    row.content_policy_version !== 1 ||
    !COUNTS.every(
      key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= 400
    ) ||
    Number(row.planned_row_count) < 1 ||
    Number(row.automatic_row_count) + Number(row.retained_row_count) !== row.planned_row_count
  )
    return empty('invalid');
  return {
    content_receipt_status: 'frozen',
    content_policy_version: 1,
    planned_row_count: Number(row.planned_row_count),
    automatic_row_count: Number(row.automatic_row_count),
    retained_row_count: Number(row.retained_row_count)
  };
}
