// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const STORAGE_KEY = 'wishly.active-team.v1';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderEnteredSpace(client: ReturnType<typeof makeClient>, teamId: string) {
  localStorage.setItem(STORAGE_KEY, teamId);
  return render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('space settings surface', () => {
  it('exposes every 001 capability behind settings for an owner (<= 2 actions)', async () => {
    const team = makeTeam();
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    await screen.findByRole('heading', { name: 'Media buyers' });
    // Action 1 (entering the space) is the cached open; action 2 opens settings.
    await user.click(screen.getByRole('button', { name: 'Space settings' }));

    expect(await screen.findByRole('heading', { name: 'Google Drive storage' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Team audit history' })).toBeTruthy();
  });

  it('hides owner-only controls from a viewer', async () => {
    const team = makeTeam({
      role: 'viewer',
      permissions: DEFAULT_ROLE_PERMISSIONS.viewer
    });
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    const user = userEvent.setup();
    renderEnteredSpace(client, team.id);

    await screen.findByRole('heading', { name: 'Media buyers' });
    await user.click(screen.getByRole('button', { name: 'Space settings' }));
    await screen.findByRole('heading', { name: 'Space settings' });

    // Drive connection (owner) and audit (owner/admin) are not shown to a viewer.
    expect(screen.queryByRole('heading', { name: 'Google Drive storage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team audit history' })).toBeNull();
  });
});
