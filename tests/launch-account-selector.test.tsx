// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamAccountSummary } from '@video-compressor/shared';
import { analytics } from '../apps/web/src/analytics/service';
import { LaunchAccountSelector } from '../apps/web/src/team/launches/LaunchAccountSelector';
import { launchFixtureAccounts } from './fixtures/launches';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const rows = () => {
  const accounts = launchFixtureAccounts();
  accounts[0].name = 'Main social';
  accounts[0].agents.push({ ...accounts[0].agents[0], id: 'second', agentId: '9999999892' });
  return accounts;
};
function setup(accounts: TeamAccountSummary[] = rows(), initial = '') {
  const changed = vi.fn();
  function Host() {
    const [value, setValue] = useState(initial);
    return (
      <LaunchAccountSelector
        id="account"
        value={value}
        accounts={accounts}
        disabled={false}
        onChange={next => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Host />);
  return {
    ...view,
    changed,
    user: userEvent.setup(),
    trigger: screen.getByRole('button', { name: /^Choose account/ })
  };
}
it('opens one existing-account browser, searches and replaces the trigger selection', async () => {
  const { user, trigger, changed } = setup();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  await user.click(trigger);
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), 'main 9999');
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /ID 9999999892/ }));
  expect(changed).toHaveBeenCalledWith('second');
  expect(trigger.textContent).toContain('Main social · 892');
  expect(within(trigger).getByText('ID 9999999892')).toBeTruthy();
  expect(within(trigger).getByText('Free')).toBeTruthy();
  expect(screen.getAllByRole('button')).toEqual([trigger]);
});
it('distinguishes duplicate suffixes and preserves workspace order in the browser', async () => {
  const { user, trigger } = setup();
  await user.click(trigger);
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), '892');
  expect(
    within(screen.getByRole('dialog'))
      .getAllByRole('button', { name: /ID / })
      .map(row => row.textContent)
  ).toEqual([
    'Main social · 892ID 1234567892Free',
    'Main social · 892ID 9999999892Free',
    'g2 · 892ID 9876543892Free'
  ]);
});
it('selects by keyboard and preserves selection when an unmatched search is dismissed', async () => {
  const { user, trigger, changed } = setup();
  trigger.focus();
  await user.keyboard('{Enter}');
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), '9876543');
  const account = screen.getByRole('button', { name: /ID 9876543892/ });
  account.focus();
  await user.keyboard('{Enter}');
  expect(changed).toHaveBeenCalledWith(launchFixtureAccounts()[1].agents[0].id);
  expect(trigger.textContent).toContain('g2 · 892');
  expect(document.activeElement).toBe(trigger);
  await user.click(trigger);
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), 'missing');
  expect(
    screen.getByText('No matching ad accounts. Try a social name or another part of the ID.')
  ).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(trigger.textContent).toContain('g2 · 892');
  expect(changed).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
});
it('hides archived socials and accounts and never accepts free-form search text', async () => {
  const accounts = rows();
  accounts[0].archivedAt = '2026-10-23';
  accounts[1].agents[0].archivedAt = '2026-10-23';
  const { user, trigger, changed } = setup(accounts);
  await user.click(trigger);
  await user.type(
    screen.getByRole('textbox', { name: 'Social name or account ID' }),
    'new account'
  );
  expect(
    screen.getByText('No matching ad accounts. Try a social name or another part of the ID.')
  ).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(changed).not.toHaveBeenCalled();
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: /ID / })).toBeNull();
});
it('does not replace an unavailable selection or open a locked control', async () => {
  const changed = vi.fn();
  render(
    <LaunchAccountSelector
      id="account"
      value="missing"
      accounts={rows()}
      disabled
      onChange={changed}
    />
  );
  expect(
    screen.getByText('The selected ad account is no longer available. Choose another.')
  ).toBeTruthy();
  const trigger = screen.getByRole('button', { name: 'Choose account' });
  expect(trigger).toHaveProperty('disabled', true);
  await userEvent.setup().click(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
it('browses socials with occupancy counts, filters running RK and selects the real row', async () => {
  const track = vi.spyOn(analytics, 'track');
  const accounts = rows();
  accounts[0].agents[1].runs = [
    {
      id: 'run',
      note: 'TR ProCaps',
      marker: 'amber',
      createdAt: '2026-10-25'
    }
  ];
  const { user, changed } = setup(accounts);
  await user.click(screen.getByRole('button', { name: 'Choose account' }));
  const dialog = screen.getByRole('dialog');
  const ui = within(dialog);
  expect(ui.getByRole('button', { name: /Free · 2/ })).toBeTruthy();
  await user.click(ui.getByRole('button', { name: /^Running · 1$/ }));
  expect(ui.queryByRole('button', { name: /g2/ })).toBeNull();
  await user.click(ui.getByRole('button', { name: /Main social/ }));
  expect(ui.getByText('TR ProCaps')).toBeTruthy();
  await user.click(ui.getByRole('button', { name: /ID 9999999892/ }));
  expect(changed).toHaveBeenCalledWith('second');
  expect(track).toHaveBeenCalledWith(
    'operation_completed',
    expect.objectContaining({ flow_step: 'launch_account_picker', attempt_id: expect.any(String) })
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    within(screen.getByRole('button', { name: /Choose account:/ })).getByText('Running')
  ).toBeTruthy();
});
it('searches inside the browser without changing selection and cancels safely', async () => {
  const track = vi.spyOn(analytics, 'track');
  const { user, changed } = setup();
  await user.click(screen.getByRole('button', { name: 'Choose account' }));
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), 'main 9999');
  expect(screen.getByRole('button', { name: /ID 9999999892/ })).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(track).toHaveBeenCalledWith(
    'operation_cancelled',
    expect.objectContaining({ flow_step: 'launch_account_picker' })
  );
  expect(track).not.toHaveBeenCalledWith('operation_completed', expect.anything());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
