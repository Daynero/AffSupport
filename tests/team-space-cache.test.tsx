// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TeamSpace } from '../apps/web/src/team/TeamSpace';
import { makeClient, makeTeam } from './team-space-fixtures';

const STORAGE_KEY = 'wishly.active-team.v1';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function renderSpace(client: ReturnType<typeof makeClient>) {
  return render(
    <TeamProvider realtime={false}>
      <TeamSpace client={client} directAddMode="disabled" />
    </TeamProvider>
  );
}

describe('team space entered-selection cache', () => {
  it('opens the workspace directly when a valid selection is cached (no lobby)', async () => {
    const team = makeTeam();
    localStorage.setItem(STORAGE_KEY, team.id);
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([team]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Media buyers' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Choose a space' })).toBeNull();
  });

  it('falls back to the lobby and clears an invalid cached selection', async () => {
    localStorage.setItem(STORAGE_KEY, '20000000-0000-4000-8000-0000000000ff');
    const client = makeClient({ listTeams: vi.fn().mockResolvedValue([makeTeam()]) });
    renderSpace(client);

    expect(await screen.findByRole('heading', { name: 'Choose a space' })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
  });
});
