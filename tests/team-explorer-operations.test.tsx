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
import { afterEach, expect, it, vi } from 'vitest';
import type { BulkTrashGroup, TeamMaterialRow } from '@video-compressor/shared';
import { analytics } from '../apps/web/src/analytics/service';
import { BulkTrashPanel } from '../apps/web/src/team/explorer/BulkTrashPanel';
import { TeamApiError } from '../apps/web/src/api/team';
import { useBulkTrash, type BulkTrashClient } from '../apps/web/src/team/explorer/useBulkTrash';
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
    markBulkTrashRequest: vi.fn()
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
