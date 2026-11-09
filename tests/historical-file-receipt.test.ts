import { expect, it } from 'vitest';
import { parseTeamFileOperationResult } from '../packages/shared/src/team/transport';
import { requireCompletedFileOperation } from '../apps/web/src/team/materials/file-operation-outcome';
const receipt = () => ({
  operationId: '47000000-0000-4000-8000-000000000001',
  state: 'succeeded',
  materialId: '47000000-0000-4000-8000-000000000002',
  reused: true,
  historicalReceipt: {
    protocolVersion: 1,
    action: 'trash',
    basis: 'catalog_snapshot',
    observedAt: '2026-11-08T00:00:00Z',
    state: 'changed',
    memberCount: 2,
    matchingCount: 1,
    missingCount: 0
  }
});
it('preserves historical evidence without allowing generic current-success acknowledgement', () => {
  const value = receipt();
  expect(parseTeamFileOperationResult(value)?.historicalReceipt).toEqual(value.historicalReceipt);
  expect(() => requireCompletedFileOperation(value)).toThrow('PROCESS_RESULT_UNCERTAIN');
});
it.each([
  { matchingCount: 3 },
  { missingCount: 2 },
  { memberCount: 0 },
  { memberCount: 5001 },
  { state: 'matches' },
  { observedAt: 'invalid' },
  { basis: 'provider_verified' }
])('refuses malformed or overclaimed historical evidence %j', patch => {
  const value = receipt();
  Object.assign(value.historicalReceipt, patch);
  expect(parseTeamFileOperationResult(value)).toBeNull();
});
it('retains the legacy current-result contract', () => {
  const { historicalReceipt, ...value } = receipt();
  expect(historicalReceipt).toBeTruthy();
  expect(parseTeamFileOperationResult(value)).toEqual(value);
  expect(requireCompletedFileOperation(value)).toEqual(value);
});
