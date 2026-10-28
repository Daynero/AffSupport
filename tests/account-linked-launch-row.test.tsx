// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AccountLinkedLaunchRow } from '../apps/web/src/team/accounts/AccountLinkedLaunchRow';
import { ToastProvider } from '../apps/web/src/components/toast';
import { launchAssignmentsApi } from '../apps/web/src/api/team-launch-assignments';
import type { TeamAccountLaunchAssignment } from '@video-compressor/shared';
vi.mock('../apps/web/src/api/team-launch-assignments', () => ({
  launchAssignmentsApi: { set: vi.fn(), readMutation: vi.fn().mockResolvedValue(null) },
  isDefinitiveAssignmentError: () => false
}));
vi.mock('../apps/web/src/team/launches/analytics', () => ({
  launchMutation: (_c: unknown, _a: unknown, run: () => Promise<unknown>) => run()
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const launch: TeamAccountLaunchAssignment = {
  id: 'launch',
  agentRowId: 'rk',
  accountId: 'soc',
  revisionId: 'revision',
  launchDate: '2026-10-26',
  workStatus: 'todo',
  hasResult: true,
  creativeAlias: 'TR_12',
  method: 'other',
  unmatchedReason: null,
  assignmentState: 'assigned',
  assignmentVersion: '4'
};
function mount(row = launch, canEdit = true) {
  const changed = vi.fn().mockResolvedValue(undefined);
  render(
    <ToastProvider>
      <AccountLinkedLaunchRow teamId="team" launch={row} canEdit={canEdit} onChanged={changed} />
    </ToastProvider>
  );
  return changed;
}
it('shares manual row geometry and keeps the linked Launch colour and edit action', () => {
  mount();
  const link = screen.getByRole('link', { name: 'TR_12 · 2026-10-26' });
  expect(link.classList.contains('account-linked-launch')).toBe(true);
  expect(link.closest('.team-agent-run')).toBeTruthy();
  expect(link.closest('.team-agent-run')?.querySelector('.team-agent-run-age')).toBeNull();
  expect(screen.getByRole('button', { name: 'Edit launch: TR_12 · 2026-10-26' })).toBeTruthy();
});
it('detaches only the assignment, then Undo creates a fresh CAS-protected assignment intent', async () => {
  const receipt = {
    launchId: 'launch',
    version: '5',
    state: 'released' as const,
    agentRowId: null,
    sourceAgentRowId: 'rk',
    operationId: 'op',
    requestKey: 'key'
  };
  vi.mocked(launchAssignmentsApi.set)
    .mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce({ ...receipt, version: '6', state: 'assigned', agentRowId: 'rk' });
  const changed = mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Detach from ad account: TR_12 · 2026-10-26' })
  );
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(launchAssignmentsApi.set).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ launchId: 'launch', agentRowId: null, expectedVersion: '4' })
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(launchAssignmentsApi.set).toHaveBeenCalledTimes(2));
  const [first, second] = vi.mocked(launchAssignmentsApi.set).mock.calls.map(args => args[0]);
  expect(second).toMatchObject({ agentRowId: 'rk', expectedVersion: '5' });
  expect(second.requestKey).not.toBe(first.requestKey);
});
it('keeps an uncertain request key and version for readback/retry rather than making another mutation', async () => {
  vi.mocked(launchAssignmentsApi.set).mockRejectedValue(new Error('lost reply'));
  mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'Detach from ad account: TR_12 · 2026-10-26' })
  );
  const retry = await screen.findByRole('button', {
    name: 'Check saved assignment: TR_12 · 2026-10-26'
  });
  fireEvent.click(retry);
  const repeat = await screen.findByRole('button', { name: 'Repeat: TR_12 · 2026-10-26' });
  expect(launchAssignmentsApi.readMutation).toHaveBeenCalledTimes(1);
  expect(launchAssignmentsApi.set).toHaveBeenCalledTimes(1);
  fireEvent.click(repeat);
  await waitFor(() => expect(launchAssignmentsApi.set).toHaveBeenCalledTimes(2));
  expect(vi.mocked(launchAssignmentsApi.set).mock.calls[1][0]).toEqual(
    vi.mocked(launchAssignmentsApi.set).mock.calls[0][0]
  );
});
it('lets an editor confirm legacy links as current or history without deleting the Launch', () => {
  mount({ ...launch, assignmentState: 'legacy_unknown' });
  expect(
    screen.getByRole('button', { name: 'Assign ad account: TR_12 · 2026-10-26' })
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Keep as history only: TR_12 · 2026-10-26' })
  ).toBeTruthy();
});
it('keeps navigation but offers no mutation controls to a reader', () => {
  mount(launch, false);
  expect(screen.getByRole('link')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
