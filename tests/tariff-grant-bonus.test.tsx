// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { parseAdminTariffRow, parseTariffPlan } from '../packages/shared/src/types';
import { adminTariffApi } from '../apps/web/src/api/team';
import { TariffGrantDialog } from '../apps/web/src/pages/admin/TariffGrantDialog';
import { addMonthsPreview, grantEndsOn } from '../apps/web/src/pages/admin/tariffModel';

// Calendar selection itself has its own real-component tests; expose the chosen date here.
vi.mock('../apps/web/src/pages/admin/TariffDateField', () => ({
  TariffDateField: ({
    value,
    onChange,
    label
  }: {
    value: string | null;
    onChange: (value: string) => void;
    label: string;
  }) => (
    <input
      type="date"
      aria-label={label}
      value={value ?? ''}
      onChange={event => onChange(event.target.value)}
    />
  )
}));

beforeEach(() => localStorage.setItem('language', 'en'));

function setup() {
  const grant = vi.fn().mockResolvedValue(
    parseAdminTariffRow({
      id: 'grant',
      ownerEmail: 'owner@example.test',
      planCode: 'lead',
      endsOn: '2030-03-10'
    })
  );
  const onGranted = vi.fn();
  render(
    <TariffGrantDialog
      plans={[parseTariffPlan({ code: 'lead', nameUk: 'Команда', nameEn: 'Team', baseSeats: 2 })!]}
      tariffToday="2030-01-31"
      prefill={{ email: 'owner@example.test', source: 'manual' }}
      requests={[]}
      client={{
        ...adminTariffApi,
        grant,
        listOwnerSpaces: vi.fn().mockResolvedValue([]),
        preview: vi.fn().mockResolvedValue(null)
      }}
      onClose={vi.fn()}
      onGranted={onGranted}
    />
  );
  return { grant, onGranted };
}

it.each([
  ['2030-01-31', 1, 10, '2030-03-10'],
  ['2028-01-31', 1, 10, '2028-03-10'],
  ['2030-03-01', 1, 10, '2030-04-11'],
  ['2030-11-30', 1, 10, '2031-01-09'],
  ['2030-01-31', 3, 10, '2030-05-10'],
  ['2030-01-31', 1, 0, '2030-02-28']
])('calculates first-period calendar %s + %s months + %s days', (start, months, bonus, end) => {
  expect(grantEndsOn(start, months, bonus)).toBe(end);
});

it('submits the advertised bonus using the server calendar and reports only a saved grant', async () => {
  const { grant, onGranted } = setup();
  expect(onGranted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Grant until 7 March' }));
  await waitFor(() =>
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ endsOn: '2030-03-07' }))
  );
  await waitFor(() => expect(onGranted).toHaveBeenCalledTimes(1));
});

it('allows the administrator to remove the bonus', async () => {
  const { grant } = setup();
  const input = screen.getByRole('textbox', { name: 'Bonus days' });
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole('button', { name: 'Grant until 28 February' }));
  await waitFor(() =>
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ endsOn: '2030-02-28' }))
  );
});

it('seeds the exact date from the bonus preview and does not add bonus days to a manual date', async () => {
  const { grant } = setup();
  fireEvent.click(screen.getByRole('radio', { name: 'Date' }));
  const date = screen.getByLabelText('Last day') as HTMLInputElement;
  expect(date.value).toBe('2030-03-07');
  fireEvent.change(date, { target: { value: '2040-01-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Grant until 31 January 2040' }));
  await waitFor(() =>
    expect(grant).toHaveBeenCalledWith(expect.objectContaining({ endsOn: '2040-01-31' }))
  );
});

it('does not add another bonus when previewing a renewal', () => {
  expect(addMonthsPreview('2030-03-10', 1)).toBe('2030-04-10');
});

it('keeps a failed grant open without reporting that access was granted', async () => {
  const { grant, onGranted } = setup();
  grant.mockRejectedValueOnce(new Error('TARIFF_BOUND'));
  fireEvent.click(screen.getByRole('button', { name: 'Grant until 7 March' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(onGranted).not.toHaveBeenCalled();
});
