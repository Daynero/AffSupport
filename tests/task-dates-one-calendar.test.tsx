// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from 'react-aria-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Calendar, RangeCalendar, toCalendarDate } from '../apps/web/src/components/ui/index';

/**
 * T085 — one calendar (024, US4).
 *
 * The product had two, hand-written, 240 lines apart: a 42-cell grid for the
 * board's date filter and another for the task's own day. Neither had a year
 * jump, neither answered PageUp or Home, and the week always started on Monday
 * whatever the reader's locale said — which is right for Ukrainian and wrong
 * for half the places the other language is read in.
 *
 * These hold the three things that made writing one by hand a bad trade, and
 * the one thing that keeps it a single calendar: the markup is gone from both
 * files.
 */

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The day cells, in the order the grid lays them out.
 *
 * Taken from the grid rather than filtered out of every button on the page:
 * a day's accessible name is the locale's own long date, and matching that
 * with a regular expression is how a test ends up asserting the shape of
 * Ukrainian rather than the first day of the week.
 */
function dayNames() {
  return Array.from(document.querySelectorAll('.ui-calendar-day')).map(
    node => node.getAttribute('aria-label') ?? ''
  );
}

describe('both date surfaces render the inventory calendar', () => {
  it('respects the locale first day of the week', async () => {
    const { unmount } = render(
      <I18nProvider locale="en-US">
        <Calendar label="Pick" value={toCalendarDate('2026-09-05')} onChange={() => {}} />
      </I18nProvider>
    );
    expect(dayNames()[0]).toMatch(/^Sunday/);
    unmount();

    render(
      <I18nProvider locale="uk-UA">
        <Calendar label="Обрати" value={toCalendarDate('2026-09-05')} onChange={() => {}} />
      </I18nProvider>
    );
    // Monday-first, and in the reader's own language — neither of which the
    // hand-written grid could do: its weekday initials were a literal array.
    expect(dayNames()[0]).toMatch(/^понеділок/i);
  });

  it('moves by month on PageDown and by year on Shift+PageDown', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en-US">
        <Calendar label="Pick" value={toCalendarDate('2026-09-15')} onChange={() => {}} />
      </I18nProvider>
    );
    const selected = screen.getByRole('button', { name: /September 15, 2026/ });
    selected.focus();
    await user.keyboard('{PageDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/October 15, 2026/);
    await user.keyboard('{Shift>}{PageDown}{/Shift}');
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/October 15, 2027/);
  });

  it('commits only a finished range, so a half-made one is kept rather than lost', async () => {
    const changes: string[] = [];
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en-US">
        <RangeCalendar
          label="Range"
          value={null}
          onChange={next => changes.push(`${next.start.toString()}..${next.end.toString()}`)}
        />
      </I18nProvider>
    );
    await user.click(screen.getByRole('button', { name: /September 10, 2026/ }));
    // One day chosen is a start nobody finished; it is not a filter yet, and
    // it is not thrown away either (021 finding B4).
    expect(changes).toEqual([]);
    await user.click(screen.getByRole('button', { name: /September 14, 2026/ }));
    expect(changes).toEqual(['2026-09-10..2026-09-14']);
  });
});

describe('the hand-written grids are gone', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('leaves no 42-cell month behind in either date surface', () => {
    for (const path of [
      'apps/web/src/team/tasks/TaskDateFilter.tsx',
      'apps/web/src/team/tasks/TaskDateField.tsx'
    ]) {
      const source = read(path);
      expect(source, path).not.toContain('monthDays');
      expect(source, path).not.toContain('task-calendar-days');
      expect(source, path).not.toContain('calendarWeekdays');
    }
  });

  it('leaves no CSS for a grid nothing renders', () => {
    const styles = read('apps/web/src/styles.css');
    expect(styles).not.toContain('.task-calendar-days');
    expect(styles).not.toContain('.task-calendar-weekdays');
    expect(styles).not.toContain('.task-calendar-heading');
  });
});
