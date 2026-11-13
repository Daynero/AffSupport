// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchEditor } from '../apps/web/src/team/launches/LaunchEditor';
import type { LaunchDraft } from '../packages/shared/src/team/launches';
import { newLaunchDraft } from '../apps/web/src/team/launches/launchDraftDefaults';
vi.mock('../apps/web/src/team/launches/LaunchCreativePicker', () => ({
  LaunchCreativePicker: () => null
}));
afterEach(cleanup);
it('keeps the maximum focused through empty and reversed bounds while typing 250', () => {
  function Editor() {
    const [config, setConfig] = useState({
      ...newLaunchDraft(),
      campaignCount: 5,
      minBudget: 140,
      maxBudget: 250
    });
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onRefreshSources={() => {}}
        onChange={patch => setConfig(previous => ({ ...previous, ...patch }))}
      />
    );
  }
  render(<Editor />);
  const maximum = screen.getByRole('spinbutton', { name: 'Maximum' });
  fireEvent.focus(maximum);
  maximum.focus();
  for (const value of ['', '2', '25', '250']) {
    fireEvent.change(maximum, { target: { value } });
    expect(screen.getByRole('spinbutton', { name: 'Maximum' })).toBe(maximum);
    expect(document.activeElement).toBe(maximum);
    expect(maximum.getAttribute('aria-invalid')).not.toBe('true');
  }
  fireEvent.blur(maximum);
  expect(maximum.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.focus(maximum);
  fireEvent.change(maximum, { target: { value: '2' } });
  fireEvent.blur(maximum);
  expect(maximum.getAttribute('aria-invalid')).toBe('true');
});

it('keeps a single amount while changing campaign count, clears hidden bounds and restores manual edits across modes', () => {
  let current: LaunchDraft;
  function Editor() {
    const [config, setConfig] = useState<LaunchDraft>({
      ...newLaunchDraft(),
      campaignCount: 3,
      budgetMode: 'manual',
      budgets: [10, 25, 30],
      minBudget: 10,
      maxBudget: 30
    });
    current = config;
    return (
      <LaunchEditor
        teamId="team"
        config={config}
        sources={null}
        accounts={[]}
        offers={[]}
        buyers={[]}
        disabled={false}
        onRefreshSources={() => {}}
        onChange={patch => setConfig(previous => ({ ...previous, ...patch }))}
      />
    );
  }
  render(<Editor />);
  fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
  expect(current!).toMatchObject({
    budgetMode: 'single',
    maxBudget: 30,
    budgets: null,
    minBudget: undefined
  });
  expect(screen.queryByRole('spinbutton', { name: 'Minimum' })).toBeNull();
  const amount = screen.getByRole('spinbutton', { name: 'Per campaign' });
  fireEvent.change(amount, { target: { value: '1' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '100' }
  });
  expect(current!).toMatchObject({ campaignCount: 100, maxBudget: 1, minBudget: undefined });
  expect(amount.getAttribute('aria-invalid')).not.toBe('true');
  fireEvent.focus(amount);
  fireEvent.change(amount, { target: { value: '' } });
  fireEvent.blur(amount);
  expect(amount.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('alert').textContent).toContain('whole dollar amount');
  fireEvent.change(amount, { target: { value: '30' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Campaign count' }), {
    target: { value: '3' }
  });
  fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
  expect(current!).toMatchObject({ budgets: [10, 25, 30], minBudget: 10, maxBudget: 30 });
  fireEvent.click(screen.getByRole('radio', { name: 'Single' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Automatic' }));
  expect(current!).toMatchObject({ budgetMode: 'auto', budgets: null, minBudget: undefined });
  expect(screen.getByRole('spinbutton', { name: 'Minimum' }).getAttribute('value')).toBe('10');
});
