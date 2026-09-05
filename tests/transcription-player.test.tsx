// @vitest-environment jsdom

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Translate } from '../apps/web/src/components/ui.js';
import { TranscriptPlayer } from '../apps/web/src/transcription/TranscriptPlayer.js';

const t = ((key: string) => key) as unknown as Translate;

function visibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('media player stall watchdog', () => {
  it('gives up on a source that decodes nothing for half a minute, but only while on screen', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    render(<TranscriptPlayer src="blob:media" audioOnly onError={onError} t={t} />);

    // Hidden: the browser loads media at its leisure, and the clock does not run.
    act(() => visibility('hidden'));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onError).not.toHaveBeenCalled();

    // Back on screen the clock starts over, and thirty seconds of nothing is a dead source.
    act(() => visibility('visible'));
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(onError).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stops the clock once frames are decoded', () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { container } = render(
      <TranscriptPlayer src="blob:media" audioOnly onError={onError} t={t} />
    );
    const media = container.querySelector('video')!;
    Object.defineProperty(media, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(media, 'duration', { configurable: true, get: () => 56 });
    act(() => {
      fireEvent.canPlay(media);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('seeks in five-second steps from the keyboard, thirty with Page keys', () => {
    const { container, getByLabelText } = render(
      <TranscriptPlayer src="blob:media" audioOnly t={t} />
    );
    const media = container.querySelector('video')!;
    let time = 10;
    Object.defineProperty(media, 'currentTime', {
      configurable: true,
      get: () => time,
      set: value => {
        time = value;
      }
    });
    Object.defineProperty(media, 'duration', { configurable: true, get: () => 100 });
    const slider = getByLabelText('transcriptionPlayerSeek');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(time).toBe(15);
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(time).toBe(0);
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(time).toBe(30);
  });
});
