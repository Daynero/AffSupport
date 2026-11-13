// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LaunchSummary } from '@video-compressor/shared';
import { batchEligible } from '../apps/web/src/team/launches/batchModel.js';
import {
  durableCardValue,
  durableItemState,
  mergeDurableBatch
} from '../apps/web/src/team/launches/durableBatchModel.js';
import { batchReceipt } from './fixtures/launch-batches.js';
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
describe('durable batch card presentation', () => {
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

it('allows only confirmed saved drafts, excluding existing, unknown and running results', () => {
  expect(batchEligible(draft('1'))).toBe(true);
  expect(batchEligible({ ...draft('1'), hasResult: undefined })).toBe(false);
  expect(batchEligible({ ...draft('1'), hasResult: true })).toBe(false);
  expect(batchEligible({ ...draft('1'), generationState: 'running' })).toBe(false);
});
it('shows the canonical batch progress before the list catches up, without covering later generations', () => {
  const item = batchReceipt().items[0];
  const value = { ...draft(item.launchId), version: item.expectedVersion };
  item.generation!.videoGeneration = {
    setId: 'set',
    state: 'preparing',
    registeredCount: 2,
    requestedCount: 5
  };
  expect(launchCardProgress(durableCardValue(value, item))).toBe(40);
  expect(durableItemState(item)).toBe('running');
  const later = { ...value, generation: { ...item.generation!, id: 'different' } };
  expect(durableCardValue(later, item)).toBe(later);
  const newer = { ...value, generation: { ...item.generation!, stateVersion: '99' } };
  expect(durableCardValue(newer, item)).toBe(newer);
});

it('does not return settled admission to preparation when a slower history read arrives', () => {
  for (const admission of ['accepted', 'refused'] as const) {
    const confirmed = batchReceipt();
    if (admission === 'refused')
      confirmed.items[0] = {
        ...confirmed.items[0],
        admission,
        generation: null,
        generationId: null,
        errorCode: 'SOURCE_CHANGED'
      };
    const older = batchReceipt();
    older.items[0] = {
      ...older.items[0],
      admission: 'pending',
      generation: null,
      generationId: null,
      errorCode: 'DRIVE_UNAVAILABLE'
    };
    expect(mergeDurableBatch(confirmed, older).items[0]).toEqual(confirmed.items[0]);
  }
});

it('preserves registered videos and terminal sets even when the parent state version did not change', () => {
  const confirmed = batchReceipt();
  confirmed.items[0].generation!.videoGeneration = {
    setId: 'set',
    state: 'ready',
    registeredCount: 5,
    requestedCount: 5
  };
  const older = batchReceipt();
  older.items[0].generation!.videoGeneration = {
    setId: 'set',
    state: 'preparing',
    registeredCount: 2,
    requestedCount: 5
  };
  expect(mergeDurableBatch(confirmed, older).items[0].generation?.videoGeneration).toEqual(
    confirmed.items[0].generation?.videoGeneration
  );
  older.items[0].generation!.videoGeneration!.setId = 'another-set';
  expect(
    mergeDurableBatch(confirmed, older).items[0].generation?.videoGeneration?.registeredCount
  ).toBe(2);
});
