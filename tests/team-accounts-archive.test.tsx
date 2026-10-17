// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type TeamAccountSummary } from '@video-compressor/shared';
import { AccountSpace, type AccountSpaceClient } from '../apps/web/src/team/accounts';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamApiError } from '../apps/web/src/api/team';
import { analytics } from '../apps/web/src/analytics/service';

const TEAM = 'a0400000-0000-4000-8000-000000000010';
const SOCIAL = 'a0400000-0000-4000-8000-000000000020';
const account: TeamAccountSummary = {
  id: SOCIAL,
  teamId: TEAM,
  name: 'Historical social',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  archivedAt: null,
  archiveVersion: 0,
  agents: []
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function harness(role: 'editor' | 'viewer', refuse = false) {
  localStorage.setItem('wishly.active-team.v1', TEAM);
  let archived = false;
  let version = 0;
  const client = {
    listAccounts: vi.fn(async (_team: string, state: 'active' | 'archived' | 'all' = 'active') =>
      (state === 'archived' ? archived : !archived)
        ? [
            {
              ...account,
              archivedAt: archived ? '2026-10-17T10:00:00Z' : null,
              archiveVersion: version
            }
          ]
        : []
    ),
    listTaskLabels: vi.fn(async () => []),
    setAccountArchived: vi.fn(async (input: { archived: boolean; expectedVersion: number }) => {
      if (refuse) throw new TeamApiError('ACTIVE_LAUNCH', false);
      if (input.expectedVersion !== version)
        return {
          status: 'conflict' as const,
          version,
          archivedAt: archived ? '2026-10-17T10:00:00Z' : null
        };
      archived = input.archived;
      version++;
      return {
        status: 'applied' as const,
        version,
        archivedAt: archived ? '2026-10-17T10:00:00Z' : null
      };
    })
  } as unknown as AccountSpaceClient;
  render(
    <ToastProvider>
      <TeamProvider
        initialTeams={[
          {
            id: TEAM,
            name: 'Archive team',
            role,
            permissions: DEFAULT_ROLE_PERMISSIONS[role],
            connectionState: 'connected' as const
          }
        ]}
        realtime={false}
      >
        <AccountSpace teamId={TEAM} client={client} />
      </TeamProvider>
    </ToastProvider>
  );
  return client;
}

describe('account archive', () => {
  it('archives, searches and restores a social without losing its identity', async () => {
    const user = userEvent.setup();
    const tracked = vi.spyOn(analytics, 'track');
    const client = harness('editor');
    await user.click(
      await screen.findByRole('button', { name: 'Archive account: Historical social' })
    );
    await waitFor(() => expect(client.setAccountArchived).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(await screen.findByText('Historical social')).toBeTruthy();
    await user.type(screen.getByPlaceholderText('Search archived accounts'), 'missing');
    expect(screen.queryByText('Historical social')).toBeNull();
    expect(screen.getByText('No archived accounts match this search.')).toBeTruthy();
    await user.clear(screen.getByPlaceholderText('Search archived accounts'));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.setAccountArchived).toHaveBeenCalledTimes(2));
    expect(
      tracked.mock.calls.some(
        ([event, props]) =>
          event === 'team_workflow_started' && (props as { action?: string }).action === 'archive'
      )
    ).toBe(true);
    expect(
      tracked.mock.calls.some(
        ([event, props]) =>
          event === 'team_workflow_completed' &&
          (props as { action?: string }).action === 'restore' &&
          (props as { production_completed?: boolean }).production_completed === true
      )
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Ad accounts and runs' }));
    expect(await screen.findByText('Historical social')).toBeTruthy();
  });

  it('explains active-launch refusal and does not offer archive to a viewer', async () => {
    const user = userEvent.setup();
    const tracked = vi.spyOn(analytics, 'track');
    harness('editor', true);
    await user.click(
      await screen.findByRole('button', { name: 'Archive account: Historical social' })
    );
    expect(
      await screen.findByText(
        'Finish or archive its active launches before archiving this account.'
      )
    ).toBeTruthy();
    expect(
      tracked.mock.calls.some(
        ([event, props]) =>
          event === 'team_workflow_completed' &&
          (props as { archive_reason?: string }).archive_reason === 'active_launch' &&
          (props as { production_completed?: boolean }).production_completed === false
      )
    ).toBe(true);
    expect(screen.getByText('Historical social')).toBeTruthy();
    cleanup();
    harness('viewer');
    await screen.findByText('Historical social');
    expect(screen.queryByRole('button', { name: 'Archive account: Historical social' })).toBeNull();
  });
});
