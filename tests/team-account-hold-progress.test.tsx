// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivationController } from '@dnd-kit/abstract';
import {
  AccountHoldConstraint,
  AccountHoldProgress
} from '../apps/web/src/team/accounts/AccountHoldProgress';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function pointer(type: string, x = 20, y = 30) {
  return new MouseEvent(type, { clientX: x, clientY: y }) as PointerEvent;
}
function hold() {
  vi.useFakeTimers();
  const present = vi.fn();
  const activate = vi.fn();
  const controller = new ActivationController([new AccountHoldConstraint(present)], activate);
  controller.onEvent(pointer('pointerdown'));
  return { present, activate, controller };
}
it('shows progress only after the click grace period and still captures at 500ms', () => {
  const { present, activate } = hold();
  expect(present).not.toHaveBeenCalled();
  vi.advanceTimersByTime(199);
  expect(present).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(present).toHaveBeenLastCalledWith({ x: 20, y: 30 });
  vi.advanceTimersByTime(299);
  expect(activate).not.toHaveBeenCalled();
  expect(present).not.toHaveBeenLastCalledWith(null);
  vi.advanceTimersByTime(1);
  expect(activate).toHaveBeenCalledTimes(1);
  expect(present).toHaveBeenLastCalledWith(null);
});
it.each(['pointerup', 'pointermove', 'abort'])(
  'never shows progress or captures after a quick %s',
  type => {
    const { present, activate, controller } = hold();
    vi.advanceTimersByTime(120);
    if (type === 'abort') controller.abort();
    else controller.onEvent(pointer(type, type === 'pointermove' ? 40 : 20));
    vi.advanceTimersByTime(1000);
    expect(present.mock.calls.every(([point]) => point === null)).toBe(true);
    expect(activate).not.toHaveBeenCalled();
  }
);
it.each(['pointerup', 'pointermove', 'abort'])(
  'clears progress and prevents a late lift after %s',
  type => {
    const { present, activate, controller } = hold();
    vi.advanceTimersByTime(200);
    if (type === 'abort') controller.abort();
    else controller.onEvent(pointer(type, type === 'pointermove' ? 40 : 20));
    expect(present).toHaveBeenLastCalledWith(null);
    vi.advanceTimersByTime(1000);
    expect(activate).not.toHaveBeenCalled();
  }
);
it('portals the decorative ring outside table clipping and removes it on unmount', () => {
  const view = render(<AccountHoldProgress point={{ x: 40, y: 60 }} />);
  const ring = document.querySelector('.account-hold-progress');
  expect(ring?.parentElement).toBe(document.body);
  expect(ring?.getAttribute('aria-hidden')).toBe('true');
  expect(view.container.childElementCount).toBe(0);
  act(() => view.unmount());
  expect(document.querySelector('.account-hold-progress')).toBeNull();
});
