// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LaunchSummary } from '@video-compressor/shared';
import {
  admitBatchItems,
  batchCardState,
  planLaunchBatch
} from '../apps/web/src/team/launches/batchModel.js';
import {
  launchCardState,
  launchCardProgress
} from '../apps/web/src/team/launches/launchPresentation.js';
const draft = (id: string, sourceMaterialId = 'video'): LaunchSummary => ({
  id,
  sourceMaterialId,
  version: '1',
  hasResult: false,
  launchDate: null,
  offer: '',
  social: '',
  creativeAlias: '',
  method: 'catalog',
  workStatus: 'todo',
  assigneeId: null,
  budgets: [],
  generationState: null
});
describe('bounded source-grouped batch scheduling', () => {
  it('groups source locality, excludes generated/unknown drafts and deduplicates selection', () => {
    const jobs = planLaunchBatch([
      draft('1', 'b'),
      draft('2', 'a'),
      draft('3', 'b'),
      draft('4', 'a'),
      draft('1', 'b'),
      { ...draft('5'), hasResult: true },
      { ...draft('6'), hasResult: undefined }
    ]);
    expect(jobs.map(j => j.source.id)).toEqual(['2', '4', '1', '3']);
    expect(new Set(jobs.map(j => j.flowId)).size).toBe(4);
    expect(admitBatchItems(jobs, false).filter(j => j.state === 'dispatching')).toHaveLength(2);
  });
  it('retains accepted and uncertain slots; stop never cancels accepted work', () => {
    const jobs = admitBatchItems(
      planLaunchBatch([draft('1'), draft('2'), draft('3'), draft('4')]),
      false
    );
    jobs[0].state = 'accepted';
    jobs[1].state = 'uncertain';
    expect(admitBatchItems(jobs, false).map(j => j.state)).toEqual([
      'accepted',
      'uncertain',
      'queued',
      'queued'
    ]);
    expect(admitBatchItems(jobs, true).map(j => j.state)).toEqual([
      'accepted',
      'uncertain',
      'stopped',
      'stopped'
    ]);
    jobs[1].state = 'blocked';
    expect(admitBatchItems(jobs, false).map(j => j.state)).toEqual([
      'accepted',
      'blocked',
      'dispatching',
      'queued'
    ]);
  });
  it('separates drafts, stopped, failed, ready and pending video receipts', () => {
    expect(launchCardState(draft('1'))).toBe('draft');
    expect(launchCardState({ ...draft('1'), hasResult: undefined })).toBe('unknown');
    expect(launchCardState({ ...draft('1'), generationState: 'canceled' })).toBe('canceled');
    expect(launchCardState({ ...draft('1'), hasResult: true, generationState: 'failed' })).toBe(
      'failed'
    );
    const item: LaunchSummary = {
      ...draft('1'),
      generationState: 'succeeded',
      generation: {
        id: 'g',
        state: 'succeeded',
        stage: 'result_committed',
        stateVersion: '1',
        progress: null,
        errorCode: null,
        childOperationIds: [],
        videoGeneration: { setId: 'set', state: 'preparing', registeredCount: 2, requestedCount: 5 }
      }
    };
    expect(launchCardState(item)).toBe('running');
    expect(launchCardProgress(item)).toBe(40);
    expect(launchCardState({ ...draft('1'), generationState: 'succeeded' })).toBe('ready');
  });
});

it('shows local admission and receipts immediately while the server list is still a draft', () => {
  const value = draft('pending');
  const item = planLaunchBatch([value])[0];
  for (const [state, expected] of [
    ['queued', 'queued'],
    ['dispatching', 'running'],
    ['accepted', 'running'],
    ['completed', 'ready'],
    ['blocked', 'failed'],
    ['uncertain', 'unknown'],
    ['deferred', 'unknown'],
    ['partial', 'partial'],
    ['canceled', 'canceled'],
    ['stopped', undefined]
  ] as const)
    expect(batchCardState(value, { ...item, state })).toBe(expected);
  expect(batchCardState(value, undefined)).toBeUndefined();
});
it('does not cover a different authoritative generation with an old uncertain batch label', () => {
  const value = {
    ...draft('pending'),
    generation: {
      id: 'new-generation',
      requestKey: 'new-key',
      state: 'succeeded' as const,
      stage: 'result_committed' as const,
      stateVersion: '1',
      progress: null,
      errorCode: null,
      childOperationIds: []
    }
  };
  const item = planLaunchBatch([draft('pending')])[0]!;
  expect(batchCardState(value, { ...item, state: 'deferred' })).toBeUndefined();
});
it('lets the authoritative generation replace local admission and earlier completed receipts', () => {
  const value = { ...draft('pending'), generationState: 'running' as const };
  const item = planLaunchBatch([draft('pending')])[0];
  for (const state of ['accepted', 'completed', 'blocked'] as const)
    expect(batchCardState(value, { ...item, state })).toBeUndefined();
});
