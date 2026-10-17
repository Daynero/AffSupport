// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLaunchAutosave } from '../apps/web/src/team/launches/useLaunchAutosave';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
const base = () => ({
  enabled: true,
  dirty: true,
  teamId: 'team',
  id: 'launch',
  version: '1',
  config: { maxBudget: 30 },
  sources: null,
  save: vi.fn().mockResolvedValue({ id: 'launch', version: '2' }),
  onSaved: vi.fn(),
  onSaving: vi.fn(),
  onError: vi.fn(),
  retryable: vi.fn(() => true)
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('debounces edits and saves the latest configuration only', async () => {
  vi.useFakeTimers();
  const input = base();
  const hook = renderHook(props => useLaunchAutosave(props), { initialProps: input });
  hook.rerender({ ...input, config: { maxBudget: 60 } });
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(input.save).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(input.save).toHaveBeenCalledTimes(1);
  expect(input.save.mock.calls[0][0]).toMatchObject({ config: { maxBudget: 60 }, version: '1' });
  expect(input.onSaved).toHaveBeenCalled();
});
it('serializes an edit made during a save against the acknowledged version', async () => {
  vi.useFakeTimers();
  const input = base();
  let resolve!: (value: { id: string; version: string }) => void;
  input.save.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  const hook = renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(() => vi.advanceTimersByTimeAsync(500));
  hook.rerender({ ...input, config: { maxBudget: 60 } });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(input.save).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ id: 'launch', version: '2' }));
  hook.rerender({ ...input, config: { maxBudget: 60 }, version: '2' });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(input.save).toHaveBeenCalledTimes(2);
  expect(input.save.mock.calls[1][0]).toMatchObject({ config: { maxBudget: 60 }, version: '2' });
});
it('retries an unknown reply with the exact same payload and idempotency key', async () => {
  vi.useFakeTimers();
  const input = base();
  input.save.mockRejectedValueOnce(new Error('offline'));
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  renderHook(() =>
    useLaunchAutosave({
      ...input,
      config: { originalUrl: 'https://example.invalid/?token=SYNTHETIC_AUTOSAVE_SECRET' }
    })
  );
  await act(() => vi.advanceTimersByTimeAsync(500));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(input.save).toHaveBeenCalledTimes(2);
  expect(input.save.mock.calls[0][0]).toBe(input.save.mock.calls[1][0]);
  expect(writes).not.toHaveBeenCalled();
});
it('stops on a nonretryable conflict without overwriting a newer server version', async () => {
  vi.useFakeTimers();
  const input = base();
  input.retryable.mockReturnValue(false);
  input.save.mockRejectedValue(new Error('conflict'));
  const hook = renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(() => vi.advanceTimersByTimeAsync(500));
  hook.rerender({ ...input, config: { maxBudget: 60 } });
  await act(() => vi.advanceTimersByTimeAsync(60000));
  expect(input.save).toHaveBeenCalledTimes(1);
  expect(input.onSaved).not.toHaveBeenCalled();
});
it('ignores a late response after unmount or scope change', async () => {
  vi.useFakeTimers();
  const input = base();
  let resolve!: (value: { id: string; version: string }) => void;
  input.save.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      })
  );
  const hook = renderHook(() => useLaunchAutosave(input));
  await act(() => vi.advanceTimersByTimeAsync(500));
  hook.unmount();
  await act(async () => resolve({ id: 'launch', version: '2' }));
  expect(input.onSaved).not.toHaveBeenCalled();
});
it('adopts its new server ID without replacing edits made while the first save was in flight', () => {
  const hook = renderHook(({ detail }: { detail: LaunchDetail | null }) => useLaunchDraft(detail), {
    initialProps: { detail: null as LaunchDetail | null }
  });
  act(() => hook.result.current.setConfig(current => ({ ...current, maxBudget: 40 })));
  const sent = hook.result.current.config;
  act(() => hook.result.current.setConfig(current => ({ ...current, maxBudget: 60 })));
  act(() => hook.result.current.acknowledge(sent, null, '1'));
  hook.rerender({
    detail: {
      id: 'launch',
      version: '1',
      draft: sent,
      expectedSourceSnapshot: null,
      assigneeId: null,
      workStatus: 'todo',
      activeRevision: null,
      generation: null
    }
  });
  expect(hook.result.current.config.maxBudget).toBe(60);
  expect(hook.result.current.dirty).toBe(true);
  expect(hook.result.current.baseVersion).toBe('1');
});
it('creates a new protected draft after the first edit, without saving untouched defaults', async () => {
  vi.useFakeTimers();
  const input = base();
  const hook = renderHook(props => useLaunchAutosave({ ...props, id: null, version: null }), {
    initialProps: { ...input, dirty: false }
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(input.save).not.toHaveBeenCalled();
  hook.rerender({ ...input, dirty: true });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(input.save).toHaveBeenCalledTimes(1);
  expect(input.save.mock.calls[0][0]).toMatchObject({ id: null, version: null });
});
it('can save corrected input after a definitive validation failure', async () => {
  vi.useFakeTimers();
  const input = base();
  input.retryable.mockReturnValue(false);
  input.save.mockRejectedValueOnce(new Error('invalid input'));
  const props = { ...input, canRecoverOnEdit: () => true };
  const hook = renderHook(p => useLaunchAutosave(p), { initialProps: props });
  await act(() => vi.advanceTimersByTimeAsync(500));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(input.save).toHaveBeenCalledTimes(1);
  hook.rerender({ ...props, config: { maxBudget: 60 } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(input.save).toHaveBeenCalledTimes(2);
});

it('resumes after an explicitly acknowledged replacement base version', async () => {
  vi.useFakeTimers();
  const input = base();
  input.retryable.mockReturnValue(false);
  input.save.mockRejectedValueOnce(new Error('conflict'));
  const hook = renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(() => vi.advanceTimersByTimeAsync(500));
  hook.rerender({ ...input, version: '2' });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(input.save).toHaveBeenCalledTimes(2);
  expect(input.save.mock.calls[1][0]).toMatchObject({ version: '2' });
});
