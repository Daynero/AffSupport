// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchAssignmentControls } from '../apps/web/src/team/launches/LaunchAssignmentControls';
import { launchAssignmentsApi } from '../apps/web/src/api/team-launch-assignments';
import { TeamApiError } from '../apps/web/src/api/team';
import { analytics } from '../apps/web/src/analytics/service';
import { launchFixtureAccounts } from './fixtures/launches';
vi.mock('../apps/web/src/api/team-launch-assignments', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../apps/web/src/api/team-launch-assignments')>();
  return {
    ...actual,
    launchAssignmentsApi: { read: vi.fn(), set: vi.fn(), readMutation: vi.fn() }
  };
});
const rows = launchFixtureAccounts();
const first = rows[0].agents[0].id;
const second = rows[1].agents[0].id;
const initial = {
  launchId: 'launch',
  version: '0',
  state: 'unassigned' as const,
  agentRowId: null,
  sourceAgentRowId: first
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
beforeEach(() => {
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue(initial);
});
function setup(editable = true) {
  const confirmed = vi.fn().mockResolvedValue(undefined);
  const props = {
    teamId: 'team',
    launchId: 'launch',
    sourceAgentRowId: first,
    accounts: rows,
    editable,
    hasResults: true,
    onConfirmed: confirmed
  };
  const view = render(<LaunchAssignmentControls {...props} />);
  return { ...view, props, confirmed, user: userEvent.setup() };
}
it('does not reserve on mount, picker selection, or a changed saved source; only explicit assign writes', async () => {
  const { user, rerender, props } = setup();
  await screen.findByText('No current assignment');
  expect(launchAssignmentsApi.set).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /^Choose account/ }));
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), '9876543');
  await user.click(screen.getByRole('button', { name: /ID 9876543892/ }));
  expect(launchAssignmentsApi.set).not.toHaveBeenCalled();
  rerender(<LaunchAssignmentControls {...props} sourceAgentRowId={second} />);
  expect(launchAssignmentsApi.set).not.toHaveBeenCalled();
  vi.mocked(launchAssignmentsApi.set).mockImplementation(async request => ({
    ...initial,
    state: 'assigned',
    version: '1',
    agentRowId: request.agentRowId,
    operationId: 'op',
    requestKey: request.requestKey
  }));
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'assigned',
    version: '1',
    agentRowId: second
  });
  await user.click(screen.getByRole('button', { name: 'Assign ad account' }));
  expect(launchAssignmentsApi.set).toHaveBeenCalledWith(
    expect.objectContaining({
      agentRowId: second,
      expectedVersion: '0',
      requestKey: expect.any(String)
    })
  );
  await screen.findByText('Assigned to g2 · 892');
  expect(
    screen.getByText(
      'Existing results keep their original ad account. Generate new results for another account.'
    )
  ).toBeTruthy();
});
it('detaches operational assignment without relinking from preserved source, and proves committed visibility', async () => {
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'assigned',
    agentRowId: first
  });
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  vi.mocked(launchAssignmentsApi.set).mockImplementation(async request => ({
    ...initial,
    state: 'released',
    version: '1',
    agentRowId: null,
    operationId: 'op',
    requestKey: request.requestKey
  }));
  const { user, props, rerender, confirmed } = setup();
  await screen.findByText('Assigned to g1 · 892');
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'released',
    version: '1',
    agentRowId: null
  });
  await user.click(screen.getByRole('button', { name: 'Detach from ad account' }));
  await screen.findByText('No current assignment');
  rerender(<LaunchAssignmentControls {...props} />);
  expect(launchAssignmentsApi.set).toHaveBeenCalledTimes(1);
  expect(launchAssignmentsApi.set).toHaveBeenCalledWith(
    expect.objectContaining({ agentRowId: null })
  );
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenCalledWith(
    'team_launch_visible',
    expect.objectContaining({ launch_action: 'release_account', workflow_id: 'launch' })
  );
});
it('retains the uncertain exact key, checks before retry, and does not accept a missing receipt as success', async () => {
  vi.mocked(launchAssignmentsApi.set).mockRejectedValue(
    new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true)
  );
  vi.mocked(launchAssignmentsApi.readMutation).mockResolvedValue(null);
  const { user, props, rerender } = setup();
  await screen.findByText('No current assignment');
  await user.click(screen.getByRole('button', { name: 'Assign ad account' }));
  await screen.findByText('The result is unconfirmed. Check the saved assignment before retrying.');
  const intent = vi.mocked(launchAssignmentsApi.set).mock.calls[0][0];
  rerender(<LaunchAssignmentControls {...props} sourceAgentRowId={second} />);
  await user.click(screen.getByRole('button', { name: 'Check saved assignment' }));
  expect(launchAssignmentsApi.readMutation).toHaveBeenCalledWith('team', intent.requestKey);
  const alert = screen.getByRole('alert');
  await user.click(within(alert).getByRole('button', { name: 'Repeat' }));
  expect(vi.mocked(launchAssignmentsApi.set).mock.calls[1][0]).toEqual(intent);
});
it('a read error is explicit and losing edit permission prevents assignment writes', async () => {
  vi.mocked(launchAssignmentsApi.read).mockRejectedValue(new Error('offline'));
  const { user, rerender, props } = setup();
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Assign ad account' })).toBeNull();
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue(initial);
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Repeat' }));
  await screen.findByRole('button', { name: 'Assign ad account' });
  rerender(<LaunchAssignmentControls {...props} editable={false} />);
  expect(screen.queryByRole('button', { name: 'Assign ad account' })).toBeNull();
  expect(launchAssignmentsApi.set).not.toHaveBeenCalled();
});
it('shows authoritative current assignment counts and an unknown state without claiming free', async () => {
  const accounts = launchFixtureAccounts();
  accounts[0].agents[0].availability = { status: 'busy', assignmentCount: 2, legacyCount: 0 };
  accounts[1].agents[0].availability = { status: 'unknown', assignmentCount: 0, legacyCount: 1 };
  render(
    <LaunchAssignmentControls
      teamId="team"
      launchId="launch"
      sourceAgentRowId={first}
      accounts={accounts}
      editable
      hasResults={false}
    />
  );
  const user = userEvent.setup();
  await screen.findByText('No current assignment');
  expect(screen.getByText('Current launch assignments: 2')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /^Choose account/ }));
  await user.type(screen.getByRole('textbox', { name: 'Social name or account ID' }), '9876543');
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('Availability unconfirmed')).toBeTruthy();
  expect(within(dialog).queryByText('Free')).toBeNull();
});

it('does not prove a stale receipt visible after another editor changes the assignment', async () => {
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  const { user } = setup();
  await screen.findByText('No current assignment');
  vi.mocked(launchAssignmentsApi.set).mockImplementation(async request => ({
    ...initial,
    state: 'assigned',
    version: '1',
    agentRowId: first,
    operationId: 'op',
    requestKey: request.requestKey
  }));
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'assigned',
    version: '2',
    agentRowId: second
  });
  await user.click(screen.getByRole('button', { name: 'Assign ad account' }));
  await screen.findByText('Assigned to g2 · 892');
  expect(track.mock.calls.some(([event]) => event === 'team_launch_visible')).toBe(false);
});
