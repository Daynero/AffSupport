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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BulkTrashGroup, TeamMaterialRow } from '@video-compressor/shared';
import { analytics } from '../apps/web/src/analytics/service';
import { BulkTrashPanel } from '../apps/web/src/team/explorer/BulkTrashPanel';
import { TeamApiError } from '../apps/web/src/api/team';
import { useBulkTrash, type BulkTrashClient } from '../apps/web/src/team/explorer/useBulkTrash';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
const team = '37000000-0000-4000-8000-000000000001';
const actor = '37000000-0000-4000-8000-000000000002';
const rows = Array.from(
  { length: 50 },
  (_, i) =>
    ({
      id: `37000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
      name: `File ${i}`,
      category: null
    }) as TeamMaterialRow
);
beforeEach(() => {
  localStorage.clear();
  setPrivateCacheScope(actor, 'bulk-test-owner');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  setPrivateCacheScope(null, 'bulk-test-ended');
});
it('reuses an unacknowledged batch identity after remount even when receipt reads still omit it', async () => {
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => []),
    startBulkTrash: vi.fn(async () => {
      throw new TeamApiError('DRIVE_UNAVAILABLE', true);
    }),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = { trashMaterial: vi.fn() };
  const first = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {
    await expect(first.result.current.start(rows.slice(0, 2), tail)).rejects.toThrow();
  });
  first.unmount();
  const next = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {
    await expect(next.result.current.start(rows.slice(0, 2).reverse(), tail)).rejects.toThrow();
  });
  const calls = vi.mocked(client.startBulkTrash).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]![1]).toBe(calls[0]![1]);
  expect(calls[1]![2]).toEqual(calls[0]![2]);
  expect(tail.trashMaterial).not.toHaveBeenCalled();
});
it('renders 50 authoritative results, continues after failure, and recovers the same group from another session', async () => {
  let hosted: BulkTrashGroup[] = [];
  const writes = new Map<string, number>();
  let retry = false;
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => structuredClone(hosted)),
    startBulkTrash: vi.fn(async (_team: string, id: string, ids: string[]) => {
      const group: BulkTrashGroup = {
        id,
        teamId: team,
        actorId: actor,
        items: ids.map(materialId => ({
          materialId,
          idempotencyKey: `${id}:${materialId}`,
          state: 'queued',
          errorCode: null
        }))
      };
      hosted = [group];
      return structuredClone(group);
    }),
    prepareBulkTrashItem: vi.fn(async () => structuredClone(hosted[0]!)),
    markBulkTrashRequest: vi.fn(async (_team, _group, id) => {
      const item = hosted[0]!.items.find(item => item.materialId === id)!;
      if (item.state === 'queued') item.state = 'unknown';
    })
  };
  const tail = {
    trashMaterial: vi.fn(async ({ materialId }: { materialId: string }) => {
      writes.set(materialId, (writes.get(materialId) ?? 0) + 1);
      const item = hosted[0]!.items.find(item => item.materialId === materialId)!;
      if (materialId === rows[4]!.id && !retry) {
        item.state = 'failed';
        item.errorCode = 'DRIVE_UNAVAILABLE';
        throw new Error('failure');
      }
      item.state = 'confirmed';
      item.errorCode = null;
    })
  };
  function View() {
    const state = useBulkTrash(team, 0, client);
    return (
      <>
        <button onClick={() => void state.start(rows, tail)}>Start</button>
        <button onClick={() => void state.retry(state.groups[0]!, rows, tail)}>Retry</button>
        {state.groups.flatMap(group =>
          group.items.map(item => (
            <p key={item.materialId}>
              {item.materialId}:{item.state}
            </p>
          ))
        )}
      </>
    );
  }
  const first = render(<View />);
  fireEvent.click(screen.getByText('Start'));
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(49));
  expect(screen.getAllByText(/:failed$/u)).toHaveLength(1);
  const invalidatedAt = performance.now();
  first.unmount();
  render(<View />);
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(49));
  expect(performance.now() - invalidatedAt).toBeLessThan(1000);
  retry = true;
  fireEvent.click(screen.getByText('Retry'));
  await waitFor(() => expect(screen.getAllByText(/:confirmed$/u)).toHaveLength(50));
  expect(writes.get(rows[4]!.id)).toBe(2);
  expect([...writes].filter(([id]) => id !== rows[4]!.id).every(([, count]) => count === 1)).toBe(
    true
  );
});
it('does not publish a delayed old-space receipt after switching spaces', async () => {
  let finish: (groups: BulkTrashGroup[]) => void = () => {};
  const client: BulkTrashClient = {
    listBulkTrash: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve;
          })
      )
      .mockResolvedValue([]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  function View({ id }: { id: string }) {
    const state = useBulkTrash(id, 0, client);
    return <span>{state.groups.length}</span>;
  }
  const view = render(<View id={team} />);
  await act(async () => {});
  expect(client.listBulkTrash).toHaveBeenCalledOnce();
  view.rerender(<View id="other" />);
  await act(async () => finish([{ id: 'old', teamId: team, actorId: actor, items: [] }]));
  expect(screen.getByText('0')).toBeTruthy();
});

it.each(['queued', 'unknown'] as const)(
  'keeps a definitive refusal separate from a prior %s outcome',
  async initial => {
    const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
    let hosted: BulkTrashGroup = {
      id: 'group',
      teamId: team,
      actorId: actor,
      items: [
        {
          materialId: rows[0]!.id,
          idempotencyKey: 'unchanged-key',
          state: initial,
          errorCode: null
        }
      ]
    };
    const client: BulkTrashClient = {
      listBulkTrash: vi.fn(async () => [structuredClone(hosted)]),
      startBulkTrash: vi.fn(),
      prepareBulkTrashItem: vi.fn(async () => structuredClone(hosted)),
      markBulkTrashRequest: vi.fn(async (_team, _group, _material, error) => {
        hosted = {
          ...hosted,
          items: hosted.items.map(item => ({
            ...item,
            state: item.state === 'failed' ? 'failed' : 'unknown',
            errorCode: error ?? null
          }))
        };
      })
    };
    const tail = {
      trashMaterial: vi.fn(async () => {
        if (initial === 'queued') hosted.items[0]!.state = 'failed';
        throw new TeamApiError('PERMISSION_DENIED', false);
      })
    };
    const view = renderHook(() => useBulkTrash(team, 0, client, actor));
    await waitFor(() => expect(view.result.current.groups).toHaveLength(1));
    await act(async () =>
      view.result.current.retry(view.result.current.groups[0]!, rows.slice(0, 1), tail)
    );
    expect(view.result.current.groups[0]?.items[0]).toMatchObject({
      state: initial === 'queued' ? 'failed' : 'unknown',
      errorCode: 'PERMISSION_DENIED',
      idempotencyKey: 'unchanged-key'
    });
    expect(
      track.mock.calls.some(
        ([, properties]) =>
          properties &&
          'source_kind' in properties &&
          properties.source_kind === 'trash_request' &&
          properties.error_code === 'PERMISSION_DENIED'
      )
    ).toBe(true);
    expect(tail.trashMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'unchanged-key' })
    );
    const unknown = track.mock.calls.some(
      ([, properties]) =>
        properties &&
        'action_identifier' in properties &&
        properties.action_identifier === 'unknown'
    );
    expect(unknown).toBe(initial === 'unknown');
    render(
      <BulkTrashPanel
        group={view.result.current.groups[0]!}
        rows={rows}
        uncertain={false}
        onVisible={() => {}}
      />
    );
    expect(
      screen.getByText(initial === 'queued' ? /^Failed ·/ : /^Awaiting confirmation ·/)
    ).toBeTruthy();
  }
);

it('records unchanged hosted outcomes once and preserves a later authoritative failure transition', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const hosted: BulkTrashGroup = {
    id: 'group',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'key',
        state: 'unknown',
        errorCode: 'PERMISSION_DENIED'
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [structuredClone(hosted)]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() => expect(view.result.current.groups).toHaveLength(1));
  await act(async () => {
    for (let i = 0; i < 10; i++) await view.result.current.refresh();
  });
  expect(
    track.mock.calls.filter(
      ([, properties]) =>
        properties &&
        'action_identifier' in properties &&
        properties.action_identifier === 'unknown'
    )
  ).toHaveLength(1);
  hosted.items[0]!.state = 'failed';
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(track).toHaveBeenCalledWith(
    'operation_stage_completed',
    expect.objectContaining({ action_identifier: 'partial', error_code: 'PERMISSION_DENIED' })
  );
});

it('coalesces catalog revision bursts while a bulk receipt read is pending', async () => {
  let finish!: (groups: BulkTrashGroup[]) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<BulkTrashGroup[]>(resolve => {
          finish = resolve;
        })
    )
    .mockResolvedValue([]);
  const client: BulkTrashClient = {
    listBulkTrash: list,
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(({ revision }) => useBulkTrash(team, revision, client, actor), {
    initialProps: { revision: 0 }
  });
  await act(async () => {});
  for (let revision = 1; revision <= 10; revision++) view.rerender({ revision });
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish([]);
  });
  expect(list).toHaveBeenCalledTimes(2);
});

it('pauses hidden automatic receipt reads but permits explicit reconciliation', async () => {
  let visibility: DocumentVisibilityState = 'hidden';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const list = vi.fn().mockResolvedValue([]);
  const client: BulkTrashClient = {
    listBulkTrash: list,
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(({ revision }) => useBulkTrash(team, revision, client, actor), {
    initialProps: { revision: 7 }
  });
  view.rerender({ revision: 8 });
  await act(async () => {});
  expect(list).not.toHaveBeenCalled();
  visibility = 'visible';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(list).toHaveBeenCalledOnce();
  visibility = 'hidden';
  await act(async () => {
    expect(await view.result.current.refresh()).toEqual([]);
  });
  expect(list).toHaveBeenCalledTimes(2);
});

it('returns fresh hosted receipts to manual reconciliation and retires old callbacks', async () => {
  const completions: Array<(value: BulkTrashGroup[]) => void> = [];
  const list = vi.fn(() => new Promise<BulkTrashGroup[]>(resolve => completions.push(resolve)));
  const client: BulkTrashClient = {
    listBulkTrash: list,
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {});
  let settled = false;
  const refresh = view.result.current.refresh;
  const confirming = refresh().then(receipts => {
    settled = true;
    return receipts;
  });
  await act(async () => {
    completions[0]!([]);
  });
  expect(completions).toHaveLength(2);
  expect(settled).toBe(false);
  const hosted: BulkTrashGroup[] = [
    {
      id: 'group',
      teamId: team,
      actorId: actor,
      items: [
        {
          materialId: rows[0]!.id,
          idempotencyKey: 'key',
          state: 'failed',
          errorCode: 'PERMISSION_DENIED'
        }
      ]
    }
  ];
  await act(async () => {
    completions[1]!(hosted);
    expect(await confirming).toEqual(hosted);
  });
  expect(view.result.current.groups).toEqual(hosted);
  view.unmount();
  await expect(refresh()).rejects.toMatchObject({ name: 'AbortError' });
  expect(list).toHaveBeenCalledTimes(2);
});

it('aborts a stalled receipt read at its deadline and allows a fresh retry', async () => {
  vi.useFakeTimers();
  const list = vi
    .fn<(...args: unknown[]) => Promise<BulkTrashGroup[]>>()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue([]);
  const client: BulkTrashClient = {
    listBulkTrash: list,
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {});
  const signal = (list.mock.calls[0]![1] as { signal: AbortSignal }).signal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(signal.aborted).toBe(true);
  expect(view.result.current.uncertain).toBe(true);
  await act(async () => {
    expect(await view.result.current.refresh()).toEqual([]);
  });
  expect(view.result.current.uncertain).toBe(false);
  expect(list).toHaveBeenCalledTimes(2);
});

it('releases a stalled batch acceptance wait without replacing the unresolved intent', async () => {
  vi.useFakeTimers();
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => []),
    startBulkTrash: vi.fn(() => new Promise<BulkTrashGroup>(() => {})),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = { trashMaterial: vi.fn() };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  let result: unknown;
  await act(async () => {
    void view.result.current.start(rows.slice(0, 1), tail).catch(cause => {
      result = cause;
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(result).toMatchObject({ code: 'PROCESS_RESULT_UNCERTAIN' });
  expect(view.result.current.uncertain).toBe(true);
  await act(async () => {
    void view.result.current.start(rows.slice(0, 1), tail).catch(() => {});
  });
  const calls = vi.mocked(client.startBulkTrash).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]![1]).toBe(calls[0]![1]);
  expect(tail.trashMaterial).not.toHaveBeenCalled();
});

it('does not let an old execution release the active owner after a team round trip', async () => {
  const group: BulkTrashGroup = {
    id: 'group',
    teamId: team,
    actorId: actor,
    items: [{ materialId: rows[0]!.id, idempotencyKey: 'key', state: 'queued', errorCode: null }]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async id => (id === team ? [structuredClone(group)] : [])),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(async () => structuredClone(group)),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const finish: Array<() => void> = [];
  const tail = {
    trashMaterial: vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => finish.push(resolve)))
      .mockImplementationOnce(() => new Promise<void>(resolve => finish.push(resolve)))
      .mockResolvedValue(undefined)
  };
  const view = renderHook(({ id }) => useBulkTrash(id, 0, client, actor), {
    initialProps: { id: team }
  });
  await act(async () => {});
  let old!: Promise<void>;
  act(() => {
    old = view.result.current.retry(group, rows.slice(0, 1), tail);
  });
  await waitFor(() => expect(tail.trashMaterial).toHaveBeenCalledTimes(1));
  await act(async () => view.rerender({ id: 'other' }));
  await act(async () => view.rerender({ id: team }));
  let current!: Promise<void>;
  act(() => {
    current = view.result.current.retry(group, rows.slice(0, 1), tail);
  });
  await waitFor(() => expect(tail.trashMaterial).toHaveBeenCalledTimes(2));
  await act(async () => {
    finish[0]!();
    await old;
  });
  await act(async () => {
    await view.result.current.retry(group, rows.slice(0, 1), tail);
  });
  expect(tail.trashMaterial).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish[1]!();
    await current;
  });
});

it('does not let an old start clear a new start lock after a team round trip', async () => {
  const finish: Array<() => void> = [];
  const start = vi.fn(
    (_team: string, id: string) =>
      new Promise<BulkTrashGroup>(resolve =>
        finish.push(() => resolve({ id, teamId: team, actorId: actor, items: [] }))
      )
  );
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn().mockResolvedValue([]),
    startBulkTrash: start,
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = { trashMaterial: vi.fn() };
  const view = renderHook(({ id }) => useBulkTrash(id, 0, client, actor), {
    initialProps: { id: team }
  });
  await act(async () => {});
  let old!: Promise<unknown>;
  act(() => {
    old = view.result.current.start(rows.slice(0, 1), tail).catch(error => error.name);
  });
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  await act(async () => view.rerender({ id: 'other' }));
  await act(async () => view.rerender({ id: team }));
  let current!: Promise<BulkTrashGroup>;
  act(() => {
    current = view.result.current.start(rows.slice(0, 1), tail);
  });
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  await act(async () => {
    finish[0]!();
    expect(await old).toBe('AbortError');
  });
  await act(async () => {
    await expect(view.result.current.start(rows.slice(0, 1), tail)).rejects.toMatchObject({
      code: 'WRONG_STATE'
    });
  });
  expect(start).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish[1]!();
    await current;
  });
});

it('dismisses a visible confirmed trash result after acknowledgement, but keeps unfinished work', () => {
  vi.useFakeTimers();
  const onVisible = vi.fn();
  const onDismiss = vi.fn();
  const group: BulkTrashGroup = {
    id: 'completed-trash',
    teamId: team,
    actorId: actor,
    items: [{ materialId: rows[0]!.id, idempotencyKey: 'key', state: 'confirmed', errorCode: null }]
  };
  try {
    const view = render(
      <BulkTrashPanel
        group={group}
        rows={rows}
        uncertain={false}
        onVisible={onVisible}
        onDismiss={onDismiss}
      />
    );
    expect(onVisible).toHaveBeenCalledWith(group.id);
    act(() => vi.advanceTimersByTime(4000));
    expect(onDismiss).toHaveBeenCalledWith(group.id);
    onDismiss.mockClear();
    view.rerender(
      <BulkTrashPanel
        group={{ ...group, items: [{ ...group.items[0]!, state: 'unknown' }] }}
        rows={rows}
        uncertain={true}
        onVisible={onVisible}
        onDismiss={onDismiss}
      />
    );
    act(() => vi.advanceTimersByTime(4000));
    expect(onDismiss).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it.each(['unknown', 'failed', 'running', 'queued', 'confirmed'] as const)(
  'can hide a %s trash panel even when collapsed without retrying or confirming work',
  state => {
    const group: BulkTrashGroup = {
      id: '37000000-0000-4000-8000-000000000099',
      teamId: team,
      actorId: actor,
      items: [
        {
          materialId: rows[0]!.id,
          idempotencyKey: 'same-operation',
          state,
          errorCode: state === 'unknown' ? 'PERMISSION_DENIED' : null
        }
      ]
    };
    const onDismiss = vi.fn(),
      onRetry = vi.fn(),
      onVisible = vi.fn();
    render(
      <BulkTrashPanel
        group={group}
        rows={rows}
        uncertain={state === 'unknown'}
        onDismiss={onDismiss}
        onRetry={onRetry}
        onVisible={onVisible}
      />
    );
    const before = onVisible.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide this panel' }));
    expect(onDismiss).toHaveBeenCalledWith(group.id);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onVisible).toHaveBeenCalledTimes(before);
    expect(group.items[0]?.state).toBe(state);
  }
);

it('keeps a manually hidden unknown receipt hidden across refresh without mutating it', async () => {
  const group: BulkTrashGroup = {
    id: 'hidden-unknown',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'unchanged',
        state: 'unknown',
        errorCode: 'PERMISSION_DENIED'
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [structuredClone(group)]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() => expect(view.result.current.groups).toHaveLength(1));
  act(() => view.result.current.dismiss(group.id));
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(view.result.current.groups).toHaveLength(0);
  expect(client.startBulkTrash).not.toHaveBeenCalled();
  expect(client.prepareBulkTrashItem).not.toHaveBeenCalled();
  expect(client.markBulkTrashRequest).not.toHaveBeenCalled();
  expect(group.items[0]?.state).toBe('unknown');
});

it('keeps an acknowledged group available when its first receipt refresh fails', async () => {
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000099',
    teamId: team,
    actorId: actor,
    items: [
      { materialId: rows[0]!.id, idempotencyKey: 'same-item-key', state: 'queued', errorCode: null }
    ]
  };
  let accepted = false;
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => {
      if (accepted) throw new TypeError('read unavailable');
      return [];
    }),
    startBulkTrash: vi.fn(async (_team, id) => {
      group.id = id;
      accepted = true;
      return structuredClone(group);
    }),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = { trashMaterial: vi.fn() };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {});
  let outcome: unknown;
  await act(async () => {
    outcome = await view.result.current.start(rows.slice(0, 1), tail).catch(cause => cause);
  });
  expect(outcome).toMatchObject({ id: group.id });
  expect(view.result.current.groups).toContainEqual(group);
  expect(view.result.current.uncertain).toBe(true);
  expect(tail.trashMaterial).not.toHaveBeenCalled();
  expect(client.startBulkTrash).toHaveBeenCalledTimes(1);
});

it('does not send the file write after access changes during the mark acknowledgement', async () => {
  const { setPrivateCacheScope } = await import('../apps/web/src/team/private-cache-scope');
  setPrivateCacheScope(actor, 'bulk-trash-before');
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000099',
    teamId: team,
    actorId: actor,
    items: [
      { materialId: rows[0]!.id, idempotencyKey: 'same-key', state: 'queued', errorCode: null }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => structuredClone([group])),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(async () => structuredClone(group)),
    markBulkTrashRequest: vi.fn(async () => {
      setPrivateCacheScope(actor, 'bulk-trash-after');
    })
  };
  const tail = { trashMaterial: vi.fn() };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  try {
    await act(async () => {});
    await act(async () => {
      await view.result.current.retry(group, rows.slice(0, 1), tail);
    });
    expect(client.markBulkTrashRequest).toHaveBeenCalledOnce();
    expect(tail.trashMaterial).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    setPrivateCacheScope(null, 'bulk-trash-ended');
  }
});

it('does not dispatch a stale bulk group when authoritative recovery no longer returns it', async () => {
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000099',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'retained-key',
        state: 'unknown',
        errorCode: 'PROCESS_RESULT_UNCERTAIN'
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => []),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(async () => group),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = { trashMaterial: vi.fn() };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {
    await expect(view.result.current.retry(group, rows.slice(0, 1), tail)).rejects.toMatchObject({
      code: 'PROCESS_RESULT_UNCERTAIN'
    });
  });
  expect(client.prepareBulkTrashItem).not.toHaveBeenCalled();
  expect(client.markBulkTrashRequest).not.toHaveBeenCalled();
  expect(tail.trashMaterial).not.toHaveBeenCalled();
  expect(view.result.current.uncertain).toBe(true);
});

it('keeps historical completion separate from current success and checks it without provider replay', async () => {
  const hosted: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000098',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'old-terminal-key',
        state: 'unknown',
        errorCode: 'PROCESS_RESULT_UNCERTAIN'
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [structuredClone(hosted)]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(async () => structuredClone(hosted)),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const historical = {
    protocolVersion: 1 as const,
    action: 'trash' as const,
    basis: 'catalog_snapshot' as const,
    observedAt: '2026-11-08T10:00:00Z',
    state: 'changed' as const,
    memberCount: 1,
    matchingCount: 0,
    missingCount: 0
  };
  const tail = {
    trashMaterial: vi.fn(async () => ({
      operationId: '37000000-0000-4000-8000-000000000097',
      state: 'succeeded',
      reused: true,
      materialId: rows[0]!.id,
      historicalReceipt: historical
    }))
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {
    await view.result.current.retry(hosted, rows.slice(0, 1), tail);
  });
  expect(tail.trashMaterial).toHaveBeenCalledWith(expect.objectContaining({ receiptProtocol: 2 }));
  expect(view.result.current.historicalReceipts.get(hosted.id)?.get(rows[0]!.id)).toEqual(
    historical
  );
  expect(client.markBulkTrashRequest).toHaveBeenCalledTimes(1);
  await act(async () => {
    await view.result.current.retry(hosted, rows.slice(0, 1), tail);
  });
  expect(tail.trashMaterial).toHaveBeenCalledTimes(1);
  expect(client.prepareBulkTrashItem).toHaveBeenCalledTimes(1);
});

it('restores durable historical observation on reopen without new mutation dispatch', async () => {
  const historical = {
    protocolVersion: 1 as const,
    action: 'trash' as const,
    basis: 'catalog_snapshot' as const,
    observedAt: '2026-11-08T10:00:00Z',
    state: 'changed' as const,
    memberCount: 1,
    matchingCount: 0,
    missingCount: 0
  };
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000096',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'old-key',
        state: 'confirmed',
        errorCode: null,
        historicalReceipt: historical
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [group]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn()
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() =>
    expect(view.result.current.historicalReceipts.get(group.id)?.get(rows[0]!.id)).toEqual(
      historical
    )
  );
  view.unmount();
  const reopened = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() =>
    expect(reopened.result.current.historicalReceipts.get(group.id)?.get(rows[0]!.id)).toEqual(
      historical
    )
  );
  expect(client.prepareBulkTrashItem).not.toHaveBeenCalled();
  expect(client.startBulkTrash).not.toHaveBeenCalled();
});

it('renders historical catalog-state change without announcing a fresh completed mutation', async () => {
  localStorage.setItem('language', 'en');
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000095',
    teamId: team,
    actorId: actor,
    items: [
      { materialId: rows[0]!.id, idempotencyKey: 'old-key', state: 'confirmed', errorCode: null }
    ]
  };
  const receipt = {
    protocolVersion: 1 as const,
    action: 'trash' as const,
    basis: 'catalog_snapshot' as const,
    observedAt: '2026-11-08T10:00:00Z',
    state: 'changed' as const,
    memberCount: 1,
    matchingCount: 0,
    missingCount: 0
  };
  const visible = vi.fn(),
    check = vi.fn();
  render(
    <BulkTrashPanel
      group={group}
      rows={rows.slice(0, 1)}
      uncertain={false}
      historicalReceipts={new Map([[rows[0]!.id, receipt]])}
      onVisible={visible}
      onRetry={check}
    />
  );
  expect(
    screen.getByText(
      /The earlier operation completed, but the current catalog snapshot has since changed/
    )
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
  expect(check).toHaveBeenCalledOnce();
  expect(visible).toHaveBeenCalledWith(group.id, 'unknown');
  expect(visible.mock.calls.some(call => call[1] !== 'unknown')).toBe(false);
});

it('allows a fresh intent after a changed historical receipt without reusing the old mutation', async () => {
  const old: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000094',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'old-terminal-key',
        state: 'confirmed',
        errorCode: null,
        historicalReceipt: {
          protocolVersion: 1,
          action: 'trash',
          basis: 'catalog_snapshot',
          observedAt: '2026-11-08T10:00:00Z',
          state: 'changed',
          memberCount: 1,
          matchingCount: 0,
          missingCount: 0
        }
      }
    ]
  };
  let groups = [old];
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => structuredClone(groups)),
    startBulkTrash: vi.fn(async (_team: string, id: string, ids: string[]) => {
      const fresh: BulkTrashGroup = {
        id,
        teamId: team,
        actorId: actor,
        items: ids.map(materialId => ({
          materialId,
          idempotencyKey: `${id}:${materialId}`,
          state: 'queued',
          errorCode: null
        }))
      };
      groups = [fresh, old];
      return structuredClone(fresh);
    }),
    prepareBulkTrashItem: vi.fn(async (_team: string, id: string) =>
      structuredClone(groups.find(group => group.id === id)!)
    ),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const tail = {
    trashMaterial: vi.fn(async (_input: { idempotencyKey: string }) => {
      groups[0]!.items[0]!.state = 'confirmed';
      return {
        operationId: '37000000-0000-4000-8000-000000000093',
        state: 'succeeded',
        materialId: rows[0]!.id,
        reused: false
      };
    })
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() => expect(view.result.current.historicalReceipts.has(old.id)).toBe(true));
  await act(async () => {
    await view.result.current.start(rows.slice(0, 1), tail);
  });
  await waitFor(() => expect(tail.trashMaterial).toHaveBeenCalledTimes(1));
  expect(vi.mocked(client.startBulkTrash).mock.calls[0]![1]).not.toBe(old.id);
  expect(vi.mocked(tail.trashMaterial).mock.calls[0]![0].idempotencyKey).not.toBe(
    'old-terminal-key'
  );
});

it('records a visible historical explanation as unknown delivery instead of a fresh operation success', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => {});
  const historical = {
    protocolVersion: 1 as const,
    action: 'trash' as const,
    basis: 'catalog_snapshot' as const,
    observedAt: '2026-11-08T10:00:00Z',
    state: 'changed' as const,
    memberCount: 1,
    matchingCount: 0,
    missingCount: 0
  };
  const group: BulkTrashGroup = {
    id: '37000000-0000-4000-8000-000000000092',
    teamId: team,
    actorId: actor,
    items: [
      {
        materialId: rows[0]!.id,
        idempotencyKey: 'old-key',
        state: 'confirmed',
        errorCode: null,
        historicalReceipt: historical
      }
    ]
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [group]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn()
  };
  function Host() {
    const state = useBulkTrash(team, 0, client, actor);
    return (
      <>
        {state.groups.map(item => (
          <BulkTrashPanel
            key={item.id}
            group={item}
            rows={rows.slice(0, 1)}
            historicalReceipts={state.historicalReceipts.get(item.id)}
            uncertain={state.uncertain}
            onVisible={state.acknowledgeVisible}
          />
        ))}
      </>
    );
  }
  render(<Host />);
  await waitFor(() =>
    expect(track).toHaveBeenCalledWith(
      'operation_stage_completed',
      expect.objectContaining({
        flow_id: group.id,
        action_identifier: 'result_visible',
        error_code: 'PROCESS_RESULT_UNCERTAIN'
      })
    )
  );
  expect(track.mock.calls.some(([event]) => event === 'operation_completed')).toBe(false);
  expect(client.prepareBulkTrashItem).not.toHaveBeenCalled();
});

it('keeps a closed bulk-trash panel closed after a reload and hides hosted-dismissed groups', async () => {
  const finished = (id: string, dismissed?: boolean): BulkTrashGroup => ({
    id,
    teamId: team,
    actorId: actor,
    ...(dismissed === undefined ? {} : { dismissed }),
    items: [{ materialId: rows[0]!.id, idempotencyKey: id, state: 'confirmed', errorCode: null }]
  });
  const hosted = [finished('closed-elsewhere', true), finished('fresh')];
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => structuredClone(hosted)),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined),
    dismissBulkTrash: vi.fn(async (_team: string, id: string) => {
      hosted.find(group => group.id === id)!.dismissed = true;
    })
  };
  const first = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() =>
    expect(first.result.current.groups.map(group => group.id)).toEqual(['fresh'])
  );
  act(() => first.result.current.dismiss('fresh'));
  expect(first.result.current.groups).toEqual([]);
  expect(client.dismissBulkTrash).toHaveBeenCalledWith(team, 'fresh');
  first.unmount();
  // A reload: a new hook instance with nothing in memory.
  const second = renderHook(() => useBulkTrash(team, 0, client, actor));
  await act(async () => {
    await second.result.current.refresh();
  });
  expect(second.result.current.groups).toEqual([]);
});

it('reports a group being worked through as executing, so queued items offer no retry', async () => {
  let release: () => void = () => {};
  const hosted: BulkTrashGroup = {
    id: 'running-group',
    teamId: team,
    actorId: actor,
    items: rows.slice(0, 1).map(row => ({
      materialId: row.id,
      idempotencyKey: row.id,
      state: 'queued' as const,
      errorCode: null
    }))
  };
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => [structuredClone(hosted)]),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(
      () =>
        new Promise<BulkTrashGroup>(resolve => {
          release = () => resolve(structuredClone({ ...hosted, items: [] }));
        })
    ),
    markBulkTrashRequest: vi.fn().mockResolvedValue(undefined)
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  await waitFor(() => expect(view.result.current.groups).toHaveLength(1));
  let run: Promise<void> = Promise.resolve();
  act(() => {
    run = view.result.current.retry(view.result.current.groups[0]!, rows.slice(0, 1), {
      trashMaterial: vi.fn()
    });
  });
  await waitFor(() => expect(view.result.current.executing.has('running-group')).toBe(true));
  expect(view.result.current.names.get(rows[0]!.id)).toBe('File 0');
  const panel = render(
    <BulkTrashPanel
      group={view.result.current.groups[0]!}
      rows={[]}
      names={view.result.current.names}
      executing
      uncertain={false}
      onVisible={() => {}}
      onRetry={() => {}}
    />
  );
  expect(screen.queryByRole('button', { name: 'Repeat' })).toBeNull();
  expect(screen.getByText('File 0')).toBeTruthy();
  panel.rerender(
    <BulkTrashPanel
      group={view.result.current.groups[0]!}
      rows={[]}
      uncertain={false}
      onVisible={() => {}}
      onRetry={() => {}}
    />
  );
  expect(screen.getByRole('button', { name: 'Repeat' })).toBeTruthy();
  await waitFor(() => expect(client.prepareBulkTrashItem).toHaveBeenCalled());
  await act(async () => {
    release();
    await run.catch(() => undefined);
  });
  await waitFor(() => expect(view.result.current.executing.size).toBe(0));
});

it('counts overlapping claims so one surface closing does not release another', () => {
  const client: BulkTrashClient = {
    listBulkTrash: vi.fn(async () => []),
    startBulkTrash: vi.fn(),
    prepareBulkTrashItem: vi.fn(),
    markBulkTrashRequest: vi.fn()
  };
  const view = renderHook(() => useBulkTrash(team, 0, client, actor));
  let a: () => void = () => {},
    b: () => void = () => {};
  act(() => {
    a = view.result.current.claim(['g1', 'g2']);
    b = view.result.current.claim(['g2']);
  });
  expect([...view.result.current.claimed].sort()).toEqual(['g1', 'g2']);
  act(() => a());
  expect([...view.result.current.claimed]).toEqual(['g2']);
  act(() => b());
  expect(view.result.current.claimed.size).toBe(0);
});
