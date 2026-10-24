// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskDateField } from '../apps/web/src/team/tasks/TaskDateField';
import { TaskDateFilterControl } from '../apps/web/src/team/tasks/TaskDateFilter';

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(cleanup);

it('starts keyboard editing on the selected day and returns focus on Escape', async () => {
  render(<TaskDateField value="2026-10-21" createdOn="2026-10-01" isCustom onChange={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: /^Date:/ });
  trigger.focus();
  fireEvent.click(trigger);
  const day = within(screen.getByRole('dialog')).getByRole('button', { name: /October 21, 2026/ });
  expect(document.activeElement === day).toBe(true);
  fireEvent.keyDown(day, { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 });
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/October 20, 2026/);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape', keyCode: 27 });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('starts the board range filter inside its calendar instead of the page behind it', async () => {
  render(
    <TaskDateFilterControl
      value={{ kind: 'range', from: '2026-10-21', to: '2026-10-21' }}
      onChange={vi.fn()}
      status="all"
      onStatusChange={vi.fn()}
      calendarLabel="Choose test range"
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose test range' }));
  const day = within(screen.getByRole('dialog')).getByRole('button', { name: /October 21, 2026/ });
  expect(document.activeElement === day).toBe(true);
  fireEvent.keyDown(day, { key: 'Escape', code: 'Escape', keyCode: 27 });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Choose test range' }));
});
