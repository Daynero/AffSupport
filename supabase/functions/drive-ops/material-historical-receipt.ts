import { TeamFunctionError } from '../_shared/errors.ts';
interface HistoricalReceipt {
  operationId: string;
  state: 'succeeded';
  materialId: string;
  reused: true;
  historicalReceipt: {
    protocolVersion: 1;
    action: 'trash' | 'restore';
    basis: 'catalog_snapshot';
    observedAt: string;
    state: 'matches' | 'changed' | 'unknown';
    memberCount: number;
    matchingCount: number;
    missingCount: number;
  };
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
/** Separate parser protects the readback boundary even before shared consumers
 * adopt protocol 2. No boolean here asserts current provider generation. */
export function parseMaterialHistoricalReceipt(
  value: unknown,
  expected: { operationId: string; materialId: string; action: 'trash' | 'restore' }
): HistoricalReceipt {
  const bad = () => new TeamFunctionError('PROCESS_RESULT_UNCERTAIN', { retryable: false });
  if (
    !record(value) ||
    value.operationId !== expected.operationId ||
    value.materialId !== expected.materialId ||
    value.state !== 'succeeded' ||
    value.reused !== true ||
    !record(value.historicalReceipt)
  )
    throw bad();
  const h = value.historicalReceipt;
  if (
    h.protocolVersion !== 1 ||
    h.action !== expected.action ||
    h.basis !== 'catalog_snapshot' ||
    typeof h.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(h.observedAt)) ||
    !['matches', 'changed', 'unknown'].includes(String(h.state))
  )
    throw bad();
  for (const key of ['memberCount', 'matchingCount', 'missingCount'])
    if (!Number.isSafeInteger(h[key]) || Number(h[key]) < 0 || Number(h[key]) > 5000) throw bad();
  const total = Number(h.memberCount),
    matching = Number(h.matchingCount),
    missing = Number(h.missingCount);
  if (
    total < 1 ||
    matching + missing > total ||
    (h.state === 'matches' && (matching !== total || missing !== 0)) ||
    (h.state === 'changed' && (missing !== 0 || matching === total)) ||
    (h.state === 'unknown' && missing === 0)
  )
    throw bad();
  return {
    operationId: expected.operationId,
    materialId: expected.materialId,
    state: 'succeeded',
    reused: true,
    historicalReceipt: {
      protocolVersion: 1,
      action: expected.action,
      basis: 'catalog_snapshot',
      // UTC with `Z`, whatever offset the database rendered (1.4.3: `+00:00`
      // made every client refuse the receipt).
      observedAt: new Date(h.observedAt).toISOString(),
      state: h.state as 'matches' | 'changed' | 'unknown',
      memberCount: total,
      matchingCount: matching,
      missingCount: missing
    }
  };
}
