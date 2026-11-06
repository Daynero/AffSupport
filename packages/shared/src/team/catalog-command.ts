/** Immutable command acceptance, distinct from provider delivery. */
export interface CatalogCommandReceipt {
  commandId: string;
  kind: 'run' | 'retry';
  status: 'accepted' | 'cancelled';
  sourceAttemptId: string | null;
  requestedCount: number;
  acceptedCount: number;
  items: Array<{
    catalogId: string;
    accepted: boolean;
    attemptId: string | null;
    reason:
      'accepted' | 'already_pending' | 'reconciliation_required' | 'cancelled_before_acceptance';
  }>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const CATALOG_COMMAND_MAX_CATALOGS = 500;
export interface CatalogCommandRequest {
  commandId: string;
  catalogIds: string[];
  sourceAttemptId?: string;
}
export const isCatalogCommandUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

/** Strip unrelated properties and bind one canonical, bounded intent to its key. */
export function normalizeCatalogCommandRequest(value: unknown): CatalogCommandRequest | null {
  if (
    !record(value) ||
    !isCatalogCommandUuid(value.commandId) ||
    !Array.isArray(value.catalogIds) ||
    value.catalogIds.length < 1 ||
    value.catalogIds.length > CATALOG_COMMAND_MAX_CATALOGS ||
    !value.catalogIds.every(isCatalogCommandUuid) ||
    (value.sourceAttemptId !== undefined && !isCatalogCommandUuid(value.sourceAttemptId))
  )
    return null;
  const catalogIds = [...new Set(value.catalogIds.map(id => id.toLowerCase()))].sort();
  if (value.sourceAttemptId !== undefined && catalogIds.length !== 1) return null;
  return {
    commandId: value.commandId.toLowerCase(),
    catalogIds,
    ...(value.sourceAttemptId !== undefined
      ? { sourceAttemptId: value.sourceAttemptId.toLowerCase() }
      : {})
  };
}

/** Validation must also bind the receipt to the caller's exact retained intent. */
export function parseCatalogCommandReceipt(
  value: unknown,
  expected: CatalogCommandRequest
): CatalogCommandReceipt | null {
  const intent = normalizeCatalogCommandRequest(expected);
  if (!record(value) || !intent) return null;
  expected = intent;
  const wanted = new Set(expected.catalogIds.map(id => id.toLowerCase()));
  if (expected.sourceAttemptId && (!UUID.test(expected.sourceAttemptId) || wanted.size !== 1))
    return null;
  if (
    !UUID.test(expected.commandId) ||
    wanted.size < 1 ||
    wanted.size > 500 ||
    [...wanted].some(id => !UUID.test(id)) ||
    value.commandId !== expected.commandId ||
    value.kind !== (expected.sourceAttemptId ? 'retry' : 'run') ||
    !['accepted', 'cancelled'].includes(String(value.status)) ||
    value.sourceAttemptId !== (expected.sourceAttemptId ?? null) ||
    value.requestedCount !== wanted.size ||
    typeof value.acceptedCount !== 'number' ||
    !Number.isSafeInteger(value.acceptedCount) ||
    value.acceptedCount < 0 ||
    value.acceptedCount > wanted.size ||
    !Array.isArray(value.items) ||
    value.items.length !== wanted.size
  )
    return null;
  const seen = new Set<string>();
  let accepted = 0;
  const attempts = new Set<string>();
  const items: CatalogCommandReceipt['items'] = [];
  for (const item of value.items) {
    if (
      !record(item) ||
      typeof item.catalogId !== 'string' ||
      !wanted.has(item.catalogId) ||
      seen.has(item.catalogId) ||
      typeof item.accepted !== 'boolean' ||
      !(
        item.attemptId === null ||
        (typeof item.attemptId === 'string' && UUID.test(item.attemptId))
      )
    )
      return null;
    if (value.status === 'cancelled') {
      if (item.accepted || item.attemptId !== null || item.reason !== 'cancelled_before_acceptance')
        return null;
    } else if (item.accepted) {
      if (item.reason !== 'accepted' || item.attemptId === null) return null;
      if (attempts.has(item.attemptId as string) || item.attemptId === expected.sourceAttemptId)
        return null;
      attempts.add(item.attemptId as string);
      accepted++;
    } else if (!['already_pending', 'reconciliation_required'].includes(String(item.reason)))
      return null;
    seen.add(item.catalogId);
    items.push({
      catalogId: item.catalogId,
      accepted: item.accepted,
      attemptId: item.attemptId as string | null,
      reason: item.reason as CatalogCommandReceipt['items'][number]['reason']
    });
  }
  return accepted === value.acceptedCount
    ? {
        commandId: intent.commandId,
        kind: intent.sourceAttemptId ? 'retry' : 'run',
        status: value.status === 'cancelled' ? 'cancelled' : 'accepted',
        sourceAttemptId: intent.sourceAttemptId ?? null,
        requestedCount: wanted.size,
        acceptedCount: accepted,
        items
      }
    : null;
}
