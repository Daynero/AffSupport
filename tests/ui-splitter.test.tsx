// @vitest-environment jsdom
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Splitter, type SplitterProps } from '../apps/web/src/components/ui/index';

/**
 * The movable edge between two panes (070, R5, FR-006).
 *
 * A window splitter as the ARIA practices describe it: a focusable separator
 * that reports its value and bounds, moves with the arrows by 16 px and to its
 * bounds with Home and End, follows a drag, and never animates the pane.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness(
  props: Partial<SplitterProps> & { initial?: number; onEnd?: (v: number) => void }
) {
  const [value, setValue] = useState(props.initial ?? 240);
  return (
    <Splitter
      label="Folder tree width"
      min={200}
      max={480}
      {...props}
      value={value}
      onChange={setValue}
      onChangeEnd={props.onEnd}
    />
  );
}

/**
 * One step of a drag, in whichever events React Aria listens for here: pointer
 * events where the environment has them, mouse events otherwise. jsdom has no
 * `pageX` on its events, and `useMove` measures with it, so it is set by hand.
 */
function drag(target: EventTarget, phase: 'down' | 'move' | 'up', x: number) {
  const pointer = typeof window.PointerEvent !== 'undefined';
  const type = `${pointer ? 'pointer' : 'mouse'}${phase}`;
  const Event = pointer ? window.PointerEvent : window.MouseEvent;
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: 10,
    ...(pointer ? { pointerId: 1, pointerType: 'mouse' } : {})
  });
  Object.defineProperty(event, 'pageX', { value: x });
  Object.defineProperty(event, 'pageY', { value: 10 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('Splitter', () => {
  it('is a named, focusable separator that reports where it is', () => {
    render(<Harness />);
    const edge = screen.getByRole('separator', { name: 'Folder tree width' });
    expect(edge.tabIndex).toBe(0);
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    expect(edge.getAttribute('aria-valuenow')).toBe('240');
    expect(edge.getAttribute('aria-valuemin')).toBe('200');
    expect(edge.getAttribute('aria-valuemax')).toBe('480');
  });

  it('moves 16 px per arrow, to the bounds with Home and End, and no further', async () => {
    const onEnd = vi.fn();
    render(<Harness onEnd={onEnd} />);
    const edge = screen.getByRole('separator');
    edge.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(edge.getAttribute('aria-valuenow')).toBe('256');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(edge.getAttribute('aria-valuenow')).toBe('224');
    await userEvent.keyboard('{End}');
    expect(edge.getAttribute('aria-valuenow')).toBe('480');
    await userEvent.keyboard('{ArrowRight}');
    expect(edge.getAttribute('aria-valuenow')).toBe('480');
    await userEvent.keyboard('{Home}{ArrowLeft}');
    expect(edge.getAttribute('aria-valuenow')).toBe('200');
    expect(onEnd).toHaveBeenLastCalledWith(200);
    // Up and down belong to a lying edge, not to this one.
    await userEvent.keyboard('{ArrowDown}');
    expect(edge.getAttribute('aria-valuenow')).toBe('200');
  });

  it('reads the arrows of its own orientation, and grows the pane after it when told', async () => {
    render(<Harness orientation="horizontal" side="end" />);
    const edge = screen.getByRole('separator');
    expect(edge.getAttribute('aria-orientation')).toBe('horizontal');
    edge.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(edge.getAttribute('aria-valuenow')).toBe('256');
    await userEvent.keyboard('{ArrowRight}');
    expect(edge.getAttribute('aria-valuenow')).toBe('256');
  });

  it('follows a drag from where it started and stops at the bound', () => {
    const onEnd = vi.fn();
    render(<Harness onEnd={onEnd} />);
    const edge = screen.getByRole('separator');
    drag(edge, 'down', 100);
    drag(window, 'move', 140);
    expect(edge.getAttribute('aria-valuenow')).toBe('280');
    expect(edge.className).toContain('is-dragging');
    drag(window, 'move', 600);
    expect(edge.getAttribute('aria-valuenow')).toBe('480');
    // Back inside the bounds the pane is where the pointer is, not where it piled up.
    drag(window, 'move', 120);
    expect(edge.getAttribute('aria-valuenow')).toBe('260');
    drag(window, 'up', 120);
    expect(edge.className).not.toContain('is-dragging');
    expect(onEnd).toHaveBeenCalledWith(260);
  });

  it('animates nothing but the line, and that only on a motion token', () => {
    const css = readFileSync('apps/web/src/styles/components.css', 'utf8');
    const rules = [...css.matchAll(/(\.ui-splitter[^{]*)\{([^}]*)\}/gu)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      const transition = /transition:\s*([^;]+)/u.exec(body);
      if (!transition) continue;
      expect(selector).toContain('::before');
      expect(transition[1]).toMatch(/^background-color var\(--motion-fast\)/u);
    }
  });
});
