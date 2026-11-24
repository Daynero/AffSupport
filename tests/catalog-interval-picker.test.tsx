// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { UpdaterIntervalPicker } from '../apps/web/src/team/catalog-updater/UpdaterIntervalPicker';

vi.mock('../apps/web/src/i18n', () => ({
  useI18n: () => ({
    language: 'en',
    t: (key: string, values?: { date?: string; count?: string }) => {
      const labels: Record<string, string> = {
        catalogUpdaterEveryHour: 'Hourly',
        catalogUpdaterEveryDay: 'Daily',
        catalogUpdaterEveryWeek: 'Weekly',
        catalogUpdaterOff: 'Off',
        catalogScheduleCustom: 'Custom',
        catalogScheduleSave: 'Save',
        catalogScheduleSaving: 'Saving…',
        catalogScheduleDisable: 'Disable',
        catalogScheduleTime: 'Time',
        catalogScheduleKyivTime: 'Kyiv time',
        catalogScheduleKyivZone: 'Kyiv',
        catalogScheduleOpenTime: 'Open time picker',
        catalogScheduleWeekday: 'Weekday',
        catalogUpdaterIntervalHours: 'Hours'
      };
      return labels[key] ?? `${key}${values?.date ? ` ${values.date}` : ''}`;
    }
  })
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('drafts a preset and commits only when Save is pressed', async () => {
  const onChange = vi.fn();
  render(<UpdaterIntervalPicker value="1h" label="Schedule" onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Hourly' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Daily' }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Time')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('1d');
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});

it('moves keyboard focus into the selected schedule preset on opening', async () => {
  render(<UpdaterIntervalPicker value="1d" label="Schedule" onChange={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: 'Schedule: Daily' });
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Daily' }))
  );
  // One stop for the group (070, T056: the inventory's SegmentedControl); the arrows walk it.
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Weekly' }));
  await userEvent.keyboard('{Escape}');
  expect(document.activeElement).toBe(trigger);
});

it('discards unsaved draft on close and keeps custom hours to what a schedule can take', async () => {
  const onChange = vi.fn();
  render(<UpdaterIntervalPicker value="1h" label="Schedule" onChange={onChange} />);
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Hourly' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Weekly' }));
  await userEvent.keyboard('{Escape}');
  expect(onChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Hourly' }));
  expect(screen.getByRole('radio', { name: 'Hourly' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  // The inventory's number field holds its bounds (070, T056): 0 becomes the nearest that can be.
  const hours = screen.getByLabelText('Hours');
  await userEvent.clear(hours);
  await userEvent.type(hours, '0');
  await userEvent.tab();
  expect(hours).toHaveProperty('value', '1');
  await userEvent.clear(hours);
  await userEvent.type(hours, '6');
  await userEvent.tab();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('6h');
});

it('awaits an atomic weekday and time save, retains errors, and permits retry', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('NETWORK_ERROR'))
    .mockResolvedValueOnce(undefined);
  const onChange = vi.fn();
  render(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      schedule={{ timeZone: 'Europe/Kyiv', weekday: 1, time: '09:00' }}
      onChange={onChange}
      onSaveSchedule={save}
      nextTitle="CURRENT NEXT"
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  expect(screen.getByText(/CURRENT NEXT/)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Friday' }));
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:35' } });
  expect(screen.queryByText(/CURRENT NEXT/)).toBeNull();
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '14:35');
  expect(save).toHaveBeenLastCalledWith('1w', {
    timeZone: 'Europe/Kyiv',
    weekday: 5,
    time: '14:35'
  });
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(onChange).not.toHaveBeenCalled();
});

it('keeps saving open and locked, then disables with an explicit null schedule', async () => {
  let resolve!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>(done => {
        resolve = done;
      })
  );
  render(
    <UpdaterIntervalPicker value="1d" label="Schedule" onChange={vi.fn()} onSaveSchedule={save} />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Daily' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Hourly' }));
  expect(screen.queryByLabelText('Time')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledExactlyOnceWith('1h', null);
  expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy();
  await act(async () => resolve());
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Daily' }));
  await userEvent.click(screen.getByRole('button', { name: 'Disable' }));
  expect(save).toHaveBeenLastCalledWith(null, null);
  await act(async () => resolve());
});

