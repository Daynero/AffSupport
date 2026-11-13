// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LaunchConfig, LaunchDetail, LaunchSummary } from '@video-compressor/shared';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope.js';
import { launchConfig, launchSources } from './fixtures/launches.js';
import { LaunchBatch } from '../apps/web/src/team/launches/LaunchBatch.js';
import { planLaunchBatch } from '../apps/web/src/team/launches/batchModel.js';
const seams = vi.hoisted(() => ({
  detail: vi.fn(),
  generate: vi.fn(),
  list: vi.fn(),
  requests: vi.fn()
}));
vi.mock('../apps/web/src/api/team.js', async original => ({
  ...(await original<typeof import('../apps/web/src/api/team.js')>()),
  launchApi: { detail: seams.detail, list: seams.list, refreshSources: vi.fn() }
}));
vi.mock('../apps/web/src/team/launches/useLaunchGeneration.js', () => ({
  useLaunchGeneration: (_team: string, notify: (detail: LaunchDetail) => void) => ({
    busy: false,
    observe: vi.fn(),
    hasUnresolvedRequest: false,
    generate: async (detail: LaunchDetail, config: LaunchConfig) => {
      seams.requests(detail, config);
      seams.generate(detail.id);
      notify({
        ...detail,
        generation: {
          id: `generation-${detail.id}`,
          state: 'running',
          stage: 'catalog_creating',
          stateVersion: '1',
          progress: null,
          errorCode: null,
          childOperationIds: []
        }
      });
    }
  })
}));
function summary(id: string): LaunchSummary {
  return {
    id,
    version: '1',
    sourceMaterialId: 'same',
    offer: `Offer ${id}`,
    social: 'g1',
    creativeAlias: 'v1',
    method: 'other',
    workStatus: 'todo',
    launchDate: null,
    assigneeId: null,
    budgets: [],
    generationState: null,
    hasResult: false
  };
}
const summaries = ['1', '2', '3', '4'].map(summary);
const props = () => ({
  teamId: 'team',
  batchId: 'batch',
  initial: planLaunchBatch(summaries),
  summaries,
  enabled: true,
  onChange: vi.fn(),
  onOpen: vi.fn(),
  onStates: vi.fn(),
  onFinished: vi.fn()
});
beforeEach(() => {
  vi.clearAllMocks();
  seams.detail.mockImplementation(async (_team, id) => ({
    id,
    version: '1',
    draft: launchConfig(),
    expectedSourceSnapshot: {
      ...launchSources,
      schemaVersion: 1,
      ...Object.fromEntries(
        ['agentRowId', 'offerId', 'buyerId', 'materialId'].map(k => [
          k,
          launchConfig()[k as keyof ReturnType<typeof launchConfig>]
        ])
      ),
      catalogSettingsVersion: null
    },
    activeRevision: null,
    generation: null,
    assigneeId: null,
    workStatus: 'todo'
  }));
});
afterEach(cleanup);
it('admits only two at a time, tolerates StrictMode and advances after authoritative completion', async () => {
  const input = props();
  const view = render(
    <StrictMode>
      <LaunchBatch {...input} />
    </StrictMode>
  );
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(2));
  const completed: LaunchSummary = {
    ...summaries[0],
    generationState: 'succeeded',
    generation: {
      id: 'generation-1',
      state: 'succeeded',
      stage: 'result_committed',
      stateVersion: '2',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  };
  view.rerender(
    <StrictMode>
      <LaunchBatch {...input} summaries={[completed, ...summaries.slice(1)]} />
    </StrictMode>
  );
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(3));
  expect(seams.generate.mock.calls.flat()).toEqual(['1', '2', '3']);
});
it('leaves queued drafts untouched when stopped and keeps accepted work', async () => {
  render(<LaunchBatch {...props()} />);
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
  await waitFor(() => expect(screen.getAllByText(/Not submitted/)).toHaveLength(2));
  expect(seams.generate).toHaveBeenCalledTimes(2);
});
it('rejects a changed selected draft without blocking valid siblings', async () => {
  seams.detail.mockResolvedValueOnce({
    id: '1',
    version: '2',
    draft: launchConfig(),
    activeRevision: null,
    generation: null
  });
  render(<LaunchBatch {...props()} />);
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(2));
  expect(seams.generate.mock.calls.flat()).toEqual(['2', '3']);
  expect(screen.getByRole('alert')).toBeTruthy();
});

