// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LaunchDetail, LaunchSummary } from '@video-compressor/shared';
import { LaunchBatch } from '../apps/web/src/team/launches/LaunchBatch.js';
import { planLaunchBatch, type LaunchBatchItem } from '../apps/web/src/team/launches/batchModel.js';
import { TeamApiError } from '../apps/web/src/api/team.js';
import { launchObservedGeneration } from '../apps/web/src/team/launches/analytics.js';
import { launchConfig, launchSources } from './fixtures/launches.js';
const api = vi.hoisted(() => ({
  detail: vi.fn(),
  save: vi.fn(),
  generate: vi.fn(),
  list: vi.fn()
}));
vi.mock('../apps/web/src/api/team.js', async original => ({
  ...(await original<typeof import('../apps/web/src/api/team.js')>()),
  launchApi: api
}));
vi.mock('../apps/web/src/team/launches/analytics.js', () => ({
  launchIntent: vi.fn(),
  launchAction: vi.fn(),
  launchLocalStage: vi.fn(),
  launchObservedGeneration: vi.fn(),
  launchBatchAdmission: vi.fn()
}));
// The real batch AND generation hook run against a deterministic, idempotent server seam.
const rows = new Map<string, LaunchDetail>();
const writes = new Map<string, Set<string>>();
let states: LaunchBatchItem[];
let initial: LaunchBatchItem[];
let summaries: LaunchSummary[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rows.clear();
  writes.clear();
  states = [];
  summaries = Array.from({ length: 10 }, (_, n) => ({
    id: `launch-${n}`,
    version: '1',
    offer: `Offer ${n}`,
    social: 'g1',
    creativeAlias: 'v1',
    method: 'other' as const,
    workStatus: 'todo' as const,
    launchDate: null,
    assigneeId: null,
    budgets: [],
    generationState: null,
    hasResult: false
  }));
  initial = planLaunchBatch(summaries);
  for (const s of summaries)
    rows.set(s.id, {
      id: s.id,
      version: '1',
      draft: launchConfig(),
      expectedSourceSnapshot: {
        ...launchSources,
        ...launchConfig(),
        catalogSettingsVersion: null
      },
      activeRevision: null,
      generation: null,
      assigneeId: null,
      workStatus: 'todo'
    });
  api.detail.mockImplementation(async (_team, id) => structuredClone(rows.get(id)));
  api.save.mockImplementation(async intent => ({ id: intent.id, version: '2' }));
  api.generate.mockImplementation(async (_team, id, version, key) => {
    const keys = writes.get(id) ?? new Set<string>();
    keys.add(key);
    writes.set(id, keys);
    const row = rows.get(id)!;
    rows.set(id, {
      ...row,
      version: '3',
      generation: {
        id: `generation-${id}`,
        requestKey: key,
        inputVersion: version,
        state: 'succeeded',
        stage: 'result_committed',
        stateVersion: '2',
        progress: null,
        errorCode: null,
        childOperationIds: []
      }
    });
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function batch() {
  let epoch = 0;
  const props = {
    teamId: 'team',
    batchId: 'batch',
    initial,
    summaries,
    enabled: true,
    onStates: (value: LaunchBatchItem[]) => {
      states = value;
    },
    onChange: vi.fn(),
    onOpen: vi.fn(),
    onFinished: vi.fn()
  };
  const surface = (reconcileEpoch: number) => <LaunchBatch {...{ ...props, reconcileEpoch }} />;
  const view = render(surface(epoch));
  return {
    ...view,
    props,
    async pulse(ms = 10_000) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
      await act(async () => {
        view.rerender(surface(++epoch));
      });
    }
  };
}
it('completes all ten after the first two committed generations lose their replies, without duplicate keys', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (['launch-0', 'launch-1'].includes(args[1])) throw new TypeError('network reply lost');
    return {};
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 12; i++) await view.pulse();
  expect(states.map(i => i.state)).toEqual(Array(10).fill('completed'));
  expect(writes.size).toBe(10);
  expect([...writes.values()].every(keys => keys.size === 1)).toBe(true);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('replays lost draft-save receipts with the identical frozen save key and admits each launch once', async () => {
  const seen = new Set<string>();
  api.save.mockImplementation(async intent => {
    if (['launch-0', 'launch-1'].includes(intent.id) && !seen.has(intent.id)) {
      seen.add(intent.id);
      throw new TypeError('saved but reply lost');
    }
    return { id: intent.id, version: '2' };
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 6; i++) await view.pulse();
  expect(states.every(i => i.state === 'completed')).toBe(true);
  for (const id of ['launch-0', 'launch-1']) {
    const saves = api.save.mock.calls.filter(([intent]) => intent.id === id);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual(saves[0]);
  }
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it.each(['SOURCE_CHANGED', 'RESTITCH_SOURCES_INVALID', 'LAUNCH_VERSION_CONFLICT'])(
  'isolates a source deleted/changed or draft edited at admission: %s',
  async code => {
    const commit = api.generate.getMockImplementation()!;
    api.generate.mockImplementation(async (...args) => {
      if (args[1] === 'launch-0') throw new TeamApiError(code as never, false);
      return commit(...args);
    });
    const view = batch();
    await act(async () => {});
    await view.pulse();
    expect(states.filter(i => i.state === 'completed')).toHaveLength(9);
    expect(states[0]!.state).toBe('blocked');
    expect(writes.has('launch-0')).toBe(false);
  }
);

it.each(['failed', 'partial', 'canceled'] as const)(
  'releases a %s parent even if its video projection still says preparing',
  async state => {
    const commit = api.generate.getMockImplementation()!;
    api.generate.mockImplementation(async (...args) => {
      await commit(...args);
      if (args[1] === 'launch-0') {
        const row = rows.get(args[1])!;
        rows.set(args[1], {
          ...row,
          generation: {
            ...row.generation!,
            state,
            videoGeneration: {
              setId: 'set',
              state: 'preparing',
              requestedCount: 5,
              registeredCount: 1
            }
          }
        });
      }
      return {};
    });
    const view = batch();
    await act(async () => {});
    await view.pulse();
    expect(states.filter(i => i.state === 'completed')).toHaveLength(9);
    expect(states[0]!.state).toBe(state === 'failed' ? 'blocked' : state);
    expect(api.generate).toHaveBeenCalledTimes(10);
  }
);

it.each(['RATE_LIMITED', 'DRIVE_UNAVAILABLE'] as const)(
  'recovers a temporary Google %s without a fresh request',
  async code => {
    const commit = api.generate.getMockImplementation()!,
      seen = new Set<string>();
    api.generate.mockImplementation(async (...args) => {
      if (['launch-0', 'launch-1'].includes(args[1]) && !seen.has(args[1])) {
        seen.add(args[1]);
        throw new TeamApiError(code, true);
      }
      return commit(...args);
    });
    const view = batch();
    await act(async () => {});
    await view.pulse();
    expect(states.every(i => i.state === 'completed')).toBe(true);
    for (const id of ['launch-0', 'launch-1']) {
      const calls = api.generate.mock.calls.filter(call => call[1] === id);
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
    }
  }
);

it('bounds persistent provider retries and keeps the other eight launches moving', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    if (['launch-0', 'launch-1'].includes(args[1]))
      throw new TeamApiError('DRIVE_UNAVAILABLE', true);
    return commit(...args);
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 30; i++) await view.pulse();
  expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
  for (const id of ['launch-0', 'launch-1']) {
    const calls = api.generate.mock.calls.filter(call => call[1] === id);
    expect(calls.length).toBeLessThanOrEqual(12);
    expect(calls.length).toBeGreaterThan(3);
    expect(new Set(calls.map(call => call[3])).size).toBe(1);
  }
});

it('times out two stalled preflight reads without admitting them or starving eight healthy drafts', async () => {
  const read = api.detail.getMockImplementation()!;
  api.detail.mockImplementation((...args) =>
    ['launch-0', 'launch-1'].includes(args[1]) ? new Promise(() => {}) : read(...args)
  );
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 8; i++) await view.pulse(16_000);
  expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
  expect(api.generate).toHaveBeenCalledTimes(8);
});

it('ignores a late POST reply after exact terminal readback has completed the batch', async () => {
  const commit = api.generate.getMockImplementation()!,
    late: Array<() => void> = [];
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (['launch-0', 'launch-1'].includes(args[1])) await new Promise<void>(r => late.push(r));
    return {};
  });
  const view = batch();
  await act(async () => {});
  await view.pulse(31_000);
  for (let i = 0; i < 5; i++) await view.pulse();
  expect(states.every(i => i.state === 'completed')).toBe(true);
  await act(async () => {
    late.forEach(resolve => resolve());
  });
  expect(api.generate).toHaveBeenCalledTimes(10);
  expect(states.every(i => i.state === 'completed')).toBe(true);
});

