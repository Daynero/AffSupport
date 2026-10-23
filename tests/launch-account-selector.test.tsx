// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { TeamAccountSummary } from '@video-compressor/shared';
import { LaunchAccountSelector } from '../apps/web/src/team/launches/LaunchAccountSelector';
import { launchFixtureAccounts } from './fixtures/launches';
afterEach(cleanup);
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
    input: screen.getByRole('combobox', { name: 'Ad account' })
  };
}
it('searches by full ID and mixed social/ID terms without saving search text', async () => {
  const { user, input, changed } = setup();
  expect(input).toHaveProperty('placeholder', 'Social name or account ID');
  await user.type(input, 'main 9999');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole('option', { name: 'Main social · 892, ID 9999999892' }));
  expect(changed).toHaveBeenCalledWith('second');
  expect(input).toHaveProperty('value', 'Main social · 892');
  expect(screen.getByText('ID 9999999892')).toBeTruthy();
});
it('distinguishes duplicate suffixes within the same social and preserves workspace order', async () => {
  const { user } = setup();
  await user.click(screen.getByRole('button', { name: 'Ad account' }));
  const options = screen.getAllByRole('option');
  expect(options.map(row => row.getAttribute('aria-label'))).toEqual([
    'Main social · 892, ID 1234567892',
    'Main social · 892, ID 9999999892',
    'g2 · 892, ID 9876543892'
  ]);
});
it('selects an actual result by keyboard and restores the selected value after abandoning a search', async () => {
  const { user, input, changed } = setup();
  await user.type(input, '9876543');
  await user.keyboard('{ArrowDown}{Enter}');
  expect(changed).toHaveBeenCalledWith(launchFixtureAccounts()[1].agents[0].id);
  expect(input).toHaveProperty('value', 'g2 · 892');
  await user.clear(input);
  await user.type(input, 'missing');
  expect(
    screen.getByText('No matching ad accounts. Try a social name or another part of the ID.')
  ).toBeTruthy();
  await user.tab();
  expect(input).toHaveProperty('value', 'g2 · 892');
  expect(changed).toHaveBeenCalledOnce();
});
it('shows an honest empty state and hides archived socials and accounts', async () => {
  const accounts = rows();
  accounts[0].archivedAt = '2026-10-23';
  accounts[1].agents[0].archivedAt = '2026-10-23';
  const { user, changed } = setup(accounts);
  await user.click(screen.getByRole('button', { name: 'Ad account' }));
  expect(screen.getByText('No ad accounts available in this workspace.')).toBeTruthy();
  // React Aria wraps its empty-state announcement in a non-selectable option.
  expect(screen.getAllByRole('option').every(row => !row.hasAttribute('data-key'))).toBe(true);
  await user.keyboard('{ArrowDown}{Enter}');
  expect(changed).not.toHaveBeenCalled();
});
it('does not silently replace a revoked selection or permit selection through a locked control', async () => {
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
  expect(screen.getByRole('combobox', { name: 'Ad account' })).toHaveProperty('disabled', true);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Ad account' }));
  expect(screen.queryByRole('option')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
