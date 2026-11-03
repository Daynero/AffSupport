// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCatalogSearch } from '../apps/web/src/team/catalog/useCatalogSearch';
const state = vi.hoisted(() => ({ revision: 0, accessRevision: 0 }));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => state }));
vi.mock('../apps/web/src/auth/AuthContext', () => ({ useOptionalAuth: () => null }));
const empty = { items: [], total: 0, page: 1, pageSize: 50, facets: {} };
beforeEach(() => {
  vi.useFakeTimers();
  state.revision = 0;
  state.accessRevision = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
const vocabulary = () => ({ geo: [], languages: [], offers: [], tags: [] });

it('serializes revision bursts, aborts replaced scopes and catches up once when visible', async () => {
  let release!: (value: typeof empty) => void;
  const client = {
    searchCatalog: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(done => {
            release = done;
          })
      )
      .mockResolvedValue(empty),
    getCatalogVocabulary: vi.fn().mockResolvedValue(vocabulary())
  };
  const view = renderHook(({ teamId }) => useCatalogSearch({ teamId, client, debounceMs: 0 }), {
    initialProps: { teamId: 'one' }
  });
  await tick();
  for (let i = 0; i < 10; i++) {
    state.revision++;
    view.rerender({ teamId: 'one' });
    await tick();
  }
  expect(client.searchCatalog).toHaveBeenCalledTimes(1);
  await act(async () => {
    release(empty);
  });
  expect(client.searchCatalog).toHaveBeenCalledTimes(2);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  for (let i = 0; i < 10; i++) {
    state.revision++;
    view.rerender({ teamId: 'one' });
    await tick();
  }
  expect(client.searchCatalog).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await tick();
  expect(client.searchCatalog).toHaveBeenCalledTimes(3);
  const oldSignal = client.searchCatalog.mock.calls.at(-1)![3].signal as AbortSignal;
  view.rerender({ teamId: 'two' });
  expect(oldSignal.aborted).toBe(false); // Completed reads have no live owner to abort.
  await tick();
  expect(client.searchCatalog).toHaveBeenCalledTimes(4);
});

it('aborts pending search and vocabulary HTTP ownership on unmount', async () => {
  const client = {
    searchCatalog: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => new Promise(() => {})),
    getCatalogVocabulary: vi.fn<(...args: unknown[]) => Promise<unknown>>(
      () => new Promise(() => {})
    )
  };
  const view = renderHook(() =>
    useCatalogSearch({ teamId: 'one', client: client as never, debounceMs: 0 })
  );
  await tick();
  const searchSignal = (client.searchCatalog.mock.calls[0]![3] as { signal: AbortSignal })
    .signal as AbortSignal;
  const vocabularySignal = (
    client.getCatalogVocabulary.mock.calls[0]![1] as { signal: AbortSignal }
  ).signal as AbortSignal;
  view.unmount();
  expect(searchSignal.aborted).toBe(true);
  expect(vocabularySignal.aborted).toBe(true);
});

it('releases a stalled search owner at its deadline so manual retry can finish', async () => {
  const client = {
    searchCatalog: vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(empty),
    getCatalogVocabulary: vi.fn().mockResolvedValue(vocabulary())
  };
  const view = renderHook(() => useCatalogSearch({ teamId: 'one', client, debounceMs: 0 }));
  await tick();
  const signal = client.searchCatalog.mock.calls[0]![3].signal as AbortSignal;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(signal.aborted).toBe(true);
  expect(view.result.current.error).toBe(true);
  expect(view.result.current.loading).toBe(false);
  await act(async () => {
    await view.result.current.refetch();
  });
  expect(client.searchCatalog).toHaveBeenCalledTimes(2);
  expect(view.result.current.error).toBe(false);
  expect(view.result.current.result?.total).toBe(0);
});
