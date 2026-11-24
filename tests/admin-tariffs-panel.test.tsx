// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  parseAdminTariffRow,
  parseTariffPlan,
  type AdminSpaceRequest,
  type AdminTariffRow
} from '../packages/shared/src/types';
import type { AdminTariffClient } from '../apps/web/src/api/team';
import { ToastProvider } from '../apps/web/src/components/toast';

const ai = vi.hoisted(() => ({
  peopleCredits: vi.fn(),
  spaces: vi.fn(),
  grantBonus: vi.fn(),
  setSpace: vi.fn()
}));
vi.mock('../apps/web/src/api/ai-budget', () => ({ aiBudgetApi: ai }));
// The balance in the header is re-read after a bonus; the server read is not this test's.
vi.mock('../apps/web/src/credits/store', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/credits/store')>()),
  refreshCredits: vi.fn(async () => undefined)
}));

import { TariffsPanel } from '../apps/web/src/pages/admin/TariffsPanel';

/**
 * 034/064: the administrator's ledger of spaces — what needs attention, a month more in one
 * press with an undo, and each owner's credits and assistant switch beside the tariff.
 */

function tariff(fields: Record<string, unknown>): AdminTariffRow {
  return parseAdminTariffRow({
    planCode: 'lead',
    endsOn: '2030-12-31',
    updatedAt: '2030-01-01T00:00:00Z',
    tariffToday: '2030-12-01',
    ...fields
  })!;
}

const alpha = tariff({
  id: 'tariff-alpha',
  ownerEmail: 'alpha@test.invalid',
  ownerName: 'Alpha Owner',
  teamId: 'team-alpha',
  teamName: 'Alpha',
  state: 'active',
  daysLeft: 30,
  seatsUsed: 2,
  seatsTotal: 3,
  note: 'paid by card'
});
const beta = tariff({
  id: 'tariff-beta',
  ownerEmail: 'beta@test.invalid',
  teamId: 'team-beta',
  teamName: 'Beta',
  state: 'grace',
  endsOn: '2030-11-28',
  graceUntil: '2030-12-05',
  daysLeft: 0
});
const waiting = tariff({
  id: 'tariff-waiting',
  ownerEmail: 'waiting@test.invalid',
  state: 'pending',
  daysLeft: 1,
  seatsTotal: 2
});
const paused = tariff({
  id: 'tariff-paused',
  ownerEmail: 'paused@test.invalid',
  teamId: 'team-paused',
  teamName: 'Paused space',
  state: 'blocked',
  legacyAlso: true
});
const plans = [parseTariffPlan({ code: 'lead', nameUk: 'Команда', nameEn: 'Team', baseSeats: 2 })!];
const request: AdminSpaceRequest = {
  userId: 'user-request',
  email: 'asks@test.invalid',
  name: 'Asking Person',
  planInterest: 'lead',
  channel: 'telegram',
  createdAt: '2030-11-30T10:00:00Z',
  lastContactAt: null,
  handledAt: null,
  adminNote: null,
  hasTariff: false
};

function fakeClient(overrides: Partial<AdminTariffClient> = {}): AdminTariffClient {
  return {
    listTariffs: vi.fn(async () => [alpha, beta, waiting, paused]),
    listPlans: vi.fn(async () => plans),
    listRequests: vi.fn(async () => [request]),
    listLegacySpaces: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({
      tariffToday: '2030-12-01',
      telegram: null,
      email: null,
      legacyRuleEnabled: false,
      legacySpacesRemaining: 0
    })),
    extend: vi.fn(),
    undo: vi.fn(),
    markRequest: vi.fn(async () => undefined),
    listEvents: vi.fn(async () => []),
    listSeats: vi.fn(async () => []),
    ...overrides
  } as unknown as AdminTariffClient;
}

function renderPanel(client: AdminTariffClient) {
  return render(
    <ToastProvider>
      <TariffsPanel client={client} />
    </ToastProvider>
  );
}

const table = () => screen.getByRole('table', { name: 'Plans' });
const rowOf = (email: string) =>
  within(table())
    .getAllByRole('row')
    .find(row => row.textContent?.includes(email))!;

beforeEach(() => {
  localStorage.setItem('language', 'en');
  ai.peopleCredits.mockReset().mockResolvedValue(
    new Map([
      [
        'alpha@test.invalid',
        {
          email: 'alpha@test.invalid',
          grant: 50,
          daily: 10,
          bonus: 5,
          available: 40,
          personalGrant: null
        }
      ]
    ])
  );
  ai.spaces.mockReset().mockResolvedValue([
    { teamId: 'team-alpha', name: 'Alpha', pilot: false },
    // A staff space on no tariff, with the assistant on.
    { teamId: 'team-staff', name: 'Staff space', pilot: true }
  ]);
  ai.grantBonus.mockReset().mockResolvedValue(undefined);
  ai.setSpace.mockReset();
});
afterEach(() => localStorage.clear());

