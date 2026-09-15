// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskCard } from '../apps/web/src/team/tasks/TaskCard';
import { useCoalescedWrite } from '../apps/web/src/team/tasks/useCoalescedWrite';
import {
  parseStoredDateFilter,
  quickRangeValue,
  localDateValue
} from '../apps/web/src/team/tasks/useTasks';
import { persistedViewKey, usePersistedState, oneOf } from '../apps/web/src/team/persistedView';

/**
 * A task's progress is saved the moment it moves, whatever else is happening: a change made while a
 * save is out is sent right after it, and a card does not hold a one-field edit to its copy's version.
 * And the board's filters come back after a reload.
 */

const TEAM_ID = '32000000-0000-4000-8000-000000000001';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function task(overrides: Partial<TeamTaskSummary> = {}): TeamTaskSummary {
  return {
    id: '32000000-0000-4000-8000-000000000002',
    teamId: TEAM_ID,
    title: 'Launch',
    note: null,
    assigneeId: null,
    assigneeLabelSnapshot: null,
    status: 'todo',
    progressMax: 10,
    progressValue: 0,
    progressManuallySet: false,
    attachmentCount: 0,
    dateOn: null,
    agents: [],
    labels: [],
    createdBy: '32000000-0000-4000-8000-000000000003',
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    completedAt: null,
    ...overrides
  } as TeamTaskSummary;
}

describe('a coalesced write', () => {
  it('sends a value chosen during a save right after it, merged', async () => {
    const first = deferred();
    const written: unknown[] = [];
    const write = vi.fn(async (value: Record<string, number>) => {
      written.push(value);
      if (written.length === 1) await first.promise;
    });
    const { result } = renderHook(() =>
      useCoalescedWrite<Record<string, number>>({
        write,
        merge: (held, next) => ({ ...held, ...next }),
        onError: vi.fn()
      })
    );
    act(() => result.current.send({ progressValue: 3 }));
    act(() => result.current.send({ progressValue: 7 }));
    act(() => result.current.send({ status: 1, progressValue: 10 }));
    expect(written).toEqual([{ progressValue: 3 }]);
    await act(async () => {
      first.resolve();
    });
    await waitFor(() =>
      expect(written).toEqual([{ progressValue: 3 }, { progressValue: 10, status: 1 }])
    );
    await waitFor(() => expect(result.current.saving).toBe(false));
  });

  it('reports a failed save and drops what was held', async () => {
    const onError = vi.fn();
    const write = vi.fn(async () => {
      throw new Error('SOURCE_CHANGED');
    });
    const { result } = renderHook(() => useCoalescedWrite<number>({ write, onError }));
    act(() => result.current.send(1));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the card', () => {
  function renderCard(onUpdate: (patch: unknown) => Promise<TeamTaskSummary>) {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    render(
      <ToastProvider>
        <TeamProvider
          realtime={false}
          initialTeams={[
            {
              id: TEAM_ID,
              name: 'Space',
              role: 'editor',
              permissions: DEFAULT_ROLE_PERMISSIONS.editor,
              connectionState: 'connected'
            }
          ]}
        >
          <TaskCard task={task()} canEdit onOpen={vi.fn()} onUpdate={onUpdate as never} />
        </TeamProvider>
      </ToastProvider>
    );
    return screen.getByRole('slider');
  }

  it('keeps the scale usable while saving and stores the last value chosen', async () => {
    const first = deferred();
    const patches: unknown[] = [];
    const slider = renderCard(async patch => {
      patches.push(patch);
      if (patches.length === 1) await first.promise;
      return task();
    });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-disabled')).toBe('false');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).toBe('10');
    await act(async () => {
      first.resolve();
    });
    await waitFor(() => expect(patches).toEqual([{ progressValue: 1 }, { progressValue: 10 }]));
    expect(slider.getAttribute('aria-valuenow')).toBe('10');
  });
});

describe('the board filters after a reload', () => {
  it('keeps a quick range by its name, so "today" is always today', () => {
    const today = quickRangeValue('today', new Date());
    expect(parseStoredDateFilter({ kind: 'quick', range: 'today' })).toEqual(today);
    expect(parseStoredDateFilter({ kind: 'range', from: '2026-09-01', to: '2026-09-15' })).toEqual({
      kind: 'range',
      from: '2026-09-01',
      to: '2026-09-15'
    });
    expect(
      parseStoredDateFilter({ kind: 'range', from: 'x', to: localDateValue(new Date()) })
    ).toBeNull();
  });

  it('restores a stored choice per space and ignores what it cannot read', () => {
    const key = persistedViewKey(TEAM_ID, 'tasks.status');
    const parse = oneOf(['all', 'todo', 'done'] as const);
    const first = renderHook(() => usePersistedState(key, 'all', parse));
    act(() => first.result.current[1]('done'));
    first.unmount();
    expect(renderHook(() => usePersistedState(key, 'all', parse)).result.current[0]).toBe('done');
    localStorage.setItem(key, '"nonsense"');
    expect(renderHook(() => usePersistedState(key, 'all', parse)).result.current[0]).toBe('all');
    expect(
      renderHook(() =>
        usePersistedState(persistedViewKey('other-space', 'tasks.status'), 'all', parse)
      ).result.current[0]
    ).toBe('all');
  });
});