it('stopping an uncertain batch prevents all automatic mutation replays and leaves queued drafts untouched', async () => {
  api.generate.mockRejectedValue(new TypeError('lost before commit'));
  const view = batch();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
  for (let i = 0; i < 6; i++) await view.pulse();
  expect(api.generate).toHaveBeenCalledTimes(2);
  expect(states.filter(i => i.state === 'stopped')).toHaveLength(8);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
});

it('does not mistake a long running encode for failure or start more healthy work', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    const row = rows.get(args[1])!;
    rows.set(args[1], { ...row, generation: { ...row.generation!, state: 'running' } });
    return {};
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 40; i++) await view.pulse();
  expect(api.generate).toHaveBeenCalledTimes(2);
  expect(states.filter(i => i.state === 'accepted')).toHaveLength(2);
  expect(states.filter(i => i.state === 'queued')).toHaveLength(8);
  expect(launchObservedGeneration).toHaveBeenCalledTimes(2);
});

it('warns on browser closure and never submits late saved drafts after the surface unmounts', async () => {
  const late: Array<() => void> = [];
  api.save.mockImplementation(
    intent => new Promise(resolve => late.push(() => resolve({ id: intent.id, version: '2' })))
  );
  const view = batch();
  await act(async () => {});
  const closing = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closing);
  expect(closing.defaultPrevented).toBe(true);
  view.unmount();
  await act(async () => {
    late.forEach(resolve => resolve());
  });
  expect(api.generate).not.toHaveBeenCalled();
  const closed = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closed);
  expect(closed.defaultPrevented).toBe(false);
});

