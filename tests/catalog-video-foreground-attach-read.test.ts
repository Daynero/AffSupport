import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  attachCatalogForeground,
  catalogForegroundScope
} from '../apps/web/src/api/catalog-video-foreground-client';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';

// 1.4.3 (beta 2026-11-11): with the computer agent killed, every progress read
// threw on the local attach and the creation window said "something went
// wrong", hiding the agent-silent notice and Cancel the server had sent.
const local = vi.hoisted(() => ({ requestBody: vi.fn() }));
vi.mock('../apps/web/src/api/client', () => ({ requestBody: local.requestBody, request: vi.fn() }));

const teamId = '47000000-0000-4000-8000-000000000001';
const actor = '47000000-0000-4000-8000-000000000002';
const pending = {
  outcome: 'preparing_video' as const,
  catalogIntentId: '47000000-0000-4000-8000-000000000003',
  videoSetId: '47000000-0000-4000-8000-000000000006',
  requestedCount: 5,
  registeredCount: 2,
  state: 'preparing' as const,
  executor: {
    mode: 'paired_session' as const,
    enrollmentId: '47000000-0000-4000-8000-000000000004',
    nativeInstanceId: '47000000-0000-4000-8000-000000000005'
  }
};

beforeEach(() => setPrivateCacheScope(actor, 'owner'));
afterEach(() => {
  local.requestBody.mockReset();
  setPrivateCacheScope(null, 'signed-out');
});

it('keeps the server read and marks the agent unreachable when the attach cannot connect', async () => {
  local.requestBody.mockRejectedValue(new Error('CONNECTION_FAILED'));
  const result = await attachCatalogForeground(teamId, pending, catalogForegroundScope());
  expect(result).toEqual({ ...pending, agentUnreachable: true });
});

it('treats a proxy answering for a dead agent as unreachable', async () => {
  local.requestBody.mockRejectedValue(Object.assign(new Error('AGENT_ERROR'), { status: 502 }));
  const result = await attachCatalogForeground(teamId, pending, catalogForegroundScope());
  expect(result).toMatchObject({ agentUnreachable: true });
});

it('keeps the server read unmarked when the agent answers but cannot confirm the run', async () => {
  local.requestBody.mockResolvedValue({
    protocolVersion: 1,
    setId: pending.videoSetId,
    enrollmentId: pending.executor.enrollmentId,
    state: 'unknown'
  });
  const result = await attachCatalogForeground(teamId, pending, catalogForegroundScope());
  expect(result).toBe(pending);
});

it('still refuses an answer that arrives for an account that was replaced', async () => {
  const current = catalogForegroundScope();
  local.requestBody.mockImplementation(async () => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000009', 'owner');
    throw new Error('CONNECTION_FAILED');
  });
  await expect(attachCatalogForeground(teamId, pending, current)).rejects.toThrow(
    'PERMISSION_DENIED'
  );
});
