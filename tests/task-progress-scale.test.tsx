// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskProgressScale } from '../apps/web/src/team/tasks/TaskProgressScale';

/**
 * Setting progress on a card and finding it back where it was.
 *
 * The scale committed only from `pointerup`, and only when the control was not
 * busy. Both of those let a finished gesture vanish: a pointer the browser
 * takes back — a scroll claiming the drag, a window losing focus, a touch
 * cancelled by the platform — fires `pointercancel` instead, and a card that
 * became busy mid-drag swallowed the release. In either case the knob stayed
 * where it had been pulled and nothing was ever sent, so the value looked set
 * until the next reload said otherwise.
 *
 * Every other drag control in this codebase already handled `pointercancel`;
 * this one did not.
 */

/** jsdom implements no pointer capture, so the element gets a real one. */
function stubPointerCapture() {
  const captured = new Set<number>();
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    captured.add(id);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(id: number) {
    captured.delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(id: number) {
    return captured.has(id);
  };
  return captured;
}

/** A 100px-wide track, so a clientX maps predictably onto the scale. */
function stubTrackBounds() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    toJSON: () => ({})
  } as DOMRect);
}

function Harness({
  disabled = false,
  onCommit
}: {
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [value, setValue] = useState(3);
  return (
    <TaskProgressScale
      value={value}
      max={10}
      label="Progress"
      disabled={disabled}
      onChange={setValue}
      onCommit={onCommit}
    />
  );
}

const slider = () => screen.getByRole('slider');
const drag = (clientX: number) => {
  fireEvent.pointerDown(slider(), { pointerId: 1, clientX });
  fireEvent.pointerMove(slider(), { pointerId: 1, clientX });
};

beforeEach(() => {
  stubPointerCapture();
  stubTrackBounds();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('committing a progress gesture', () => {
  it('saves the value on an ordinary release', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    drag(90);
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 90 });

    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it('saves the value shown when the browser cancels the pointer', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    drag(90);
    expect(slider().getAttribute('aria-valuenow')).toBe('9');
    // A scroll gesture takes over: no `pointerup` will arrive at all.
    fireEvent.pointerCancel(slider(), { pointerId: 1 });

    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it('saves a release that arrives after the card became busy', () => {
    const onCommit = vi.fn();
    const view = render(<Harness onCommit={onCommit} />);

    drag(70);
    // Another edit on the same card started saving while the finger was down.
    view.rerender(<Harness disabled onCommit={onCommit} />);
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 70 });

    // The gesture really happened, so it is honoured — with what was on screen
    // rather than a position the disabled control never followed.
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits nothing when a cancel arrives without a drag', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.pointerCancel(slider(), { pointerId: 1 });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('refuses to start a gesture while the control is disabled', () => {
    const onCommit = vi.fn();
    render(<Harness disabled onCommit={onCommit} />);

    drag(90);
    fireEvent.pointerUp(slider(), { pointerId: 1, clientX: 90 });

    expect(onCommit).not.toHaveBeenCalled();
    expect(slider().getAttribute('aria-valuenow')).toBe('3');
  });

  it('commits a keyboard step, which never depended on a pointer at all', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    fireEvent.keyDown(slider(), { key: 'ArrowRight' });

    expect(onCommit).toHaveBeenCalledWith(4);
  });
});