it('rejects another generation receipt instead of attributing its success to the lost batch request', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (args[1] === 'launch-0') {
      const row = rows.get(args[1])!;
      rows.set(args[1], {
        ...row,
        generation: { ...row.generation!, id: 'replacement', requestKey: 'another-request' }
      });
      throw new TypeError('old reply lost');
    }
    return {};
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 8; i++) await view.pulse();
  expect(states[0]!.state).toBe('deferred');
  expect(states.filter(i => i.state === 'completed')).toHaveLength(9);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('ignores an older failed summary and accepts a newer terminal receipt', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (['launch-0', 'launch-1'].includes(args[1])) {
      const row = rows.get(args[1])!;
      rows.set(args[1], {
        ...row,
        generation: { ...row.generation!, state: 'running', stateVersion: '10' }
      });
    }
    return {};
  });
  const view = batch();
  await act(async () => {});
  const current = rows.get('launch-0')!.generation!;
  view.props.summaries = [
    { ...summaries[0]!, generation: { ...current, state: 'failed', stateVersion: '9' } },
    ...summaries.slice(1)
  ];
  await view.pulse();
  expect(states[0]!.state).toBe('accepted');
  expect(api.generate).toHaveBeenCalledTimes(2);
  view.props.summaries = [
    { ...summaries[0]!, generation: { ...current, state: 'canceled', stateVersion: '11' } },
    ...summaries.slice(1)
  ];
  await view.pulse();
  expect(states[0]!.state).toBe('canceled');
  expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
});