it('upgrades a legacy weekly schedule using its existing next run instead of resetting its time', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const next = new Date(2026, 9, 25, 18, 2);
  render(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      schedule={null}
      nextRunAt={next.toISOString()}
      onChange={vi.fn()}
      onSaveSchedule={save}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  expect(screen.getByRole('radio', { name: 'Sunday' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '18:02');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledExactlyOnceWith('1w', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekday: 7,
    time: '18:02'
  });
});

it('preserves a local draft instead of overwriting a schedule changed by another user', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const onChange = vi.fn();
  const initial = { timeZone: 'Europe/Kyiv', weekday: 1, time: '09:00' };
  const view = render(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      schedule={initial}
      onChange={onChange}
      onSaveSchedule={save}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: '14:35' } });
  view.rerender(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      schedule={{ ...initial, weekday: 7, time: '18:00' }}
      onChange={onChange}
      onSaveSchedule={save}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '14:35');
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '18:00');
  expect(screen.getByRole('radio', { name: 'Sunday' }).getAttribute('aria-checked')).toBe('true');
});

it('keeps the same feedback and footer slots through weekly/custom/hourly/daily mode cycles', async () => {
  const save = vi.fn();
  render(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      schedule={{ timeZone: 'Europe/Kyiv', weekday: 7, time: '18:00' }}
      onChange={vi.fn()}
      onSaveSchedule={save}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  const feedback = document.querySelector('.catalog-schedule-feedback');
  const footer = document.querySelector('.catalog-schedule-footer');
  for (const name of ['Custom', 'Weekly', 'Hourly', 'Daily', 'Weekly']) {
    await userEvent.click(screen.getByRole('radio', { name }));
    expect(document.querySelector('.catalog-schedule-feedback')).toBe(feedback);
    expect(document.querySelector('.catalog-schedule-footer')).toBe(footer);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false
    );
  }
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '18:00');
  expect(save).not.toHaveBeenCalled();
});

it('previews the next run for hourly and custom intervals and retains a saved due date', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-19T09:00:00Z'));
  render(
    <UpdaterIntervalPicker
      value="6h"
      label="Schedule"
      nextRunAt="2026-10-20T14:00:00Z"
      schedule={null}
      onChange={vi.fn()}
      onSaveSchedule={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: catalogUpdaterEveryHours' }));
  const feedback = document.querySelector('.catalog-schedule-feedback')!;
  const existing = feedback.textContent;
  expect(existing).toContain('20');
  const hours = screen.getByLabelText('Hours');
  await userEvent.clear(hours);
  await userEvent.type(hours, '8');
  await userEvent.tab();
  expect(feedback.textContent).not.toBe(existing);
  expect(feedback.querySelector('strong')?.textContent).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Hourly' }));
  expect(feedback.querySelector('strong')?.textContent).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  // Past the longest interval the field settles on it, and the preview follows.
  await userEvent.clear(screen.getByLabelText('Hours'));
  await userEvent.type(screen.getByLabelText('Hours'), '999');
  await userEvent.tab();
  expect(screen.getByLabelText('Hours')).toHaveProperty('value', '720');
  expect(feedback.querySelector('strong')?.textContent).toBeTruthy();
});

it('opens the native time picker from the arrow on the first click without prior input focus', async () => {
  render(
    <UpdaterIntervalPicker
      value="1w"
      label="Schedule"
      onChange={vi.fn()}
      onSaveSchedule={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: Weekly' }));
  const input = screen.getByLabelText('Time') as HTMLInputElement;
  const showPicker = vi.fn();
  Object.defineProperty(input, 'showPicker', { configurable: true, value: showPicker });
  expect(document.activeElement).not.toBe(input);
  await userEvent.click(screen.getByRole('button', { name: 'Open time picker' }));
  expect(showPicker).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
});

it('names the saved Kyiv time zone beside the calendar time', async () => {
  render(
    <UpdaterIntervalPicker
      value="1d"
      schedule={{ timeZone: 'Europe/Kiev', weekday: 1, time: '09:00' }}
      label="Schedule"
      onChange={vi.fn()}
      onSaveSchedule={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: /Schedule:/ }));
  expect(screen.getByText('Kyiv time')).toBeTruthy();
});

it('previews a new interval from the observed server clock when the computer clock is wrong', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T01:00:00Z'));
  render(
    <UpdaterIntervalPicker
      value="6h"
      label="Schedule"
      clockOffsetMs={20 * 60 * 60 * 1000}
      schedule={{ timeZone: 'UTC', time: '09:00', weekday: 1 }}
      onChange={vi.fn()}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Schedule: catalogUpdaterEveryHours' }));
  expect(document.querySelector('.catalog-schedule-feedback strong')?.textContent).toBe(
    'January 2, 03:00'
  );
});
