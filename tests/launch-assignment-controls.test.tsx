// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LaunchAssignmentControls } from '../apps/web/src/team/launches/LaunchAssignmentControls';
import {
  LAUNCH_ASSIGNMENTS_CHANGED_EVENT,
  launchAssignmentsApi
} from '../apps/web/src/api/team-launch-assignments';
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
it('only assigns the selected RK after an explicit toggle, independently of saved results', async () => {
  const { user, rerender, props } = setup();
  const toggle = await screen.findByRole('switch', { name: 'Assign ad account' });
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
  await user.click(toggle);
  expect(launchAssignmentsApi.set).toHaveBeenCalledWith(
    expect.objectContaining({ agentRowId: second, expectedVersion: '0' })
  );
  expect(toggle).toHaveProperty('checked', true);
  expect(screen.queryByRole('button', { name: /Choose account/ })).toBeNull();
  expect(screen.queryByText(/Existing results/)).toBeNull();
});
it('releases only on explicit toggle and records confirmed visibility', async () => {
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'assigned',
    agentRowId: first
  });
  const track = vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  const { user, confirmed } = setup();
  const toggle = await screen.findByRole('switch', { name: 'Assign ad account' });
  await vi.waitFor(() => expect(toggle).toHaveProperty('checked', true));
  vi.mocked(launchAssignmentsApi.set).mockImplementation(async request => ({
    ...initial,
    state: 'released',
    version: '1',
    agentRowId: null,
    operationId: 'op',
    requestKey: request.requestKey
  }));
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue({
    ...initial,
    state: 'released',
    version: '1',
    agentRowId: null
  });
  await user.click(toggle);
  expect(launchAssignmentsApi.set).toHaveBeenCalledWith(
    expect.objectContaining({ agentRowId: null })
  );
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(track).toHaveBeenCalledWith(
    'team_launch_visible',
    expect.objectContaining({ launch_action: 'release_account' })
  );
});
it('retains the exact uncertain intent when selection changes', async () => {
  vi.mocked(launchAssignmentsApi.set).mockRejectedValue(
    new TeamApiError('LAUNCH_RESULT_UNCERTAIN', true)
  );
  vi.mocked(launchAssignmentsApi.readMutation).mockResolvedValue(null);
  const { user, props, rerender } = setup();
  const toggle = await screen.findByRole('switch', { name: 'Assign ad account' });
  await vi.waitFor(() => expect(toggle).toHaveProperty('disabled', false));
  await user.click(toggle);
  await screen.findByRole('alert');
  const intent = vi.mocked(launchAssignmentsApi.set).mock.calls[0][0];
  rerender(<LaunchAssignmentControls {...props} sourceAgentRowId={second} />);
  await user.click(screen.getByRole('button', { name: 'Check saved assignment' }));
  await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Repeat' }));
  expect(vi.mocked(launchAssignmentsApi.set).mock.calls[1][0]).toEqual(intent);
});
it('keeps failed reads and lost edit authority from making assignment writes', async () => {
  vi.mocked(launchAssignmentsApi.read).mockRejectedValue(new Error('offline'));
  const { rerender, props } = setup();
  await screen.findByRole('alert');
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  rerender(<LaunchAssignmentControls {...props} editable={false} />);
  expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
  expect(launchAssignmentsApi.set).not.toHaveBeenCalled();
});
it('neither shifts the form nor flickers while it saves and rereads', async () => {
  // Beta 2026-11-09: a status line appeared under the switch while saving (the form jumped),
  // and every reread reset it to an empty, disabled switch (it blinked).
  const { user, container } = setup();
  const toggle = await screen.findByRole('switch', { name: 'Assign ad account' });
  let finish!: (value: Awaited<ReturnType<typeof launchAssignmentsApi.set>>) => void;
  vi.mocked(launchAssignmentsApi.set).mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const before = container.innerHTML.length;
  await user.click(toggle);
  // Saving: the switch already shows the target and the status is announced, not laid out.
  expect(toggle).toHaveProperty('checked', true);
  expect(screen.getByRole('status').className).toContain('sr-only');
  expect(container.querySelectorAll('.text-caption').length).toBe(0);
  const assigned = { ...initial, state: 'assigned' as const, version: '1', agentRowId: first };
  vi.mocked(launchAssignmentsApi.read).mockResolvedValue(assigned);
  finish({ ...assigned, requestKey: 'k', operationId: 'o' } as never);
  await vi.waitFor(() => expect(toggle).toHaveProperty('disabled', false));
  expect(toggle).toHaveProperty('checked', true);
  // A reread of the same launch keeps the shown value instead of an empty disabled switch.
  let reread!: (value: typeof assigned) => void;
  vi.mocked(launchAssignmentsApi.read).mockClear();
  vi.mocked(launchAssignmentsApi.read).mockImplementation(
    () =>
      new Promise(resolve => {
        reread = resolve;
      })
  );
  window.dispatchEvent(
    new CustomEvent(LAUNCH_ASSIGNMENTS_CHANGED_EVENT, { detail: { teamId: 'team' } })
  );
  await vi.waitFor(() => expect(launchAssignmentsApi.read).toHaveBeenCalled());
  expect(toggle).toHaveProperty('checked', true);
  expect(toggle).toHaveProperty('disabled', false);
  reread(assigned);
  expect(before).toBeGreaterThan(0);
});