it('aborts timed-out recovery reads and never has more than two in flight while healthy jobs finish', async () => {
  const read = api.detail.getMockImplementation()!,
    commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (['launch-0', 'launch-1'].includes(args[1])) throw new TypeError('reply lost');
    return {};
  });
  let active = 0,
    maximum = 0;
  api.detail.mockImplementation((...args) => {
    const signal = args[3] as AbortSignal | undefined;
    if (signal && ['launch-0', 'launch-1'].includes(args[1]))
      return new Promise((_resolve, reject) => {
        active++;
        maximum = Math.max(maximum, active);
        signal.addEventListener(
          'abort',
          () => {
            active--;
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    return read(...args);
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 12; i++) await view.pulse(16_000);
  expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
  expect(maximum).toBe(2);
  view.unmount();
  await act(async () => {});
  expect(active).toBe(0);
});

it('reconciles a stale empty detail after confirmed acceptance instead of leaving the first two dispatching forever', async () => {
  const read = api.detail.getMockImplementation()!,
    seen = new Set<string>();
  api.detail.mockImplementation(async (...args) => {
    const row = await read(...args);
    if (['launch-0', 'launch-1'].includes(args[1]) && row.generation && !seen.has(args[1])) {
      seen.add(args[1]);
      return { ...row, generation: null };
    }
    return row;
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 6; i++) await view.pulse();
  expect(states.every(i => i.state === 'completed')).toBe(true);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('does not adopt a replacement generation returned after a successful admission POST', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (args[1] === 'launch-0') {
      const row = rows.get(args[1])!;
      rows.set(args[1], {
        ...row,
        generation: { ...row.generation!, id: 'replacement', requestKey: 'someone-else' }
      });
    }
    return {};
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 8; i++) await view.pulse();
  expect(states[0]!.state).toBe('deferred');
  expect(states.filter(i => i.state === 'completed')).toHaveLength(9);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('recovers all ten automatically after a five-minute outage before any preflight read succeeds', async () => {
  const read = api.detail.getMockImplementation()!,
    started = Date.now();
  api.detail.mockImplementation(async (...args) => {
    if (Date.now() - started < 300_000) throw new TypeError('service offline');
    return read(...args);
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 60; i++) await view.pulse();
  expect(states.every(i => i.state === 'completed')).toBe(true);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('resumes parked admissions after a long outage with their original keys and no manual retry', async () => {
  const commit = api.generate.getMockImplementation()!,
    started = Date.now();
  api.generate.mockImplementation(async (...args) => {
    if (['launch-0', 'launch-1'].includes(args[1]) && Date.now() - started < 300_000)
      throw new TypeError('admission transport offline');
    return commit(...args);
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 60; i++) await view.pulse();
  expect(states.every(i => i.state === 'completed')).toBe(true);
  for (const id of ['launch-0', 'launch-1']) {
    const calls = api.generate.mock.calls.filter(call => call[1] === id);
    expect(new Set(calls.map(call => call[3])).size).toBe(1);
    expect(calls.length).toBeLessThanOrEqual(6);
  }
});
it('continues eight healthy siblings when two accepted items become permanently unreadable', async () => {
  const commit = api.generate.getMockImplementation()!;
  api.generate.mockImplementation(async (...args) => {
    await commit(...args);
    if (['launch-0', 'launch-1'].includes(args[1])) {
      rows.delete(args[1]);
      throw new TypeError('lost reply');
    }
    return {};
  });
  api.detail.mockImplementation(async (_team, id) => {
    if (!rows.has(id)) throw new TeamApiError('NOT_FOUND', false);
    return structuredClone(rows.get(id));
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 12; i++) await view.pulse();
  expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
  expect(api.generate).toHaveBeenCalledTimes(10);
});

it('reserves a free slot atomically for parked retries while a healthy encode remains active', async () => {
  const commit = api.generate.getMockImplementation()!;
  let recovered = false;
  const pending: Array<() => Promise<void>> = [];
  api.generate.mockImplementation(async (...args) => {
    if (['launch-0', 'launch-1'].includes(args[1])) {
      if (!recovered) throw new TypeError('offline');
      await new Promise<void>(resolve =>
        pending.push(async () => {
          await commit(...args);
          resolve();
        })
      );
      return {};
    }
    await commit(...args);
    if (args[1] === 'launch-2') {
      const row = rows.get(args[1])!;
      rows.set(args[1], { ...row, generation: { ...row.generation!, state: 'running' } });
    }
    return {};
  });
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 18; i++) await view.pulse();
  expect(states.filter(i => i.state === 'completed')).toHaveLength(7);
  expect(states.filter(i => i.state === 'accepted')).toHaveLength(1);
  recovered = true;
  for (let i = 0; i < 60 && !pending.length; i++) await view.pulse();
  expect(pending).toHaveLength(1);
  expect(states.filter(i => ['accepted', 'uncertain'].includes(i.state))).toHaveLength(2);
  expect(states.filter(i => i.state === 'deferred')).toHaveLength(1);
  await act(async () => {
    await pending[0]!();
  });
  for (let i = 0; i < 10 && pending.length < 2; i++) await view.pulse();
  expect(pending).toHaveLength(2);
  await act(async () => {
    await pending[1]!();
  });
  expect(states.filter(i => i.state === 'completed')).toHaveLength(9);
  expect(states[2]!.state).toBe('accepted');
});

it('keeps Stop available when every remaining item is parked and stops future cooldown replays', async () => {
  initial = initial.slice(0, 2);
  summaries = summaries.slice(0, 2);
  api.generate.mockRejectedValue(new TypeError('offline'));
  const view = batch();
  await act(async () => {});
  for (let i = 0; i < 18; i++) await view.pulse();
  expect(states.every(i => i.state === 'deferred')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
  const beforeStop = api.generate.mock.calls.length;
  for (let i = 0; i < 80; i++) await view.pulse();
  expect(api.generate).toHaveBeenCalledTimes(beforeStop);
  expect(states.every(i => i.state === 'deferred')).toBe(true);
});

it.each([2, 10])(
  'stops internal Google backoff before a second admission is sent for a %i-item batch',
  async count => {
    initial = initial.slice(0, count);
    summaries = summaries.slice(0, count);
    api.generate.mockRejectedValue(new TeamApiError('DRIVE_UNAVAILABLE', true));
    const view = batch();
    await act(async () => {});
    expect(api.generate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
    for (let i = 0; i < 8; i++) await view.pulse();
    expect(api.generate).toHaveBeenCalledTimes(2);
    expect(states.filter(i => i.state === 'stopped')).toHaveLength(count - 2);
  }
);

it('does not admit a draft whose save reply arrives after Stop queue', async () => {
  const saved: Array<() => void> = [];
  api.save.mockImplementation(
    intent => new Promise(resolve => saved.push(() => resolve({ id: intent.id, version: '2' })))
  );
  const view = batch();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Stop queue' }));
  await act(async () => {
    saved.forEach(resolve => resolve());
  });
  for (let i = 0; i < 8; i++) await view.pulse();
  expect(api.generate).not.toHaveBeenCalled();
  expect(states.filter(i => i.state === 'stopped')).toHaveLength(8);
});

it.each(['cancel_requested', 'canceled_with_cleanup_pending'] as const)(
  'lets eight siblings finish while two cancellations remain %s, without replaying them',
  async state => {
    const commit = api.generate.getMockImplementation()!;
    api.generate.mockImplementation(async (...args) => {
      await commit(...args);
      if (['launch-0', 'launch-1'].includes(args[1])) {
        const row = rows.get(args[1])!;
        rows.set(args[1], { ...row, generation: { ...row.generation!, state } });
        throw new TypeError('cancellation raced with a lost reply');
      }
      return {};
    });
    const view = batch();
    await act(async () => {});
    for (let i = 0; i < 60; i++) await view.pulse();
    expect(states.filter(i => i.state === 'completed')).toHaveLength(8);
    expect(states.filter(i => i.state === 'deferred')).toHaveLength(2);
    expect(api.generate).toHaveBeenCalledTimes(10);
    for (const id of ['launch-0', 'launch-1']) {
      const row = rows.get(id)!;
      rows.set(id, {
        ...row,
        generation: { ...row.generation!, state: 'canceled', stateVersion: '3' }
      });
    }
    for (let i = 0; i < 3; i++) await view.pulse();
    expect(states.filter(i => i.state === 'canceled')).toHaveLength(2);
    expect(api.generate).toHaveBeenCalledTimes(10);
  }
);