it('stops a preflight that has not reached server admission yet', async () => {
  let resolve!: (value: unknown) => void;
  const detail = await seams.detail('team', '1');
  seams.detail.mockClear();
  seams.detail.mockImplementation(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  render(<LaunchBatch {...props()} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
  await act(async () => resolve(detail));
  expect(seams.generate).not.toHaveBeenCalled();
});
it('does not admit after permission is revoked during preflight', async () => {
  const resolve: Array<(value: unknown) => void> = [];
  const detail = await seams.detail('team', '1');
  seams.detail.mockClear();
  seams.detail.mockImplementation(
    () =>
      new Promise(r => {
        resolve.push(r);
      })
  );
  const input = props();
  const view = render(<LaunchBatch {...input} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  view.rerender(<LaunchBatch {...input} enabled={false} />);
  await act(async () => resolve.forEach(r => r(detail)));
  expect(seams.generate).not.toHaveBeenCalled();
  await waitFor(() => expect(input.onFinished).toHaveBeenCalled());
});
it('observes accepted work hidden by a list filter and frees its slot', async () => {
  const input = props();
  const view = render(<LaunchBatch {...input} />);
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(2));
  const read = seams.detail.getMockImplementation()!;
  seams.detail.mockImplementation(async (team, id) => ({
    ...(await read(team, id)),
    generation:
      id === '1'
        ? {
            id: 'generation-1',
            state: 'succeeded',
            stage: 'result_committed',
            stateVersion: '2',
            progress: null,
            errorCode: null,
            childOperationIds: []
          }
        : null
  }));
  view.rerender(<LaunchBatch {...input} summaries={[]} reconcileEpoch={1} />);
  await waitFor(() => expect(seams.generate).toHaveBeenCalledTimes(3));
  expect(seams.detail).toHaveBeenCalledWith('team', '1', null, expect.any(AbortSignal));
});

it('never starts queued work under a different actor after an in-flight preflight', async () => {
  setPrivateCacheScope('original', 'team');
  const resolve: Array<(value: unknown) => void> = [];
  const detail = await seams.detail('team', '1');
  seams.detail.mockClear();
  seams.detail.mockImplementation(
    () =>
      new Promise(r => {
        resolve.push(r);
      })
  );
  const input = props();
  render(<LaunchBatch {...input} />);
  await waitFor(() => expect(seams.detail).toHaveBeenCalledTimes(2));
  setPrivateCacheScope('different', 'team');
  await act(async () => resolve.forEach(r => r(detail)));
  await waitFor(() => expect(input.onFinished).toHaveBeenCalled());
  expect(seams.detail).toHaveBeenCalledTimes(2);
  expect(seams.generate).not.toHaveBeenCalled();
  setPrivateCacheScope(null, '');
});

it('preserves four account configurations with five variations of one source', async () => {
  const originalDetail = seams.detail.getMockImplementation()!;
  seams.detail.mockImplementation(async (team, id) => {
    const original = await originalDetail(team, id);
    const agentRowId = `11111111-1111-4111-8111-11111111111${id}`;
    return {
      ...original,
      draft: {
        ...original.draft,
        agentRowId,
        method: 'catalog',
        catalog: {
          ...original.draft.catalog,
          catalogVideoProtocolVersion: 1,
          restitchEnabled: true,
          videoVariationCount: 5,
          videoPublication: { mode: 'immediate' }
        }
      },
      expectedSourceSnapshot: {
        ...original.expectedSourceSnapshot,
        agentRowId,
        accountId: `55555555-5555-4555-8555-55555555555${id}`
      }
    };
  });
  const input = props();
  const view = render(<LaunchBatch {...input} />);
  await waitFor(() => expect(seams.requests).toHaveBeenCalledTimes(2));
  const complete = summaries.map(s => ({
    ...s,
    generationState: 'succeeded' as const,
    generation: {
      id: `generation-${s.id}`,
      state: 'succeeded' as const,
      stage: 'result_committed' as const,
      stateVersion: '2',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  }));
  view.rerender(<LaunchBatch {...input} summaries={complete} />);
  await waitFor(() => expect(seams.requests).toHaveBeenCalledTimes(4));
  const configs = seams.requests.mock.calls.map(([, config]) => config as LaunchConfig);
  expect(new Set(configs.map(c => c.agentRowId)).size).toBe(4);
  expect(new Set(configs.map(c => c.materialId)).size).toBe(1);
  expect(configs.every(c => c.catalog.videoVariationCount === 5 && c.catalog.restitchEnabled)).toBe(
    true
  );
});
