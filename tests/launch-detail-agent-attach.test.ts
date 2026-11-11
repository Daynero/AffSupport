import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { launchConfig, launchSources } from './fixtures/launches';

// 1.4.3 QA round 9: after the computer agent was killed and restarted, the launch
// read itself failed on the local attach (11 × 409 while the server had not yet
// handed the restarted agent its set), and the dialog asked to retry at once.
const local = vi.hoisted(() => ({ requestBody: vi.fn() }));
const rpc = vi.hoisted(() => ({ detail: null as unknown }));
vi.mock('../apps/web/src/api/client', () => ({ requestBody: local.requestBody, request: vi.fn() }));
vi.mock('../apps/web/src/lib/supabase', () => {
  const query = () => {
    const result = Promise.resolve({ data: rpc.detail, error: null });
    return Object.assign(result, { abortSignal: () => result });
  };
  return {
    requireSupabaseClient: () => ({ rpc: query }),
    getSupabaseClient: () => ({ rpc: query }),
    withFreshSession: async (run: () => PromiseLike<unknown>) => run()
  };
});

const teamId = '47000000-0000-4000-8000-000000000001';
const actor = '47000000-0000-4000-8000-000000000002';
const sources = {
  ...launchSources,
  schemaVersion: 1,
  agentRowId: launchConfig().agentRowId,
  offerId: launchConfig().offerId,
  buyerId: launchConfig().buyerId,
  materialId: launchConfig().materialId,
  catalogSettingsVersion: null
};
const detail = {
  id: 'launch',
  version: '2',
  draft: { campaignCount: 3 },
  expectedSourceSnapshot: null,
  assigneeId: null,
  workStatus: 'in_progress',
  activeRevision: {
    id: 'revision',
    revisionNo: 1,
    kind: 'generated',
    generationId: 'generation',
    config: launchConfig(),
    sources,
    baselineRevisionId: null,
    baseline: {
      advertisingUrl: 'https://example.invalid/?sub1=buyer',
      subValues: { sub1: 'buyer', sub2: null, sub3: null },
      campaigns: [{ ordinal: 1, budget: 10, adStart: 1, adEnd: 3, name: 'Campaign 1' }]
    },
    overrides: {},
    catalog: null,
    createdAt: '2026-10-15T00:00:00Z'
  },
  generation: {
    id: 'generation',
    state: 'interrupted',
    stage: 'catalog_creating',
    stateVersion: '4',
    progress: null,
    errorCode: 'PROCESS_RESULT_UNCERTAIN',
    childOperationIds: [],
    videoGeneration: {
      setId: '47000000-0000-4000-8000-000000000006',
      requestedCount: 5,
      registeredCount: 1,
      state: 'preparing',
      executor: {
        mode: 'paired_session',
        enrollmentId: '47000000-0000-4000-8000-000000000004',
        nativeInstanceId: '47000000-0000-4000-8000-000000000005'
      }
    }
  }
};

beforeEach(() => {
  setPrivateCacheScope(actor, 'owner');
  rpc.detail = detail;
});
afterEach(() => {
  local.requestBody.mockReset();
  setPrivateCacheScope(null, 'signed-out');
});

it('keeps the launch read when the restarted agent still refuses its set', async () => {
  const { launchApi } = await import('../apps/web/src/api/launches');
  local.requestBody.mockRejectedValue(
    Object.assign(new Error('PROCESS_RESULT_UNCERTAIN'), { status: 409 })
  );
  const read = await launchApi.detail(teamId, 'launch');
  expect(local.requestBody).toHaveBeenCalled();
  expect(read.generation).toMatchObject({ id: 'generation', state: 'interrupted' });
});

it('keeps the launch read when the agent cannot be reached at all', async () => {
  const { launchApi } = await import('../apps/web/src/api/launches');
  local.requestBody.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(launchApi.detail(teamId, 'launch')).resolves.toMatchObject({ id: 'launch' });
});

it('still refuses a read that finishes for an account that was replaced', async () => {
  const { launchApi } = await import('../apps/web/src/api/launches');
  local.requestBody.mockImplementation(async () => {
    setPrivateCacheScope('47000000-0000-4000-8000-000000000009', 'owner');
    throw new Error('CONNECTION_FAILED');
  });
  await expect(launchApi.detail(teamId, 'launch')).rejects.toThrow('PERMISSION_DENIED');
});
