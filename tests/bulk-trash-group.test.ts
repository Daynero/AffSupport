import { expect, it } from 'vitest';
import { isBulkTrashGroup } from '../packages/shared/src/team/bulk-trash';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const receipt = {
  protocolVersion: 1,
  action: 'trash',
  basis: 'catalog_snapshot',
  observedAt: '2026-11-08T10:00:00Z',
  state: 'changed',
  memberCount: 1,
  matchingCount: 0,
  missingCount: 0
};
const item = (extra: Record<string, unknown> = {}) => ({
  materialId: id(3),
  idempotencyKey: 'key-1',
  state: 'queued',
  errorCode: null,
  ...extra
});
const group = (items: unknown[]) => ({ id: id(1), teamId: id(2), actorId: id(4), items });

it('accepts hosted receipts with every state and an optional confirmed historical receipt', () => {
  expect(
    isBulkTrashGroup(
      group([
        item(),
        item({ state: 'failed', errorCode: 'DRIVE_UNAVAILABLE' }),
        item({ state: 'confirmed', historicalReceipt: receipt }),
        item({ state: 'confirmed', historicalReceipt: undefined })
      ])
    )
  ).toBe(true);
});

it('refuses a historical receipt that is not confirmed or does not parse', () => {
  expect(isBulkTrashGroup(group([item({ historicalReceipt: receipt })]))).toBe(false);
  expect(
    isBulkTrashGroup(
      group([item({ state: 'confirmed', historicalReceipt: { ...receipt, basis: 'provider' } })])
    )
  ).toBe(false);
  const stateless: Record<string, unknown> = item({ historicalReceipt: receipt });
  delete stateless.state;
  expect(isBulkTrashGroup(group([stateless]))).toBe(false);
});

it('refuses malformed groups and items', () => {
  expect(isBulkTrashGroup(null)).toBe(false);
  expect(isBulkTrashGroup({ ...group([]), id: 'not-a-uuid' })).toBe(false);
  expect(isBulkTrashGroup({ ...group([]), items: 'x' })).toBe(false);
  expect(isBulkTrashGroup(group(Array.from({ length: 501 }, () => item())))).toBe(false);
  expect(isBulkTrashGroup(group([null]))).toBe(false);
  expect(isBulkTrashGroup(group([item({ materialId: 'x' })]))).toBe(false);
  expect(isBulkTrashGroup(group([item({ idempotencyKey: 'k'.repeat(201) })]))).toBe(false);
  expect(isBulkTrashGroup(group([item({ state: 'done' })]))).toBe(false);
  expect(isBulkTrashGroup(group([item({ errorCode: 'lower' })]))).toBe(false);
});

it('accepts the hosted dismissal flag only as a boolean', () => {
  expect(isBulkTrashGroup({ ...group([item()]), dismissed: true })).toBe(true);
  expect(isBulkTrashGroup({ ...group([item()]), dismissed: false })).toBe(true);
  expect(isBulkTrashGroup({ ...group([item()]), dismissed: 'yes' })).toBe(false);
});
