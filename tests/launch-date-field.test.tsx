// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchDateField, launchShortcutDate } from '../apps/web/src/team/launches/LaunchDateField';
afterEach(cleanup);
it('calculates shortcuts in the launch timezone across DST, month and year boundaries', () => {
  const instant = new Date('2026-03-29T00:30:00Z');
  expect(launchShortcutDate(0, 'Europe/Kyiv', instant)).toBe('2026-03-29');
  expect(launchShortcutDate(1, 'Europe/Kyiv', instant)).toBe('2026-03-30');
  expect(launchShortcutDate(0, 'Pacific/Honolulu', instant)).toBe('2026-03-28');
  expect(launchShortcutDate(1, 'UTC', new Date('2024-02-28T12:00:00Z'))).toBe('2024-02-29');
  expect(launchShortcutDate(1, 'UTC', new Date('2026-12-31T12:00:00Z'))).toBe('2027-01-01');
});
it('shows a text date and changes it immediately with Today and Tomorrow', () => {
  function Host() {
    const [value, setValue] = React.useState('2026-10-17');
    return <LaunchDateField value={value} timezone="Pacific/Honolulu" onChange={setValue} />;
  }
  render(<Host />);
  expect(screen.getByText('Launch date: 17.10.26')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  const today = launchShortcutDate(0, 'Pacific/Honolulu').split('-');
  expect(
    screen.getByText(`Launch date: ${today[2]}.${today[1]}.${today[0].slice(-2)}`)
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }));
  const tomorrow = launchShortcutDate(1, 'Pacific/Honolulu').split('-');
  expect(
    screen.getByText(`Launch date: ${tomorrow[2]}.${tomorrow[1]}.${tomorrow[0].slice(-2)}`)
  ).toBeTruthy();
});
it('opens the shared calendar, selects a custom date, and closes it', () => {
  const commit = vi.fn();
  render(<LaunchDateField value="2026-10-17" timezone="UTC" onChange={commit} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose launch date' }));
  expect(screen.getByRole('dialog', { name: 'Choose launch date' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /October 20, 2026/ }));
  expect(commit).toHaveBeenCalledWith('2026-10-20');
  expect(screen.queryByRole('dialog', { name: 'Choose launch date' })).toBeNull();
});
it('disables all three actions when the editor is locked', () => {
  render(<LaunchDateField value="2026-10-17" timezone="UTC" disabled onChange={vi.fn()} />);
  for (const button of screen.getAllByRole('button'))
    expect(button.hasAttribute('disabled')).toBe(true);
});
