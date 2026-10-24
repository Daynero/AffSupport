// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TariffDateField } from '../apps/web/src/pages/admin/TariffDateField';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TariffBanner } from '../apps/web/src/team/tariffs/TariffBanner';
const state = vi.hoisted(() => ({ day: '2030-10-11' }));
vi.mock('../apps/web/src/team/tariffs/useSpaceAccess', () => ({
  useOptionalSpaceAccess: () => ({
    access: {
      tariffToday: state.day,
      banner: {
        teamId: 'calendar-team',
        teamName: 'Fixture',
        kind: 'warn_3d',
        endsOn: '2030-10-14',
        graceUntil: '2030-10-17',
        daysLeft: 3,
        updaterRunning: false,
        planCode: 'lead'
      },
      teams: [],
      showcase: null
    }
  })
}));
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  state.day = '2030-10-11';
});
it('uses server year in the rendered banner and server day for dismissal', () => {
  render(
    <ToastProvider>
      <TariffBanner teamId="calendar-team" />
    </ToastProvider>
  );
  expect(screen.getByText('The plan runs until 14 October inclusive.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide until tomorrow' }));
  expect(screen.queryByText('The plan runs until 14 October inclusive.')).toBeNull();
  expect(
    JSON.parse(window.localStorage.getItem('soty.tariff-banner.dismissed.v1') ?? '{}')
  ).toEqual({ 'calendar-team:2030-10-14': '2030-10-11' });
});
it('shows a dismissed banner when the authoritative tariff day advances', () => {
  window.localStorage.setItem(
    'soty.tariff-banner.dismissed.v1',
    JSON.stringify({ 'calendar-team:2030-10-14': '2030-10-11' })
  );
  const view = render(
    <ToastProvider>
      <TariffBanner teamId="calendar-team" />
    </ToastProvider>
  );
  expect(screen.queryByText('The plan runs until 14 October inclusive.')).toBeNull();
  state.day = '2030-10-12';
  view.rerender(
    <ToastProvider>
      <TariffBanner teamId="calendar-team" />
    </ToastProvider>
  );
  expect(screen.getByText('The plan runs until 14 October inclusive.')).toBeTruthy();
});

it('formats the admin date picker label against its server calendar', () => {
  render(
    <TariffDateField
      value="2030-10-14"
      tariffToday="2030-10-11"
      onChange={() => undefined}
      label="Ends on"
    />
  );
  expect(screen.getByRole('button', { name: 'Ends on: 14 October' })).toBeTruthy();
});
