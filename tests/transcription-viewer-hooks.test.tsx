// @vitest-environment jsdom

import React, { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '@video-compressor/shared';
import { useKaraoke } from '../apps/web/src/transcription/useKaraoke.js';

const segments: TranscriptSegment[] = [
  {
    id: 's0',
    startMs: 0,
    endMs: 2000,
    sourceText: 'Hello there world',
    words: [
      {
        id: 'w0',
        text: 'Hello',
        startMs: 0,
        endMs: 500,
        confidence: 1,
        sourceStart: 0,
        sourceEnd: 5
      },
      {
        id: 'w1',
        text: 'there',
        startMs: 600,
        endMs: 1100,
        confidence: 1,
        sourceStart: 6,
        sourceEnd: 11
      },
      {
        id: 'w2',
        text: 'world',
        startMs: 1200,
        endMs: 2000,
        confidence: 1,
        sourceStart: 12,
        sourceEnd: 17
      }
    ]
  }
];

/** A media element the test drives by hand: time and paused state, play/pause/ended events. */
function fakeMedia() {
  const element = document.createElement('video');
  let time = 0;
  let paused = true;
  Object.defineProperty(element, 'currentTime', { get: () => time, set: value => (time = value) });
  Object.defineProperty(element, 'paused', { get: () => paused });
  Object.defineProperty(element, 'videoWidth', { get: () => 0 });
  return {
    element,
    play() {
      paused = false;
      element.dispatchEvent(new Event('play'));
    },
    pause() {
      paused = true;
      element.dispatchEvent(new Event('pause'));
    },
    end() {
      paused = true;
      element.dispatchEvent(new Event('ended'));
    },
    seek(seconds: number) {
      time = seconds;
      element.dispatchEvent(new Event('seeked'));
    }
  };
}

function Harness({
  media,
  onStore
}: {
  media: HTMLVideoElement;
  onStore: (store: unknown) => void;
}) {
  const mediaRef = useRef<HTMLVideoElement>(media);
  const scroller = useRef<HTMLDivElement>(null);
  const pointerSelecting = useRef(false);
  const { store } = useKaraoke({
    mediaRef,
    sourceScrollRef: scroller,
    segments,
    enabled: true,
    pointerSelecting,
    centerActiveWord: () => {}
  });
  onStore(store);
  return (
    <div ref={scroller}>
      <p className="ts-segment" data-segment-id="s0">
        <span data-word-id="w0">Hello</span> <span data-word-id="w1">there</span>{' '}
        <span data-word-id="w2">world</span>
      </p>
    </div>
  );
}

describe('karaoke follow', () => {
  let frame: FrameRequestCallback | null = null;
  const raf = vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    frame = null;
  });

  it('lights the word under the playhead, keeps it through a pause, and clears at the end', () => {
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const media = fakeMedia();
    const stored: { current: { get(): { wordId: string } | null } | null } = { current: null };
    const view = render(
      <Harness
        media={media.element}
        onStore={value => (stored.current = value as typeof stored.current)}
      />
    );
    const lit = () =>
      Array.from(view.container.querySelectorAll('.ts-active')).map(el =>
        el.getAttribute('data-word-id')
      );

    act(() => {
      media.play();
      media.seek(0.7);
      frame?.(0);
    });
    expect(lit()).toEqual(['w1']);
    expect(stored.current?.get()?.wordId).toBe('w1');

    // Pausing stops the clock and nothing else: the reader keeps their place.
    act(() => media.pause());
    expect(lit()).toEqual(['w1']);
    expect(stored.current?.get()?.wordId).toBe('w1');

    // A seek while paused moves the mark.
    act(() => media.seek(1.5));
    expect(lit()).toEqual(['w2']);

    // The end of the media clears it.
    act(() => media.end());
    expect(lit()).toEqual([]);
    expect(stored.current?.get()).toBeNull();
    view.unmount();
  });
});
