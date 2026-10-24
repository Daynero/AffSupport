import { expect, it } from 'vitest';
import {
  parseWorkspaceRecovery,
  type WorkspaceRecovery
} from '../packages/shared/src/team/recovery';
import {
  canOfferTaskDetachUndo,
  isTaskCleanupReceipt,
  type TaskCleanupReceipt
} from '../packages/shared/src/team/task-cleanup';

const ID = '34000000-0000-4000-8000-000000000001';
const recovery: WorkspaceRecovery = {
  id: ID,
  epoch: 1,
  state: 'partial',
  registeredAt: '2026-10-21T10:00:00.000Z',
  lastProgressAt: '2026-10-21T10:00:01.000Z',
  counts: { pending: 0, running: 0, waiting: 1, resumed: 0, completed: 0, skipped: 0, blocked: 0 },
  reasons: [{ code: 'waiting_agent', count: 1, action: 'agent' }],
  canManageRecovery: true
};

it('accepts only closed cleanup reasons in an otherwise valid server receipt', () => {
  const receipt = {
    id: ID,
    materialId: ID,
    state: 'waiting',
    undoUntil: '2026-10-21T10:01:00.000Z'
  };
  for (const reason of [
    'cleanup_unverified',
    'cleanup_referenced',
    'cleanup_forbidden',
    'cleanup_pending'
  ]) {
    expect(isTaskCleanupReceipt({ ...receipt, reason })).toBe(true);
  }
  expect(isTaskCleanupReceipt({ ...receipt, reason: 'unknown_provider_payload' })).toBe(false);
});

it('retains a validated dependency reason without accepting unknown or malformed diagnostic fields', () => {
  expect(parseWorkspaceRecovery(recovery)).toEqual(recovery);
  for (const reason of [
    null,
    { code: 'untrusted', count: 1, action: 'agent' },
    { code: 'waiting_agent', count: 0, action: 'agent' },
    { code: 'waiting_agent', count: 1.5, action: 'agent' },
    { code: 'waiting_agent', count: '1', action: 'agent' },
    { code: 'waiting_agent', count: 1, action: 'untrusted' }
  ]) {
    expect(parseWorkspaceRecovery({ ...recovery, reasons: [reason] })).toBeNull();
  }
});

it.each(['waiting', 'retained', 'claimed', 'trashed', 'cancelled'] as const)(
  'offers Undo for %s only when the server receipt leaves the full safety interval',
  state => {
    const now = Date.parse('2026-10-21T10:00:00.000Z');
    const receipt: TaskCleanupReceipt = {
      id: ID,
      materialId: ID,
      state,
      reason: null,
      undoUntil: new Date(now + 20_000).toISOString()
    };
    expect(canOfferTaskDetachUndo(receipt, now)).toBe(state === 'waiting' || state === 'retained');
    expect(
      canOfferTaskDetachUndo({ ...receipt, undoUntil: new Date(now + 19_999).toISOString() }, now)
    ).toBe(false);
    expect(
      canOfferTaskDetachUndo({ ...receipt, undoUntil: new Date(now - 1).toISOString() }, now)
    ).toBe(false);
  }
);
