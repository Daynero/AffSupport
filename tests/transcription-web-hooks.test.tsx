// @vitest-environment jsdom

import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionMediaPreview } from '@video-compressor/shared';
import { useCompactToolbar } from '../apps/web/src/components/useCompactToolbar.js';
import { useMediaPreview } from '../apps/web/src/transcription/useMediaPreview.js';

const media = vi.hoisted(() => ({
  status: vi.fn<(id: string, signal?: AbortSignal) => Promise<TranscriptionMediaPreview>>(),
  prepare: vi.fn<(id: string) => Promise<TranscriptionMediaPreview>>(),
  cancel: vi.fn<(id: string) => Promise<{ ok: boolean }>>()
}));

vi.mock('../apps/web/src/api/client.js', () => ({
  transcriptionMediaStatus: media.status,
  transcriptionMediaPrepare: media.prepare,
  transcriptionMediaCancel: media.cancel
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function preview(state: TranscriptionMediaPreview['state']): TranscriptionMediaPreview {
  return { state, variant: null, progress: null, hasVideo: null, mimeType: null, error: null };
}

describe('useCompactToolbar', () => {
  /** jsdom lays nothing out, so the widths the hook asks for are set by hand. */
  function widths(row: HTMLElement, available: number, children: number[]) {
    Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => available });
    Array.from(row.children).forEach((child, index) => {
      Object.defineProperty(child, 'scrollWidth', {
        configurable: true,
        get: () => children[index] ?? 0
      });
    });
  }

  function Toolbar({
    onState
  }: {
    onState: (state: { actions: boolean; chips: boolean; selection: boolean }) => void;
  }) {
    const { ref, compactActions, compactChips, compactSelection } = useCompactToolbar();
    onState({ actions: compactActions, chips: compactChips, selection: compactSelection });
    return (
      <div ref={ref} className="batch-toolbar-row" data-testid="row">
        <div className="selection-actions">select</div>
        <div className="primary-actions">actions</div>
      </div>
    );
  }

  /** The hook measures once per frame; a real frame is awaited rather than faked. */
  const nextFrame = () =>
    act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

  it('collapses the words when the groups need more room than the row has', async () => {
    let state = { actions: false, chips: false, selection: false };
    const { getByTestId } = render(<Toolbar onState={next => (state = next)} />);
    const row = getByTestId('row');
    const selection = row.querySelector('.selection-actions')!;
    expect(row.classList.contains('is-compact')).toBe(false);

    // Too wide even without words: all three stages, the last on the selection group.
    widths(row, 300, [200, 200]);
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(row.classList.contains('is-compact')).toBe(true);
    expect(selection.classList.contains('is-compact')).toBe(true);
    expect(state).toEqual({ actions: true, chips: true, selection: true });

    widths(row, 600, [200, 200]);
    window.dispatchEvent(new Event('resize'));
    await nextFrame();
    expect(row.classList.contains('is-compact')).toBe(false);
    expect(selection.classList.contains('is-compact')).toBe(false);
    expect(state).toEqual({ actions: false, chips: false, selection: false });
  });

  it('measures a row that mounts after the hook, and stops when it leaves', () => {
    const listeners = vi.spyOn(window, 'addEventListener');
    const removals = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Toolbar onState={() => {}} />);
    expect(listeners.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
    unmount();
    expect(removals.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);
  });
});

describe('useMediaPreview', () => {
  function Host({
    jobId,
    onValue
  }: {
    jobId: string;
    onValue: (value: ReturnType<typeof useMediaPreview>) => void;
  }) {
    onValue(useMediaPreview(jobId));
    return null;
  }

  it('polls a preparing preview with a growing delay until it is ready', async () => {
    vi.useFakeTimers();
    media.prepare.mockResolvedValue(preview('preparing'));
    media.status
      .mockResolvedValueOnce(preview('preparing'))
      .mockResolvedValueOnce(preview('preparing'))
      .mockResolvedValue(preview('ready'));
    let value!: ReturnType<typeof useMediaPreview>;
    render(<Host jobId="job-1" onValue={next => (value = next)} />);
    expect(value.preview).toBeNull();

    await act(() => value.prepare());
    expect(value.preview?.state).toBe('preparing');
    expect(media.status).not.toHaveBeenCalled();

    // 400 ms, then 600, then 900: each poll waits half again as long as the last.
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(media.status).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(599));
    expect(media.status).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(media.status).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(900));
    expect(media.status).toHaveBeenCalledTimes(3);
    expect(value.preview?.state).toBe('ready');

    // Ready is the end of it: no further polling.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(media.status).toHaveBeenCalledTimes(3);
  });

  it('forgets the preview when the job changes, and ignores a late answer for the old one', async () => {
    let release!: (value: TranscriptionMediaPreview) => void;
    media.prepare.mockReturnValue(new Promise(resolve => (release = resolve)));
    let value!: ReturnType<typeof useMediaPreview>;
    const { rerender } = render(<Host jobId="job-1" onValue={next => (value = next)} />);
    const pending = value.prepare();
    rerender(<Host jobId="job-2" onValue={next => (value = next)} />);
    await act(async () => {
      release(preview('ready'));
      await pending;
    });
    expect(value.preview).toBeNull();
  });

  it('turns a failed request or an unplayable element into the failed state', async () => {
    media.prepare.mockRejectedValue(new Error('offline'));
    let value!: ReturnType<typeof useMediaPreview>;
    render(<Host jobId="job-1" onValue={next => (value = next)} />);
    await act(() => value.prepare());
    expect(value.preview).toMatchObject({ state: 'failed', error: 'PREVIEW_FAILED' });

    media.prepare.mockResolvedValue(preview('ready'));
    await act(() => value.prepare());
    expect(value.preview?.state).toBe('ready');
    act(() => value.fail());
    expect(value.preview?.state).toBe('failed');
  });

  it('cancelling a transcode drops back to checking and stops the polling', async () => {
    vi.useFakeTimers();
    media.prepare.mockResolvedValue(preview('preparing'));
    media.cancel.mockResolvedValue({ ok: true });
    let value!: ReturnType<typeof useMediaPreview>;
    render(<Host jobId="job-1" onValue={next => (value = next)} />);
    await act(() => value.prepare());
    await act(() => value.cancel());
    expect(media.cancel).toHaveBeenCalledWith('job-1');
    expect(value.preview?.state).toBe('checking');
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(media.status).not.toHaveBeenCalled();
  });
});
