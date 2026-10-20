// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS } from '@video-compressor/shared';
import { MemberPermissionsDialog } from '../apps/web/src/team/members/MemberPermissionsDialog';
import { TeamApiError, type TeamMemberSummary } from '../apps/web/src/api/team';

const member: TeamMemberSummary = {
  membershipId: '31000000-0000-4000-8000-000000000002',
  userId: '11000000-0000-4000-8000-000000000002',
  displayName: 'Beta Member',
  email: 'member@example.test',
  role: 'viewer',
  baseRole: 'viewer',
  permissionOverrides: {},
  effectivePermissions: ROLE_PERMISSIONS.viewer,
  joinedAt: '2026-08-01T11:00:00.000Z'
};
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const checked = (name: string) =>
  (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;
async function chooseRole(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: /Role/ }));
  await user.click(await screen.findByRole('option', { name }));
}

it('preserves current manual overrides across role changes and explicitly restores the selected role', async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(undefined);
  render(<MemberPermissionsDialog member={member} onClose={vi.fn()} onSave={save} />);
  expect(
    (screen.getByRole('button', { name: 'Save permissions' }) as HTMLButtonElement).disabled
  ).toBe(true);
  await user.click(screen.getByText('Run processing'));
  await chooseRole(user, 'Editor');
  await chooseRole(user, 'Viewer');
  expect(checked('Run processing')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Restore role permissions' }));
  expect(checked('Run processing')).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Save permissions' }) as HTMLButtonElement).disabled
  ).toBe(true);
  await user.click(screen.getByText('Download to computer'));
  await user.click(screen.getByRole('button', { name: 'Save permissions' }));
  expect(save).toHaveBeenCalledWith({
    baseRole: 'viewer',
    permissionOverrides: { download: false }
  });
}, 15000);

it('protects dirty drafts on Escape and only discards after explicit confirmation', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const save = vi.fn();
  render(<MemberPermissionsDialog member={member} onClose={close} onSave={save} />);
  await user.click(screen.getByText('Run processing'));
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'Discard permission changes?' })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep editing' }))
  );
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(checked('Run processing')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it('shows permission help by click and Escape dismisses only that layer', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<MemberPermissionsDialog member={member} onClose={close} onSave={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'About: Manage members' }));
  const help = await screen.findByRole('dialog', { name: 'About: Manage members' });
  expect(within(help).getByText(/including granting member management/)).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'About: Manage members' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Member permissions' })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});

it('blocks duplicate submission, edits and close while saving, and preserves a refused draft', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  let reject!: (error: unknown) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      })
  );
  render(<MemberPermissionsDialog member={member} onClose={close} onSave={save} />);
  await user.click(screen.getByText('Run processing'));
  await user.click(screen.getByRole('button', { name: 'Save permissions' }));
  const form = screen.getByRole('dialog', { name: 'Member permissions' }).querySelector('form')!;
  fireEvent.submit(form);
  expect(save).toHaveBeenCalledOnce();
  expect(
    (screen.getByRole('checkbox', { name: 'Run processing' }) as HTMLInputElement).disabled
  ).toBe(true);
  await user.keyboard('{Escape}');
  expect(close).not.toHaveBeenCalled();
  reject(new TeamApiError('PERMISSION_DENIED', false));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(checked('Run processing')).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Save permissions' }) as HTMLButtonElement).disabled
  ).toBe(false);
});
