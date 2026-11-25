// @vitest-environment jsdom
/**
 * A launch started and left keeps its draft, the way a task does (25.11): a creative
 * chosen before the editor opened is saved without any other edit, a pending typing
 * pause is not waited out when the page goes away, and a click beside the dialog during
 * an upload waits for the creative instead of dropping it.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useLaunchDraft } from '../apps/web/src/team/launches/useLaunchDraft';
import { useLaunchAutosave } from '../apps/web/src/team/launches/useLaunchAutosave';
import { useExitAfterUpload } from '../apps/web/src/team/launches/useExitAfterUpload';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MATERIAL = '11111111-1111-4111-8111-111111111111';

it('treats a creative chosen before the editor opened as an unsaved edit', () => {
  const started = renderHook(() => useLaunchDraft(null, MATERIAL));
  expect(started.result.current.config.materialId).toBe(MATERIAL);
  expect(started.result.current.dirty).toBe(true);
  expect(started.result.current.isDirty()).toBe(true);
});

it('leaves an untouched blank launch unsaved, so nothing empty lands in the list', () => {
  const blank = renderHook(() => useLaunchDraft(null));
  expect(blank.result.current.config.materialId).toBeUndefined();
  expect(blank.result.current.dirty).toBe(false);
});

it('is clean once the first save of a launch started from a creative is acknowledged', () => {
  const started = renderHook(() => useLaunchDraft(null, MATERIAL));
  act(() => started.result.current.acknowledge(started.result.current.config, null, '1'));
  expect(started.result.current.isDirty()).toBe(false);
});

const autosave = () => ({
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

it('sends an edit still in its typing pause at once when the page is hidden', async () => {
  vi.useFakeTimers();
  const input = autosave();
  renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(input.save).not.toHaveBeenCalled();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  visibility.mockRestore();
  expect(input.save).toHaveBeenCalledTimes(1);
  expect(input.save.mock.calls[0][0]).toMatchObject({ config: { maxBudget: 30 }, version: '1' });
  // The debounce that was cut short does not send the same edit a second time.
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(input.save).toHaveBeenCalledTimes(1);
});

it('sends an edit still in its typing pause when the page unloads', async () => {
  vi.useFakeTimers();
  const input = autosave();
  renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(input.save).toHaveBeenCalledTimes(1);
});

it('does not send anything on page hide when there is nothing to save', async () => {
  vi.useFakeTimers();
  const input = { ...autosave(), dirty: false };
  renderHook(props => useLaunchAutosave(props), { initialProps: input });
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(input.save).not.toHaveBeenCalled();
});

it('holds a close asked for during an upload until the creative is in', () => {
  const requestExit = vi.fn();
  const leave = vi.fn();
  const hook = renderHook(({ uploading }) => useExitAfterUpload(uploading, requestExit), {
    initialProps: { uploading: true }
  });
  act(() => hook.result.current(leave));
  expect(requestExit).not.toHaveBeenCalled();
  hook.rerender({ uploading: false });
  expect(requestExit).toHaveBeenCalledTimes(1);
  expect(requestExit).toHaveBeenCalledWith(leave);
  hook.rerender({ uploading: false });
  expect(requestExit).toHaveBeenCalledTimes(1);
});

it('asks before a reload only while an upload is running', () => {
  const hook = renderHook(({ uploading }) => useExitAfterUpload(uploading, vi.fn()), {
    initialProps: { uploading: true }
  });
  const during = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(during);
  expect(during.defaultPrevented).toBe(true);
  hook.rerender({ uploading: false });
  const after = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(after);
  expect(after.defaultPrevented).toBe(false);
});
