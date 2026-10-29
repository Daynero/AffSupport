// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HoldToConfirmButton } from '../apps/web/src/components/ui/HoldToConfirmButton';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const confirm = vi.fn();
  const view = render(
    <HoldToConfirmButton hint="Hold for 3 seconds" onConfirm={confirm}>
      Delete
    </HoldToConfirmButton>
  );
  const button = screen.getByRole('button', { name: 'Delete' });
  button.focus();
  vi.useFakeTimers();
  return { confirm, button, view };
}
const down = (button: HTMLElement) => fireEvent.keyDown(button, { key: ' ', code: 'Space' });
const up = (button: HTMLElement) => fireEvent.keyUp(button, { key: ' ', code: 'Space' });

it('requires a full continuous three-second hold and confirms once', () => {
  const { button, confirm } = setup();
  fireEvent.click(button);
  expect(confirm).not.toHaveBeenCalled();
  down(button);
  act(() => vi.advanceTimersByTime(2999));
  expect(confirm).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(confirm).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(6000));
  up(button);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it.each(['release', 'blur', 'window blur', 'unmount', 'disabled'])(
  'cancels on %s and never combines partial holds',
  interruption => {
    const { button, confirm, view } = setup();
    down(button);
    act(() => vi.advanceTimersByTime(2000));
    if (interruption === 'release') up(button);
    if (interruption === 'blur') fireEvent.blur(button);
    if (interruption === 'window blur') fireEvent(window, new Event('blur'));
    if (interruption === 'unmount') view.unmount();
    if (interruption === 'disabled')
      view.rerender(
        <HoldToConfirmButton disabled hint="Hold" onConfirm={confirm}>
          Delete
        </HoldToConfirmButton>
      );
    act(() => vi.advanceTimersByTime(3000));
    expect(confirm).not.toHaveBeenCalled();
    if (interruption === 'release') {
      down(button);
      act(() => vi.advanceTimersByTime(1000));
      up(button);
      expect(confirm).not.toHaveBeenCalled();
    }
  }
);
