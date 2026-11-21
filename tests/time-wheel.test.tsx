// @vitest-environment jsdom
import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TimeWheel } from '../apps/web/src/components/ui/TimeWheel';

// next QA 2026-11-21: a mouse could not turn the wheel — a notch scrolled a few pixels and
// the mandatory snap pulled the list back to the same row.

afterEach(cleanup);

function Host({ start = '04:03' }: { start?: string }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <TimeWheel value={value} onChange={setValue} hoursLabel="Hours" minutesLabel="Minutes" />
      <output data-testid="value">{value}</output>
    </>
  );
}

const wheel = (target: Element, deltaY: number, timeStamp: number, deltaMode = 0) => {
  const event = new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  // A native listener: React applies its state update inside act, not synchronously.
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

it('moves one row per mouse notch and keeps the page behind still', () => {
  render(<Host />);
  const hours = screen.getByRole('listbox', { name: 'Hours' });
  const first = wheel(hours, 4, 1_000);
  expect(first.defaultPrevented).toBe(true);
  expect(screen.getByTestId('value').textContent).toBe('05:03');
  wheel(hours, 4, 2_000);
  expect(screen.getByTestId('value').textContent).toBe('06:03');
  wheel(hours, -4, 3_000);
  expect(screen.getByTestId('value').textContent).toBe('05:03');
});

it('moves by lines for a line-mode wheel and stops at the ends', () => {
  render(<Host start="23:58" />);
  const minutes = screen.getByRole('listbox', { name: 'Minutes' });
  wheel(minutes, 1, 1_000, 1);
  wheel(minutes, 1, 1_010, 1);
  wheel(minutes, 1, 1_020, 1);
  expect(screen.getByTestId('value').textContent).toBe('23:59');
});

it('a pressed row does not take focus from the list', () => {
  render(<Host />);
  const option = screen.getAllByRole('option', { name: '07' })[0]!;
  const pressed = fireEvent.mouseDown(option);
  expect(pressed).toBe(false);
  fireEvent.click(option);
  expect(screen.getByTestId('value').textContent).toBe('07:03');
  expect(document.activeElement).toBe(screen.getByRole('listbox', { name: 'Hours' }));
});
