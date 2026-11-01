// @vitest-environment jsdom
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseAdminTariffRow, parseTariffPlan } from '../packages/shared/src/types';
import { adminTariffApi } from '../apps/web/src/api/team';
import { TariffEditDialog } from '../apps/web/src/pages/admin/TariffEditDialog';
import { TariffGrantDialog } from '../apps/web/src/pages/admin/TariffGrantDialog';
const row = parseAdminTariffRow({
  id: 'tariff',
  ownerId: 'owner',
  ownerEmail: 'owner@test.invalid',
  planCode: 'lead',
  endsOn: '2030-12-31',
  updatedAt: '2030-01-01T00:00:00Z'
})!;
const plans = [parseTariffPlan({ code: 'lead', nameUk: 'Команда', nameEn: 'Team', baseSeats: 2 })!];
beforeEach(() => localStorage.setItem('language', 'en'));
it('shows every affected space and submits Google approval only after explicit scope confirmation', async () => {
  const update = vi.fn().mockResolvedValue(row);
  render(
    <TariffEditDialog
      row={row}
      plans={plans}
      client={{
        ...adminTariffApi,
        update,
        previewDriveApproval: vi.fn().mockResolvedValue({
          revision: 'scope-revision',
          accountEmail: row.ownerEmail,
          spaces: [
            { id: 'one', name: 'First paid space' },
            { id: 'two', name: 'Second paid space' }
          ]
        })
      }}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onShowSeats={vi.fn()}
    />
  );
  fireEvent.change(screen.getByLabelText('Approve Google account'), {
    target: { value: 'replacement@test.invalid' }
  });
  await screen.findByText('Second paid space');
  const save = screen.getByRole('button', { name: 'Save and approve Google account' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('First paid space')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm the change/ }));
  fireEvent.click(save);
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedGoogleEmail: 'replacement@test.invalid',
        googleApprovalRevision: 'scope-revision'
      })
    )
  );
});
it('recovers the saved grant instead of turning a different form into another purchase', async () => {
  const input = {
    email: 'prior@test.invalid',
    plan: 'lead',
    endsOn: '2030-01-31',
    extraSeats: 4,
    teamId: null,
    note: null,
    externalRef: null,
    notify: false
  };
  const grant = vi.fn().mockResolvedValue(row),
    onGranted = vi.fn();
  render(
    <TariffGrantDialog
      plans={plans}
      tariffToday="2030-01-01"
      prefill={{ email: 'different@test.invalid', source: 'request' }}
      requests={[]}
      client={{
        ...adminTariffApi,
        grant,
        pendingGrant: vi.fn().mockResolvedValue(input),
        listOwnerSpaces: vi.fn().mockResolvedValue([]),
        preview: vi.fn().mockResolvedValue(null)
      }}
      onClose={vi.fn()}
      onGranted={onGranted}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Check previous grant' }));
  await waitFor(() => expect(grant).toHaveBeenCalledWith(input));
  expect(onGranted).toHaveBeenCalledWith(row, { email: input.email, source: 'manual' });
});
