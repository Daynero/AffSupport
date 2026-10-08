// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FinanceAccountGroup } from '../apps/web/src/team/accounts/finance/FinanceAccountGroup';
import { teamAccountHue } from '../apps/web/src/team/accounts/AccountGroup';

afterEach(cleanup);
it('uses the operational account shell and keeps financial drafts mounted when folded', () => {
  render(
    <FinanceAccountGroup id="account-x" name="X" count={2} agents={[]}>
      <input aria-label="Draft" defaultValue="125.50" />
    </FinanceAccountGroup>
  );
  const group = screen.getByRole('region', { name: 'X' });
  expect(group.className).toBe('team-account');
  expect(group.style.getPropertyValue('--team-account-hue')).toBe(
    String(teamAccountHue('account-x'))
  );
  expect(group.querySelector('.team-account-head .team-account-mark')).toBeTruthy();
  expect(group.querySelector('.team-account-meta')?.textContent).toBe('2 ad accounts');
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse X' }));
  expect(group.querySelector('.hidden input')).toBe(draft);
  fireEvent.click(screen.getByRole('button', { name: 'Expand X' }));
  expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
});
