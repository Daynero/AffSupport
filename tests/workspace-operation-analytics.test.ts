import { afterEach, expect, it, vi } from 'vitest';
import { analytics } from '../apps/web/src/analytics/service';
import { beginWorkspaceOperation } from '../apps/web/src/team/workspace/operationAnalytics';
afterEach(() => vi.restoreAllMocks());
it('keeps uncertain delivery open for reconciliation and confirms visibility only once', () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const flow = beginWorkspaceOperation('task_copy', crypto.randomUUID(), 10000);
  flow.fail();
  expect(track.mock.calls.map(call => call[0])).toEqual([
    'operation_started',
    'operation_stage_completed'
  ]);
  expect(track.mock.calls[1]![1]).toMatchObject({
    action_identifier: 'unknown',
    error_code: 'UNKNOWN',
    item_count: 500
  });
  flow.stage('confirmed');
  flow.visible();
  flow.visible();
  flow.stage('running');
  expect(track.mock.calls.filter(call => call[0] === 'operation_completed')).toHaveLength(1);
});
it('does not invent a new user request when merely observing a hosted receipt', () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const flow = beginWorkspaceOperation('bulk_trash', crypto.randomUUID(), 50, analytics, true);
  expect(track.mock.calls.some(call => call[0] === 'operation_started')).toBe(false);
  flow.stage('confirmed');
  expect(track.mock.calls.some(call => call[0] === 'operation_completed')).toBe(false);
  flow.visible();
  expect(track.mock.calls.at(-1)![1]).toMatchObject({
    action_identifier: 'result_visible',
    item_count: 50
  });
});
it('reports an explicitly rejected request with its closed reason', () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const flow = beginWorkspaceOperation('task_detach', crypto.randomUUID(), 1);
  flow.fail({ code: 'PERMISSION_DENIED' });
  flow.visible();
  expect(track.mock.calls.at(-1)).toEqual([
    'operation_failed',
    expect.objectContaining({ action_identifier: 'rejected', error_code: 'PERMISSION_DENIED' })
  ]);
});
it('links a detach intent to the exact durable cleanup receipt', () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const id = crypto.randomUUID();
  const flow = beginWorkspaceOperation('task_detach', crypto.randomUUID(), 1);
  flow.receipt(id);
  flow.visible();
  expect(track.mock.calls.at(-1)![1]).toMatchObject({
    run_id: id,
    action_identifier: 'result_visible'
  });
});

it('rejects coerced or malformed hosted receipt fields at the shared boundary', async () => {
  const { isBulkTrashGroup, isTaskCleanupReceipt } = await import('../packages/shared/src/team');
  const id = crypto.randomUUID();
  const item = { materialId: id, idempotencyKey: id, state: 'queued', errorCode: null };
  const group = { id, teamId: id, actorId: id, items: [item] };
  expect(isBulkTrashGroup(group)).toBe(true);
  expect(isBulkTrashGroup({ ...group, items: [{ ...item, state: ['queued'] }] })).toBe(false);
  const receipt = {
    id,
    materialId: id,
    undoUntil: new Date().toISOString(),
    state: 'waiting',
    reason: null
  };
  expect(isTaskCleanupReceipt(receipt)).toBe(true);
  expect(isTaskCleanupReceipt({ ...receipt, state: ['waiting'] })).toBe(false);
  expect(isTaskCleanupReceipt({ ...receipt, reason: ['cleanup_pending'] })).toBe(false);
  expect(isTaskCleanupReceipt({ ...receipt, id: '-'.repeat(36) })).toBe(false);
});
