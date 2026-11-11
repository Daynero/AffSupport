import { expect, it } from 'vitest';
import type { LaunchGeneration, LaunchGenerationStep } from '../packages/shared/src/team/launches';
import {
  launchProgressStages,
  newLaunchProgressMemory,
  rememberLaunchProgress
} from '../apps/web/src/team/launches/progress';
const step = (
  stage: LaunchGenerationStep['stage'],
  state: LaunchGenerationStep['state'] = 'succeeded',
  attemptNo = 1
): LaunchGenerationStep => ({
  id: `${stage}-${attemptNo}`,
  stage,
  state,
  attemptNo,
  errorCode: null
});
const base = {
  id: 'generation',
  stateVersion: '1',
  state: 'running',
  stage: 'catalog_creating',
  progress: null,
  errorCode: null,
  childOperationIds: [],
  restitchOperationId: 'video-child'
} as LaunchGeneration;
const labels = (key: string) => key;
function observe(
  memory: ReturnType<typeof newLaunchProgressMemory>,
  patch: Partial<LaunchGeneration>,
  childSucceeded = false
) {
  const generation = { ...base, ...patch };
  const stages = launchProgressStages(
    {
      generation,
      stage: generation.stage,
      method: 'catalog',
      restitch: true,
      childSucceeded,
      attention: false,
      fraction: generation.progress
        ? generation.progress.completed / generation.progress.total
        : undefined
    },
    labels
  );
  return rememberLaunchProgress(memory, {
    scope: generation.id,
    generation,
    stage: generation.stage,
    stages,
    attention: false
  });
}
const state = (entries: ReturnType<typeof observe>, id: string) =>
  entries.find(entry => entry.id === id)!.state;
it('keeps a finalized video green when the catalog has a higher attempt number, including after remount', () => {
  const entries = observe(newLaunchProgressMemory(), {
    stage: 'catalog_planning',
    steps: [step('restitch_processing'), step('catalog_planning', 'running', 2)]
  });
  expect(state(entries, 'prepare')).toBe('complete');
  expect(state(entries, 'video')).toBe('complete');
  expect(state(entries, 'catalog')).toBe('active');
});
it('retains completed states and the active frontier through newer partial and backward coordinator reads', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, {
    steps: [step('restitch_processing')],
    progress: { completed: 3, total: 4, unit: 'items', source: 'worker' }
  });
  const entries = observe(memory, { stateVersion: '2', stage: 'preparing', steps: [] });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'complete', 'active', 'pending']);
  expect(entries.find(entry => entry.id === 'catalog')?.fraction).toBeGreaterThan(0);
  expect(memory.stage).toBe('catalog_creating');
});
it('retains a local finalized receipt after the native stream is cleared', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, { stage: 'restitch_processing', state: 'waiting_dependency' }, true);
  const entries = observe(memory, { stateVersion: '2', stage: 'preparing', steps: [] });
  expect(state(entries, 'video')).toBe('complete');
});
it('ignores older state versions, including a stale retry marker', () => {
  const memory = newLaunchProgressMemory();
  const confirmed = observe(memory, {
    stateVersion: '8',
    stage: 'result_committing',
    steps: [step('restitch_processing'), step('catalog_registering')]
  });
  expect(
    observe(memory, {
      stateVersion: '7',
      stage: 'preparing',
      steps: [step('restitch_preparing', 'running', 3)]
    })
  ).toEqual(confirmed);
});
it('resets a real catalog retry without undoing preparation or the video', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, {
    stage: 'catalog_creating',
    steps: [step('restitch_processing'), step('catalog_creating', 'running')],
    progress: { completed: 3, total: 4, unit: 'items', source: 'worker' }
  });
  const entries = observe(memory, {
    stateVersion: '2',
    steps: [step('restitch_processing'), step('catalog_creating', 'running', 2)],
    progress: { completed: 1, total: 4, unit: 'items', source: 'worker' }
  });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'complete', 'active', 'pending']);
  expect(entries.find(entry => entry.id === 'catalog')?.fraction).toBe(0.0625);
});
it('resets video and downstream work for a replacement child, preserving accepted preparation', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, {
    stage: 'result_committing',
    steps: [step('restitch_processing'), step('catalog_registering')]
  });
  const entries = observe(memory, {
    stateVersion: '2',
    stage: 'restitch_preparing',
    restitchOperationId: 'replacement-child',
    steps: [step('restitch_preparing', 'running', 2)]
  });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'active', 'pending', 'pending']);
});
it('starts a new generation with fresh states and does not infer completion from a partial fraction', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, {
    state: 'succeeded',
    stage: 'result_committed',
    stateVersion: '100',
    attemptNo: 9
  });
  expect(
    observe(memory, {
      id: 'new-generation',
      stage: 'preparing',
      restitchOperationId: null,
      steps: []
    }).map(entry => entry.state)
  ).toEqual(['active', 'pending', 'pending', 'pending']);
});
it('does not use a successful video receipt from an older video attempt', () => {
  const entries = observe(newLaunchProgressMemory(), {
    stage: 'restitch_preparing',
    steps: [step('restitch_processing'), step('restitch_preparing', 'running', 2)]
  });
  expect(state(entries, 'video')).toBe('active');
});

it('resets measured catalog work on the actual parent retry even when all step counters remain one', () => {
  const memory = newLaunchProgressMemory();
  observe(memory, {
    attemptNo: 1,
    steps: [step('restitch_processing')],
    progress: { completed: 3, total: 4, unit: 'items', source: 'worker' }
  });
  const entries = observe(memory, {
    attemptNo: 2,
    stateVersion: '2',
    steps: [step('restitch_processing')],
    progress: { completed: 1, total: 4, unit: 'items', source: 'worker' }
  });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'complete', 'active', 'pending']);
  expect(entries.find(entry => entry.id === 'catalog')?.fraction).toBe(0.0625);
});

it('starts a catalog retry after the retained video instead of returning to preparation, including after remount', () => {
  const entries = observe(newLaunchProgressMemory(), {
    stage: 'preparing',
    attemptNo: 2,
    steps: [step('restitch_processing'), step('preparing', 'running', 2)]
  });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'complete', 'active', 'pending']);
});
it('keeps preparation done when a lost lease puts the stage back after the video set is ready (1.4.3)', () => {
  // Beta 2026-11-11: fence 3→5, the coordinator re-ran preflight ("preparing")
  // while the durable video set was already ready; a reopened launch showed
  // "Step 1 of 4" with preparation unchecked next to a checked video.
  const entries = observe(newLaunchProgressMemory(), {
    stage: 'preparing',
    restitchOperationId: null,
    steps: [step('preparing', 'running', 1)],
    videoGeneration: {
      setId: '11111111-1111-4111-8111-111111111111',
      requestedCount: 1,
      registeredCount: 1,
      state: 'ready'
    }
  });
  expect(entries.map(entry => entry.state)).toEqual(['complete', 'complete', 'active', 'pending']);
});
