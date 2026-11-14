// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TagDot } from '../apps/web/src/team/explorer/TagDot';

const hitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
afterEach(() => {
  cleanup();
  if (hitTest) Object.defineProperty(document, 'elementFromPoint', hitTest);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});

it('cancels a sliding tag gesture without changing the tag or leaving its row undraggable', async () => {
  const change = vi.fn();
  const view = render(
    <div draggable data-testid="row">
      <TagDot color="red" name="clip" canTag onChange={change} />
    </div>
  );
  const trigger = screen.getByRole('button');
  fireEvent(trigger, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  const green = await screen.findByRole('menuitemradio', { name: 'Green' });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => green });
  fireEvent(document, new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
  expect(green.classList.contains('is-aimed')).toBe(true);
  expect(screen.getByTestId('row').getAttribute('draggable')).toBe('false');
  fireEvent.pointerCancel(document);
  fireEvent.pointerUp(document);
  expect(change).not.toHaveBeenCalled();
  expect(green.classList.contains('is-aimed')).toBe(false);
  expect(screen.getByTestId('row').getAttribute('draggable')).toBe('true');
  fireEvent.click(green);
  expect(change).toHaveBeenCalledExactlyOnceWith('green');
  view.unmount();
});

it('clears an existing tag and returns focus when the picker is dismissed', async () => {
  const change = vi.fn();
  render(<TagDot color="red" name="clip" canTag onChange={change} appearance="palette" />);
  const trigger = screen.getByRole('button');
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('menuitem'));
  expect(change).toHaveBeenCalledExactlyOnceWith(null);
  fireEvent.click(trigger);
  await screen.findByRole('menu');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
  expect(document.activeElement).toBe(trigger);
});
