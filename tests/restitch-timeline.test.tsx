// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RestitchTimeline,
  type RestitchTimelineLabels,
  type RestitchTimelineSlot
} from '../apps/web/src/components/ui/RestitchTimeline';
import {
  dragHandle,
  durationAfterKey,
  moveHandle,
  slideRange,
  spanText,
  type FinalDuration
} from '../apps/web/src/components/ui/restitch-timeline-scale';

/**
 * The re-stitch timeline (071): the final picture's length as one range on a 0–60 minute scale,
 * two handles on the strip itself. Apart they are a random range; together, one exact length.
 * Whichever way it moves, the value stays whole minutes from 1 to 60 and the handles never cross.
 */

afterEach(cleanup);

const labels: RestitchTimelineLabels = {
  start: 'Start',
  startLength: '1 frame',
  video: 'Your video',
  videoLength: 'as is',
  end: 'Final',
  endLength: 'length',
  off: 'Off',
  builtin: 'Soty',
  random: count => `one of ${count}`,
  axisBreak: 'not to scale',
  sliderLow: 'Shortest',
  sliderHigh: 'Longest',
  valueText: (value, handle) => `${handle} ${spanText(value)} min`,
  unit: 'min'
};

const slot = (overrides: Partial<RestitchTimelineSlot> = {}): RestitchTimelineSlot => ({
  enabled: true,
  image: '/picture.png',
  count: 1,
  builtin: false,
  ...overrides
});

function Harness({
  initial,
  start = slot(),
  end = slot(),
  disabled = false,
  onSelect = () => {}
}: {
  initial: FinalDuration;
  start?: RestitchTimelineSlot;
  end?: RestitchTimelineSlot;
  disabled?: boolean;
  onSelect?: (part: 'start' | 'video' | 'end') => void;
}) {
  const [duration, setDuration] = useState(initial);
  return (
    <RestitchTimeline
      start={start}
      end={end}
      duration={duration}
      onDurationChange={setDuration}
      selected="end"
      onSelect={onSelect}
      disabled={disabled}
      labels={labels}
    />
  );
}

describe('the final picture’s scale', () => {
  it('moves one handle, pushing the other rather than crossing it', () => {
    expect(moveHandle({ low: 30, high: 40 }, 'high', 50)).toEqual({ low: 30, high: 50 });
    expect(moveHandle({ low: 30, high: 40 }, 'low', 45)).toEqual({ low: 45, high: 45 });
    expect(moveHandle({ low: 30, high: 40 }, 'high', 90)).toEqual({ low: 30, high: 60 });
    expect(moveHandle({ low: 30, high: 40 }, 'low', -3)).toEqual({ low: 1, high: 40 });
  });

  it('closes a drag that stops one minute short of the other handle', () => {
    expect(dragHandle({ low: 30, high: 40 }, 'low', 39)).toEqual({ low: 40, high: 40 });
    expect(dragHandle({ low: 30, high: 40 }, 'high', 31.2)).toEqual({ low: 30, high: 30 });
    expect(dragHandle({ low: 30, high: 40 }, 'high', 33)).toEqual({ low: 30, high: 33 });
  });

  it('slides the whole range inside 1–60, keeping its width', () => {
    expect(slideRange({ low: 30, high: 40 }, 7.4)).toEqual({ low: 37, high: 47 });
    expect(slideRange({ low: 30, high: 40 }, 40)).toEqual({ low: 50, high: 60 });
    expect(slideRange({ low: 5, high: 5 }, -10)).toEqual({ low: 1, high: 1 });
  });

  it('steps each handle with the keys a slider owns, and ignores the rest', () => {
    const range: FinalDuration = { low: 40, high: 50 };
    expect(durationAfterKey(range, 'high', 'ArrowRight')).toEqual({ low: 40, high: 51 });
    expect(durationAfterKey(range, 'low', 'PageDown')).toEqual({ low: 35, high: 50 });
    expect(durationAfterKey(range, 'high', 'End')).toEqual({ low: 40, high: 60 });
    expect(durationAfterKey(range, 'low', 'Home')).toEqual({ low: 1, high: 50 });
    // Together they move as one exact length.
    expect(durationAfterKey({ low: 45, high: 45 }, 'high', 'ArrowLeft')).toEqual({
      low: 44,
      high: 44
    });
    expect(durationAfterKey(range, 'low', 'a')).toBeNull();
    expect(spanText({ low: 45, high: 45 })).toBe('45');
    expect(spanText(range)).toBe('40–50');
  });
});

describe('the timeline', () => {
  it('is two sliders a keyboard and a screen reader can use', () => {
    render(<Harness initial={{ low: 40, high: 50 }} />);
    const low = screen.getByRole('slider', { name: 'Shortest' });
    const high = screen.getByRole('slider', { name: 'Longest' });
    expect(low.getAttribute('aria-valuenow')).toBe('40');
    expect(high.getAttribute('aria-valuetext')).toBe('high 40–50 min');
    fireEvent.keyDown(high, { key: 'ArrowLeft' });
    fireEvent.keyDown(high, { key: 'ArrowLeft' });
    expect(high.getAttribute('aria-valuenow')).toBe('48');
    fireEvent.keyDown(low, { key: 'End' });
    expect(high.getAttribute('aria-valuetext')).toBe('high 60 min');
  });

  it('draws a range as a band between the handles, and none for an exact length', () => {
    const { container } = render(<Harness initial={{ low: 30, high: 40 }} />);
    expect(container.querySelector('.restitch-timeline-zone')).not.toBeNull();
    const style = (container.firstElementChild as HTMLElement).style;
    expect(style.getPropertyValue('--end-low')).toBe('0.5');
    expect(style.getPropertyValue('--end-image')).toBe('url("/picture.png")');
    cleanup();
    render(<Harness initial={{ low: 45, high: 45 }} />);
    expect(document.querySelector('.restitch-timeline-zone')).toBeNull();
  });

  it('does not move for someone who may only read', () => {
    render(<Harness initial={{ low: 45, high: 45 }} disabled />);
    const handle = screen.getByRole('slider', { name: 'Longest' });
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('45');
  });

  it('opens a clip’s panel, and shows a slot that is off as off', () => {
    const onSelect = vi.fn();
    render(
      <Harness
        initial={{ low: 45, high: 45 }}
        start={slot({ enabled: false })}
        end={slot({ enabled: false })}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start · Off' }));
    expect(onSelect).toHaveBeenCalledWith('start');
    expect(screen.getByRole('button', { name: 'Final · Off' })).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('marks Soty’s picture, and a slot that draws from several', () => {
    render(
      <Harness
        initial={{ low: 45, high: 45 }}
        start={slot({ builtin: true })}
        end={slot({ count: 3 })}
      />
    );
    expect(screen.getByText('Soty')).toBeTruthy();
    expect(screen.getByTitle('one of 3').textContent).toBe('3');
  });
});
