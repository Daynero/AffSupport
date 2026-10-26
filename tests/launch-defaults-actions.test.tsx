// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LaunchDefaultsActions,
  type LaunchDefaultsActionsProps
} from '../apps/web/src/team/launches/LaunchDefaultsActions';
afterEach(cleanup);
function setup(overrides: Partial<LaunchDefaultsActionsProps> = {}) {
  const props: LaunchDefaultsActionsProps = {
    manage: true,
    hasOffer: true,
    offerName: 'Offer A',
    loading: false,
    loadError: false,
    buyerMissing: false,
    disabled: false,
    saveDisabled: { offer: false, workspace: false },
    onSave: vi.fn(),
    onApply: vi.fn(),
    onKeep: vi.fn(),
    onRetry: vi.fn(),
    ...overrides
  };
  return { ...render(<LaunchDefaultsActions {...props} />), props, user: userEvent.setup() };
}
it('keeps the two save scopes explicit and never shows a builtin reset decision', async () => {
  const { user, props } = setup({ proposalSource: 'builtin' });
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  expect(screen.getByText('Offer: Offer A')).toBeTruthy();
  expect(screen.getByText('For offers without their own settings')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save for offer' }));
  await user.click(screen.getByRole('button', { name: 'Save as general defaults' }));
  expect(props.onSave).toHaveBeenNthCalledWith(1, 'offer');
  expect(props.onSave).toHaveBeenNthCalledWith(2, 'workspace');
});
it('opens profile help by keyboard and restores focus after Escape', async () => {
  const { user } = setup();
  const trigger = screen.getByRole('button', { name: 'What is saved?' });
  expect(screen.queryByText(/Saves all launch/)).toBeNull();
  await user.tab();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard('{Enter}');
  expect(screen.getByText(/Saves all launch/)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByText(/Saves all launch/)).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('separates applying a saved profile from saving current values', async () => {
  const { user, props } = setup({ proposalSource: 'offer' });
  expect(screen.getByRole('dialog', { name: 'Apply saved settings?' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'No' }));
  expect(props.onKeep).toHaveBeenCalledOnce();
  expect(props.onApply).not.toHaveBeenCalled();
  expect(props.onSave).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Yes, apply' }));
  expect(props.onApply).toHaveBeenCalledOnce();
});
it('explains missing offer and exposes a failed load retry without a stale apply action', async () => {
  const { user, props } = setup({
    hasOffer: false,
    offerName: undefined,
    loadError: true,
    proposalSource: 'offer',
    saveDisabled: { offer: true, workspace: false }
  });
  expect(screen.getByText('Select an offer first')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save for offer' })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Retry loading settings' }));
  expect(props.onRetry).toHaveBeenCalledOnce();
});
it('blocks both scopes during a pending save and hides save actions from non-managers', async () => {
  const { user, props, rerender } = setup({
    savingScope: 'offer',
    saveDisabled: { offer: true, workspace: true }
  });
  await user.click(screen.getByRole('button', { name: 'Save as general defaults' }));
  expect(props.onSave).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save for offer' }).getAttribute('aria-busy')).toBe(
    'true'
  );
  rerender(<LaunchDefaultsActions {...props} manage={false} proposalSource="workspace" />);
  expect(screen.queryByRole('button', { name: 'Save for offer' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Yes, apply' })).toBeTruthy();
});