describe('the tariffs ledger', () => {
  it('lists every space with what needs attention first, and finds one by owner or space', async () => {
    const user = userEvent.setup();
    renderPanel(fakeClient());
    await screen.findByRole('table', { name: 'Plans' });
    expect(
      screen.getByText('Ending within 7 days: 0 · After the term: 1 · Requests: 1')
    ).toBeTruthy();
    // Neither contact is set, so a person told to write has nowhere to write.
    expect(screen.getByText(/^No contact is set/u)).toBeTruthy();

    const order = within(table())
      .getAllByRole('row')
      .slice(1)
      .map(row => row.textContent ?? '');
    expect(order.map(text => text.match(/^[a-z]+@/u)?.[0])).toEqual([
      'beta@',
      'alpha@',
      'waiting@',
      'paused@'
    ]);
    expect(rowOf('alpha@test.invalid').textContent).toContain('2 of 3');
    expect(rowOf('alpha@test.invalid').textContent).toContain('paid by card');
    expect(rowOf('alpha@test.invalid').textContent).toContain('Team');
    expect(rowOf('alpha@test.invalid').textContent).toContain('30 d');
    expect(rowOf('beta@test.invalid').textContent).toContain('works until');
    // No space yet: the plan's size, not a count of nobody.
    expect(rowOf('waiting@test.invalid').textContent).toContain('tomorrow');
    expect(rowOf('waiting@test.invalid').textContent).not.toContain(' of ');
    expect(rowOf('paused@test.invalid').textContent).toContain('Old rule');

    const search = screen.getByRole('searchbox', { name: 'Email or space name' });
    await user.type(search, 'beta');
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));
    expect(rowOf('beta@test.invalid')).toBeTruthy();
    await user.clear(search);
    await user.type(search, 'nobody-here');
    expect(await screen.findByText('Nothing matches the search.')).toBeTruthy();
    await user.clear(search);

    await user.click(screen.getByRole('radio', { name: /Paused/u }));
    await waitFor(() => expect(within(table()).getAllByRole('row')).toHaveLength(2));
    expect(rowOf('paused@test.invalid')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /≤3 d/u }));
    expect(await screen.findByText('No plans here.')).toBeTruthy();
  });

  it('extends by a month in one press and undoes it from the toast', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      extend: vi.fn(async () => ({ ...alpha, endsOn: '2031-01-31', eventId: 'event-1' })),
      undo: vi.fn().mockResolvedValueOnce(alpha).mockRejectedValueOnce(new Error('UNDO_TOO_LATE'))
    });
    renderPanel(client);
    await screen.findByRole('table', { name: 'Plans' });
    await user.click(within(rowOf('alpha@test.invalid')).getByRole('button', { name: /^\+1 mo/u }));
    expect(client.extend).toHaveBeenCalledWith('tariff-alpha', 1, false, alpha.updatedAt);
    const toast = await screen.findByText(/alpha@test\.invalid: renewed until/u);
    await user.click(within(toast.closest('.ui-toast')!).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.undo).toHaveBeenCalledWith('event-1'));
    expect(await screen.findByText('Undone')).toBeTruthy();
    // Every change reads the ledger again: load, extend, undo.
    await waitFor(() => expect(client.listTariffs).toHaveBeenCalledTimes(3));

    // An undo that comes too late says so instead of pretending.
    await user.click(within(rowOf('alpha@test.invalid')).getByRole('button', { name: /^\+1 mo/u }));
    const second = await waitFor(() => {
      const toasts = screen.getAllByText(/alpha@test\.invalid: renewed until/u);
      return toasts.at(-1)!;
    });
    await user.click(within(second.closest('.ui-toast')!).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(client.undo).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('says why an extension failed and leaves the row as it was', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ extend: vi.fn(async () => Promise.reject(new Error('STALE'))) });
    renderPanel(client);
    await screen.findByRole('table', { name: 'Plans' });
    await user.click(within(rowOf('alpha@test.invalid')).getByRole('button', { name: /^\+1 mo/u }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(client.listTariffs).toHaveBeenCalledTimes(1);
    expect(
      within(rowOf('alpha@test.invalid')).getByRole('button', { name: /^\+1 mo/u })
    ).toBeTruthy();
  });

  it("shows each owner's credits and gives bonus credits right there", async () => {
    const user = userEvent.setup();
    renderPanel(fakeClient());
    await screen.findByRole('table', { name: 'Plans' });
    await waitFor(() => expect(rowOf('alpha@test.invalid').textContent).toContain('40 · +5'));
    // An owner the credits read did not return shows a dash, never zero.
    expect(
      within(rowOf('beta@test.invalid')).queryByRole('button', { name: /Give credits/u })
    ).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Give credits to alpha@test.invalid' }));
    const amount = await screen.findByRole('textbox', { name: 'Bonus credits' });
    const give = screen.getByRole('button', { name: 'Give' });
    expect(give.hasAttribute('disabled')).toBe(true);
    // The field commits its number when it is left, as a person tabs on to Give.
    await user.type(amount, '25');
    await user.tab();
    await waitFor(() => expect(give.hasAttribute('disabled')).toBe(false));
    // What it costs in money, before it is given.
    expect(screen.getByText(/^≈ \$/u)).toBeTruthy();
    await user.click(give);
    await waitFor(() => expect(ai.grantBonus).toHaveBeenCalledWith('alpha@test.invalid', 25, null));
    expect(await screen.findByText('25 credits given · alpha@test.invalid')).toBeTruthy();
    await waitFor(() => expect(ai.peopleCredits).toHaveBeenCalledTimes(2));

    ai.grantBonus.mockRejectedValueOnce(new Error('INSUFFICIENT_PRIVILEGE'));
    await user.click(screen.getByRole('button', { name: 'Give credits to alpha@test.invalid' }));
    await user.type(await screen.findByRole('textbox', { name: 'Bonus credits' }), '3');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Give' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('switches the assistant per space, including a space on no tariff', async () => {
    const user = userEvent.setup();
    ai.setSpace
      .mockResolvedValueOnce([
        { teamId: 'team-alpha', name: 'Alpha', pilot: true },
        { teamId: 'team-staff', name: 'Staff space', pilot: true }
      ])
      .mockRejectedValueOnce(new Error('INSUFFICIENT_PRIVILEGE'));
    renderPanel(fakeClient());
    await screen.findByRole('table', { name: 'Plans' });
    const alphaSwitch = await screen.findByRole('switch', { name: 'Assistant in Alpha' });
    expect((alphaSwitch as HTMLInputElement).checked).toBe(false);
    // A grant with no space yet has nothing to switch.
    expect(within(rowOf('waiting@test.invalid')).queryByRole('switch')).toBeNull();
    expect(screen.getByText('The assistant is also on outside tariffs:')).toBeTruthy();

    await user.click(alphaSwitch);
    await waitFor(() => expect(ai.setSpace).toHaveBeenCalledWith('team-alpha', true));
    await waitFor(() =>
      expect(
        (screen.getByRole('switch', { name: 'Assistant in Alpha' }) as HTMLInputElement).checked
      ).toBe(true)
    );

    await user.click(screen.getByRole('switch', { name: 'Staff space' }));
    await waitFor(() => expect(ai.setSpace).toHaveBeenCalledWith('team-staff', false));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('keeps the tariffs usable when the credits cannot be read', async () => {
    ai.peopleCredits.mockRejectedValue(new Error('offline'));
    renderPanel(fakeClient());
    await screen.findByRole('table', { name: 'Plans' });
    await waitFor(() => expect(ai.peopleCredits).toHaveBeenCalled());
    // Unread, the switch is a dash — never «off» for a space that may be on.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(rowOf('alpha@test.invalid').textContent).toContain('—');
  });

  it('handles a request from its own view, searched like the rest', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderPanel(client);
    await screen.findByRole('table', { name: 'Plans' });
    await user.click(screen.getByRole('radio', { name: /Requests/u }));
    const requests = await screen.findByRole('table', { name: 'Requests' });
    expect(requests.textContent).toContain('asks@test.invalid');
    await user.click(within(requests).getByRole('button', { name: 'Handled' }));
    await waitFor(() => expect(client.markRequest).toHaveBeenCalledWith('user-request', true));
    await waitFor(() => expect(client.listTariffs).toHaveBeenCalledTimes(2));

    await user.type(screen.getByRole('searchbox', { name: 'Email or space name' }), 'someone-else');
    expect(await screen.findByText('No requests.')).toBeTruthy();
  });

  it('offers the actions a row allows: a waiting grant is cancelled, not revoked', async () => {
    const user = userEvent.setup();
    renderPanel(fakeClient());
    await screen.findByRole('table', { name: 'Plans' });
    await user.click(screen.getByRole('button', { name: 'Actions for alpha@test.invalid' }));
    let menu = await screen.findByRole('menu', { name: 'Actions for alpha@test.invalid' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Change', 'History and seats', 'Revoke']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Revoke' }));
    expect(
      await screen.findByRole('dialog', { name: 'Revoke the plan of alpha@test.invalid' })
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Actions for waiting@test.invalid' }));
    menu = await screen.findByRole('menu', { name: 'Actions for waiting@test.invalid' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Change', 'History', 'Cancel the grant']);
  });

  it('says the ledger could not be loaded and loads it again', async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      listTariffs: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([alpha])
    });
    renderPanel(client);
    expect(
      await screen.findByText('The admin data could not be loaded or access was denied.')
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Repeat' }));
    expect(await screen.findByRole('table', { name: 'Plans' })).toBeTruthy();
    expect(rowOf('alpha@test.invalid')).toBeTruthy();
  });
});
